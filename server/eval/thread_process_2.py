import json
import os
import argparse
from sentence_transformers import SentenceTransformer
from concurrent.futures import ProcessPoolExecutor
from tqdm import tqdm
import math
import multiprocessing
import numpy as np
import psutil
import torch

# Global variables
model = None
device = None

def init_worker():
    """Initialize the model in each worker process"""
    global model, device
    
    # Set torch to use CPU only for worker processes
    torch.set_num_threads(1)  # Prevent over-subscription
    
    # Initialize the model
    model = SentenceTransformer('BAAI/bge-small-en-v1.5')
    model.to('cpu')  # Explicitly move to CPU

def get_optimal_workers():
    """
    Calculate optimal number of workers based on system resources
    Specifically optimized for EC2 instances
    """
    cpu_count = multiprocessing.cpu_count()
    memory = psutil.virtual_memory()
    
    # Calculate memory per worker (assuming model needs ~2GB)
    memory_per_worker = 2 * 1024 * 1024 * 1024  # 2GB in bytes
    max_workers_by_memory = memory.available // memory_per_worker
    
    # For EC2, we want to leave some headroom for system processes
    if cpu_count >= 32:
        # For large instances (32+ cores), use 50-60% of cores
        optimal_workers = min(cpu_count // 2, max_workers_by_memory)
    else:
        # For smaller instances, use 75% of cores
        optimal_workers = min(int(cpu_count * 0.75), max_workers_by_memory)
    
    return max(1, optimal_workers)

def process_chunk(chunk_data):
    """Process a single chunk of documents"""
    global model
    
    try:
        doc_id, content = chunk_data
        chunks = content.strip().split('\n\n')
        
        # Process in smaller sub-batches to manage memory better
        sub_batch_size = 16
        all_embeddings = []
        
        for i in range(0, len(chunks), sub_batch_size):
            sub_chunks = chunks[i:i + sub_batch_size]
            sub_embeddings = model.encode(
                sub_chunks,
                batch_size=sub_batch_size,
                show_progress_bar=False,
                convert_to_numpy=True
            )
            all_embeddings.extend(sub_embeddings)
        
        # Create output document structure
        output_dict = {
            "put": f"id:namespace:file::{doc_id}",
            "fields": {
                "docId": doc_id,
                "title": content[0:20],
                "url": "https://example.com/vespa-hybrid-search",
                "chunks": chunks,
                "permissions": ["junaid.s@xynehq.com"],
                "chunk_embeddings": {
                    i: embedding.tolist() 
                    for i, embedding in enumerate(all_embeddings)
                }
            }
        }
        
        return output_dict
    
    except Exception as e:
        print(f"Error processing chunk {doc_id}: {str(e)}")
        return None

def process_batch(batch_data, num_workers):
    """Process a batch of documents using multiple processes"""
    processed_docs = []
    
    with ProcessPoolExecutor(
        max_workers=num_workers,
        initializer=init_worker,
        mp_context=multiprocessing.get_context('spawn')
    ) as executor:
        futures = []
        
        # Submit all tasks
        for item in batch_data:
            futures.append(executor.submit(process_chunk, item))
        
        # Process results as they complete
        for future in tqdm(futures, total=len(batch_data), desc="Processing documents"):
            try:
                result = future.result()
                if result is not None:
                    processed_docs.append(result)
            except Exception as e:
                print(f"Error processing document: {str(e)}")
    
    return processed_docs

def write_batch_to_file(batch, output_path):
    """Write a batch of documents to a JSON file"""
    try:
        with open(output_path, 'w', encoding='utf-8') as output_file:
            json.dump(batch, output_file, ensure_ascii=False, indent=4)
    except Exception as e:
        print(f"Error writing batch to file: {str(e)}")
        # Try writing to a backup file
        backup_path = output_path + '.backup'
        with open(backup_path, 'w', encoding='utf-8') as output_file:
            json.dump(batch, output_file, ensure_ascii=False, indent=4)

def convert_collection(args):
    """Main function to process the collection"""
    print('Converting collection...')
    
    # Get optimal number of workers based on system resources
    optimal_workers = get_optimal_workers()
    print(f"Using {optimal_workers} worker processes based on system resources")
    
    # Calculate batch sizes based on available memory
    memory = psutil.virtual_memory()
    total_memory_gb = memory.total / (1024 ** 3)
    
    # Adjust batch size based on available memory
    if total_memory_gb >= 64:
        default_batch_size = 1000
    else:
        default_batch_size = 500
    
    # Count total number of documents
    with open(args.collection_path, encoding='utf-8') as f:
        total_docs = sum(1 for _ in f)
    
    batch_size = min(args.max_docs_per_file, default_batch_size)
    num_batches = math.ceil(total_docs / batch_size)
    
    print(f"Total documents: {total_docs}")
    print(f"Processing in {num_batches} batches of up to {batch_size} documents each")
    
    # Process documents in batches
    with open(args.collection_path, encoding='utf-8') as f:
        for batch_idx in range(num_batches):
            batch_data = []
            remaining_docs = total_docs - (batch_idx * batch_size)
            current_batch_size = min(batch_size, remaining_docs)
            
            # Create batch of document data
            for _ in range(current_batch_size):
                try:
                    line = next(f)
                    doc_id, content = line.split('\t')
                    batch_data.append((doc_id, content))
                except StopIteration:
                    break
            
            print(f'\nProcessing batch {batch_idx + 1}/{num_batches} (size: {len(batch_data)})')
            
            try:
                processed_docs = process_batch(batch_data, optimal_workers)
                output_path = os.path.join(args.output_folder, f'docs{batch_idx:02d}.json')
                write_batch_to_file(processed_docs, output_path)
                print(f'Successfully wrote {len(processed_docs)} documents to {output_path}')
                
                # Clear some memory
                del processed_docs
                torch.cuda.empty_cache() if torch.cuda.is_available() else None
                
            except Exception as e:
                print(f'Error processing batch {batch_idx}: {str(e)}')
    
    print('Processing completed successfully!')

if __name__ == '__main__':
    # Ensure we're using spawn method for process creation
    multiprocessing.set_start_method('spawn', force=True)
    
    parser = argparse.ArgumentParser(
        description='Convert MSMARCO tsv document collection into json files for Anserini.')
    parser.add_argument('--collection-path', required=True,
                        help='Path to MS MARCO tsv collection.')
    parser.add_argument('--output-folder', required=True,
                        help='Output folder.')
    parser.add_argument('--max-docs-per-file', default=1000000, type=int,
                        help='Maximum number of documents in each json file.')
    
    args = parser.parse_args()
    
    if not os.path.exists(args.output_folder):
        os.makedirs(args.output_folder)
    
    convert_collection(args)