import json
import os
import argparse
from sentence_transformers import SentenceTransformer
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock
from queue import Queue
import math
from tqdm import tqdm

model = SentenceTransformer('BAAI/bge-small-en-v1.5')

SCHEMA = 'file'
NAMESPACE = 'namespace'

# Thread-safe counter for progress tracking
class Counter:
    def __init__(self):
        self.value = 0
        self.lock = Lock()
    
    def increment(self):
        with self.lock:
            self.value += 1
            return self.value

def process_chunk(chunk):
    """Process a single chunk and return its embedding"""
    return model.encode(chunk).tolist()

def process_document(doc_data):
    """Process a single document and return its processed form"""
    id, content = doc_data
    chunks = content.strip().split('\n\n')
    
    output_dict = {
        "put": f"id:{NAMESPACE}:{SCHEMA}::{id}",
        "fields": {
            "docId": id,
            "title": content[0:20],
            "url": "https://example.com/vespa-hybrid-search",
            "chunks": chunks,
            "permissions": ["junaid.s@xynehq.com"],
            "chunk_embeddings": {}
        }
    }
    
    # Process chunks in parallel
    chunk_futures = {}
    with ThreadPoolExecutor(max_workers=3) as executor:  # Limit workers per document to avoid memory issues
        for j, chunk in enumerate(chunks):
            chunk_futures[j] = executor.submit(process_chunk, chunk)
        
        # Collect results
        chunksMap = {}
        for j, future in chunk_futures.items():
            chunksMap[j] = future.result()
    
    output_dict['fields']['chunk_embeddings'] = chunksMap
    return output_dict

def write_batch_to_file(batch, output_path):
    """Write a batch of documents to a JSON file"""
    with open(output_path, 'w', encoding='utf-8') as output_file:
        json.dump(batch, output_file, ensure_ascii=False, indent=4)

def convert_collection(args):
    print('Converting collection...')
    
    # Count total number of documents first
    with open(args.collection_path, encoding='utf-8') as f:
        total_docs = sum(1 for _ in f)
    
    # Calculate number of batches
    num_batches = math.ceil(total_docs / 500)
    
    # Process documents in batches
    with open(args.collection_path, encoding='utf-8') as f:
        for batch_idx in range(num_batches):
            batch_docs = []
            batch_size = min(args.max_docs_per_file, total_docs - batch_idx * args.max_docs_per_file)
            
            # Create a batch of document data
            batch_data = []
            for _ in range(batch_size):
                line = next(f)
                id, content = line.split('\t')
                batch_data.append((id, content))
            
            print(f'\nProcessing batch {batch_idx + 1}/{num_batches}')
            
            # Process documents in parallel
            with ThreadPoolExecutor(max_workers=args.num_threads) as executor:
                # Submit all documents in the batch
                future_to_doc = {executor.submit(process_document, doc_data): doc_data 
                               for doc_data in batch_data}
                
                # Process results as they complete with progress bar
                with tqdm(total=len(future_to_doc), desc="Processing documents") as pbar:
                    for future in as_completed(future_to_doc):
                        try:
                            result = future.result()
                            batch_docs.append(result)
                            pbar.update(1)
                        except Exception as e:
                            print(f'Error processing document: {e}')
            
            # Write batch to file
            output_path = os.path.join(args.output_folder, f'docs{batch_idx:02d}.json')
            write_batch_to_file(batch_docs, output_path)
            print(f'Wrote {len(batch_docs)} documents to {output_path}')

    print('Done!')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description='Convert MSMARCO tsv document collection into json files for Anserini.')
    parser.add_argument('--collection-path', required=True,
                        help='Path to MS MARCO tsv collection.')
    parser.add_argument('--output-folder', required=True,
                        help='Output folder.')
    parser.add_argument('--max-docs-per-file', default=1000, type=int,
                        help='Maximum number of documents in each json file.')
    parser.add_argument('--num-threads', default=12, type=int,
                        help='Number of threads to use for processing.')

    args = parser.parse_args()

    if not os.path.exists(args.output_folder):
        os.makedirs(args.output_folder)

    convert_collection(args)