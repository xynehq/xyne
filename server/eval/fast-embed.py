from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
import multiprocessing
import time
from typing import List, Iterator, Tuple
import numpy as np
from fastembed import TextEmbedding
import json
import os
import argparse
from tqdm import tqdm
import math

# Initialize the model outside the function to avoid reloading
embedding_model = TextEmbedding(
    model_name="BAAI/bge-base-en-v1.5",
    providers=["CUDAExecutionProvider"]
)

print(embedding_model.model.model.get_providers())
# SCHEMA = 'file'
# NAMESPACE = 'namespace'

# def process_chunk(chunk_data: List[Tuple[str, str]]) -> List[dict]:
#     """Process a smaller chunk of documents and return their embeddings"""
#     all_chunks = []
#     document_chunks_map = {}
    
#     # Extract chunks from documents
#     for doc_id, content in chunk_data:
#         chunks = content.strip().split('\n\n')
#         document_chunks_map[doc_id] = chunks
#         all_chunks.extend(chunks)
    
#     # Get embeddings for all chunks in this mini-batch
#     chunk_embeddings = list(embedding_model.embed(all_chunks))
    
#     # Process results
#     processed_docs = []
#     embedding_index = 0
    
#     for doc_id, content in chunk_data:
#         chunks = document_chunks_map[doc_id]
        
#         output_dict = {
#             "put": f"id:{NAMESPACE}:{SCHEMA}::{doc_id}",
#             "fields": {
#                 "docId": doc_id,
#                 "title": content[0:20],
#                 "url": "https://example.com/vespa-hybrid-search",
#                 "chunks": chunks,
#                 "permissions": ["junaid.s@xynehq.com"],
#                 "chunk_embeddings": {
#                     j: chunk_embeddings[embedding_index + j].tolist()
#                     for j in range(len(chunks))
#                 }
#             }
#         }
#         embedding_index += len(chunks)
#         processed_docs.append(output_dict)
    
#     return processed_docs

# def batch_generator(file_path: str, batch_size: int) -> Iterator[List[Tuple[str, str]]]:
#     """Generate batches of documents from the input file"""
#     current_batch = []
#     with open(file_path, encoding='utf-8') as f:
#         for line in f:
#             if len(current_batch) >= batch_size:
#                 yield current_batch
#                 current_batch = []
            
#             doc_id, content = line.strip().split('\t')
#             current_batch.append((doc_id, content))
        
#         if current_batch:  # Don't forget the last batch
#             yield current_batch

# def write_batch_to_file(docs: List[dict], output_path: str):
#     """Write a batch of documents to a JSON file"""
#     with open(output_path, 'w', encoding='utf-8') as output_file:
#         json.dump(docs, output_file, ensure_ascii=False, indent=4)

# def convert_collection(args):
#     """Main function to process the collection with improved memory management"""
#     print('Converting collection...')
    
#     # Calculate optimal chunk size based on available memory and processing power
#     chunk_size = 50  # Process 50 documents at a time
#     docs_per_file = args.max_docs_per_file
    
#     # Initialize counters
#     total_docs_processed = 0
#     current_file_docs = []
#     file_counter = 0
    
#     # Create a process pool for parallel processing
#     with ProcessPoolExecutor(max_workers=args.num_threads) as executor:
#         # Process documents in batches
#         for batch in batch_generator(args.collection_path, chunk_size):
#             start_time = time.time()
            
#             # Submit the chunk for processing
#             future = executor.submit(process_chunk, batch)
            
#             try:
#                 processed_docs = future.result()
#                 current_file_docs.extend(processed_docs)
#                 total_docs_processed += len(processed_docs)
                
#                 # Write to file when we reach the desired documents per file
#                 if len(current_file_docs) >= docs_per_file:
#                     output_path = os.path.join(args.output_folder, f'docs{file_counter:04d}.json')
#                     write_batch_to_file(current_file_docs, output_path)
                    
#                     end_time = time.time()
#                     print(f'Wrote {len(current_file_docs)} documents to {output_path}')
#                     print(f'Time taken: {end_time - start_time:.2f} seconds')
#                     print(f'Total documents processed: {total_docs_processed}')
                    
#                     # Reset for next file
#                     current_file_docs = []
#                     file_counter += 1
                
#             except Exception as e:
#                 print(f'Error processing batch: {e}')
        
#         # Write any remaining documents
#         if current_file_docs:
#             output_path = os.path.join(args.output_folder, f'docs{file_counter:04d}.json')
#             write_batch_to_file(current_file_docs, output_path)
#             print(f'Wrote final {len(current_file_docs)} documents to {output_path}')

# if __name__ == '__main__':
#     parser = argparse.ArgumentParser(
#         description='Convert MSMARCO tsv document collection into json files for Anserini.')
#     parser.add_argument('--collection-path', required=True,
#                         help='Path to MS MARCO tsv collection.')
#     parser.add_argument('--output-folder', required=True,
#                         help='Output folder.')
#     parser.add_argument('--max-docs-per-file', default=1000, type=int,
#                         help='Maximum number of documents in each json file.')
#     parser.add_argument('--num-threads', default=multiprocessing.cpu_count(), type=int,
#                         help='Number of threads to use for processing.')

#     args = parser.parse_args()

#     if not os.path.exists(args.output_folder):
#         os.makedirs(args.output_folder)

#     convert_collection(args)