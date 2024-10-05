import json
import os
import argparse
from sentence_transformers import SentenceTransformer
from concurrent.futures import ProcessPoolExecutor
from tqdm import tqdm
import math
import multiprocessing
import numpy as np

# Global model variable for each process
model = None

def init_worker():
    """Initialize the model in each worker process"""
    global model
    model = SentenceTransformer('BAAI/bge-small-en-v1.5')

def process_chunk(chunk_data):
    """Process a single chunk of documents"""
    global model
    if model is None:
        model = SentenceTransformer('BAAI/bge-small-en-v1.5')
    
    doc_id, content = chunk_data
    chunks = content.strip().split('\n\n')
    
    # Get embeddings for chunks
    chunk_embeddings = model.encode(chunks, batch_size=500, show_progress_bar=False)
    
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
                for i, embedding in enumerate(chunk_embeddings)
            }
        }
    }
    
    return output_dict

def process_batch(batch_data, num_workers):
    """Process a batch of documents using multiple processes"""
    processed_docs = []
    
    with ProcessPoolExecutor(max_workers=num_workers, initializer=init_worker) as executor:
        # Use tqdm to show progress
        futures = list(tqdm(
            executor.map(process_chunk, batch_data),
            total=len(batch_data),
            desc="Processing documents"
        ))
        processed_docs.extend(futures)
    
    return processed_docs

def write_batch_to_file(batch, output_path):
    """Write a batch of documents to a JSON file"""
    with open(output_path, 'w', encoding='utf-8') as output_file:
        json.dump(batch, output_file, ensure_ascii=False, indent=4)

def convert_collection(args):
    """Main function to process the collection"""
    print('Converting collection...')
    
    # Count total number of documents first
    with open(args.collection_path, encoding='utf-8') as f:
        total_docs = sum(1 for _ in f)
    
    num_batches = math.ceil(total_docs / args.max_docs_per_file)
    print(f"Total documents: {total_docs}")
    print(f"Number of batches: {num_batches}")
    
    # Calculate optimal number of workers based on CPU cores and batch size
    cpu_count = multiprocessing.cpu_count()
    optimal_workers = max(1, min(cpu_count - 1, args.max_docs_per_file // 100))
    print(f"Using {optimal_workers} worker processes")
    
    # Process documents in batches
    with open(args.collection_path, encoding='utf-8') as f:
        for batch_idx in range(num_batches):
            batch_data = []
            remaining_docs = total_docs - (batch_idx * args.max_docs_per_file)
            current_batch_size = min(args.max_docs_per_file, remaining_docs)
            
            # Create a batch of document data
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
                print(f'Wrote {len(processed_docs)} documents to {output_path}')
            except Exception as e:
                print(f'Error processing batch {batch_idx}: {e}')
    
    print('Done!')

if __name__ == '__main__':
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