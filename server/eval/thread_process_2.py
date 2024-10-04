import json
import os
import argparse
from sentence_transformers import SentenceTransformer
from concurrent.futures import ThreadPoolExecutor, as_completed
from tqdm import tqdm
import math
import multiprocessing

# Initialize the model outside the function to avoid reloading
model = SentenceTransformer('BAAI/bge-small-en-v1.5')

SCHEMA = 'file'
NAMESPACE = 'namespace'

def write_batch_to_file(batch, output_path):
    """Write a batch of documents to a JSON file"""
    with open(output_path, 'w', encoding='utf-8') as output_file:
        json.dump(batch, output_file, ensure_ascii=False, indent=4)

def process_documents_in_batch(batch_data):
    """Process a batch of documents and retrieve embeddings for all chunks at once."""
    all_chunks = []
    document_chunks_map = {}

    for doc_data in batch_data:
        doc_id, content = doc_data
        chunks = content.strip().split('\n\n')
        document_chunks_map[doc_id] = chunks
        all_chunks.extend(chunks)  # Collect all chunks for embedding extraction

    # Get embeddings for all chunks at once
    chunk_embeddings = model.encode(all_chunks, batch_size=1000, show_progress_bar=True)

    # Assign embeddings back to respective documents
    processed_docs = []
    embedding_index = 0

    for doc_data in batch_data:
        doc_id, content = doc_data
        chunks = document_chunks_map[doc_id]

        # Create output document structure
        output_dict = {
            "put": f"id:{NAMESPACE}:{SCHEMA}::{doc_id}",
            "fields": {
                "docId": doc_id,
                "title": content[0:20],
                "url": "https://example.com/vespa-hybrid-search",
                "chunks": chunks,
                "permissions": ["junaid.s@xynehq.com"],
                "chunk_embeddings": {}
            }
        }

        # Assign embeddings to chunks
        chunk_embeddings_map = {}
        for j in range(len(chunks)):
            chunk_embeddings_map[j] = chunk_embeddings[embedding_index].tolist()
            embedding_index += 1

        output_dict['fields']['chunk_embeddings'] = chunk_embeddings_map
        processed_docs.append(output_dict)

    return processed_docs

def convert_collection(args):
    """Main function to process the collection"""
    print('Converting collection...')

    # Count total number of documents first
    with open(args.collection_path, encoding='utf-8') as f:
        total_docs = sum(1 for _ in f)

    num_batches = math.ceil(total_docs / args.max_docs_per_file)
    print(f"Total documents: {total_docs}")
    print(f"Number of batches: {num_batches}")

    # Process documents in batches
    with open(args.collection_path, encoding='utf-8') as f:
        for batch_idx in range(num_batches):
            batch_data = []
            # Calculate remaining documents to process
            remaining_docs = total_docs - (batch_idx * args.max_docs_per_file)
            # Use the minimum of max_docs_per_file and remaining documents
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

            # Process batch in parallel using threading
            with ThreadPoolExecutor(max_workers=args.num_threads) as executor:
                futures = [executor.submit(process_documents_in_batch, batch_data)]
                
                for future in as_completed(futures):
                    try:
                        processed_docs = future.result()
                        output_path = os.path.join(args.output_folder, f'docs{batch_idx:02d}.json')
                        write_batch_to_file(processed_docs, output_path)
                        print(f'Wrote {len(processed_docs)} documents to {output_path}')
                    except Exception as e:
                        print(f'Error processing batch {batch_idx}: {e}')

    print('Done!')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description='Convert MSMARCO tsv document collection into json files for Anserini.')
    parser.add_argument('--collection-path', required=True,
                        help='Path to MS MARCO tsv collection.')
    parser.add_argument('--output-folder', required=True,
                        help='Output folder.')
    parser.add_argument('--max-docs-per-file', default=1000000, type=int,
                        help='Maximum number of documents in each json file.')
    parser.add_argument('--num-threads', default=12, type=int,
                        help='Number of threads to use for processing.')

    args = parser.parse_args()

    if not os.path.exists(args.output_folder):
        os.makedirs(args.output_folder)

    convert_collection(args)