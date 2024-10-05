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
from queue import Queue
from threading import Thread
import time

# Global variables
model = None

def init_worker():
    """Initialize the model in each worker process"""
    global model
    # Set torch to use single thread per process to prevent over-subscription
    torch.set_num_threads(1)
    model = SentenceTransformer('BAAI/bge-small-en-v1.5')
    model.to('cpu')

class DocumentProcessor:
    def __init__(self, output_folder, docs_per_file=5000):
        self.output_folder = output_folder
        self.docs_per_file = docs_per_file
        self.current_batch = []
        self.total_processed = 0
        self.file_counter = 0
        
    def add_document(self, doc):
        """Add a document to the current batch"""
        if doc is not None:
            self.current_batch.append(doc)
            
        # Write batch if we've reached the target size
        if len(self.current_batch) >= self.docs_per_file:
            self._write_current_batch()
    
    def _write_current_batch(self):
        """Write the current batch to a file"""
        if not self.current_batch:
            return
            
        output_path = os.path.join(self.output_folder, f'docs_{self.file_counter:04d}.json')
        with open(output_path, 'w', encoding='utf-8') as output_file:
            json.dump(self.current_batch, output_file, ensure_ascii=False, indent=4)
            
        print(f'Wrote {len(self.current_batch)} documents to {output_path}')
        self.total_processed += len(self.current_batch)
        self.current_batch = []
        self.file_counter += 1
    
    def finish(self):
        """Write any remaining documents"""
        if self.current_batch:
            self._write_current_batch()
        print(f'Total documents processed: {self.total_processed}')

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

def convert_collection(args):
    """Main function to process the collection"""
    print('Converting collection...')
    
    # Use all available CPU cores
    num_workers = multiprocessing.cpu_count()
    print(f"Using all {num_workers} available CPU cores")
    
    # Create document processor
    doc_processor = DocumentProcessor(args.output_folder, docs_per_file=10000)
    
    # Count total documents
    with open(args.collection_path, encoding='utf-8') as f:
        total_docs = sum(1 for _ in f)
    
    print(f"Total documents to process: {total_docs}")
    
    # Create a queue to hold the results
    result_queue = Queue(maxsize=num_workers * 2)  # Buffer some results
    
    # Create a flag for the writer thread
    processing_complete = False
    
    def writer_thread():
        """Thread to handle writing results to files"""
        while not (processing_complete and result_queue.empty()):
            try:
                result = result_queue.get(timeout=1)  # 1 second timeout
                doc_processor.add_document(result)
            except Exception:
                continue
    
    # Start the writer thread
    writer = Thread(target=writer_thread, daemon=True)
    writer.start()
    
    # Process documents using all cores
    with ProcessPoolExecutor(
        max_workers=num_workers,
        initializer=init_worker,
        mp_context=multiprocessing.get_context('spawn')
    ) as executor:
        # Read and process documents
        with open(args.collection_path, encoding='utf-8') as f:
            # Create batches for submission
            batch_data = []
            futures = []
            
            # Submit initial batch of tasks
            for line in tqdm(f, total=total_docs, desc="Submitting documents"):
                try:
                    doc_id, content = line.split('\t')
                    future = executor.submit(process_chunk, (doc_id, content))
                    futures.append(future)
                except Exception as e:
                    print(f"Error submitting document: {str(e)}")
                    continue
            
            # Process results as they complete
            for future in tqdm(futures, desc="Processing documents"):
                try:
                    result = future.result()
                    result_queue.put(result)
                except Exception as e:
                    print(f"Error getting result: {str(e)}")
    
    # Signal completion and wait for writer to finish
    processing_complete = True
    writer.join()
    
    # Write any remaining documents
    doc_processor.finish()
    
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
    
    args = parser.parse_args()
    
    if not os.path.exists(args.output_folder):
        os.makedirs(args.output_folder)
    
    convert_collection(args)