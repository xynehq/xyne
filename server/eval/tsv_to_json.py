import pandas as pd
import json
import argparse

# Function to remove Unicode characters
def remove_unicode(text):
    return text.encode('ascii', 'ignore').decode('ascii')

def main(collection_tsv, queries_tsv, qrels_tsv, collection_json, queries_json, qrels_json):
    if collection_tsv and collection_json:
        collection_df = pd.read_csv(collection_tsv, delimiter='\t', header=None)
        collection_df.columns = ['doc_id', 'passage']
        collection_df['passage'] = collection_df['passage'].apply(remove_unicode)
        collectionData = collection_df.to_dict(orient='records')
        # Save to JSON file
        with open(collection_json, 'w') as f:
            json.dump(collectionData, f, indent=4)
        print(f"{collection_json} created successfully!")
    
    if queries_tsv and queries_json:
        queries_df = pd.read_csv(queries_tsv, delimiter='\t', header=None)
        queries_df.columns = ['query_id', 'query']
        queriesData = queries_df.to_dict(orient='records')
        # Save to JSON file
        with open(queries_json, 'w') as f:
            json.dump(queriesData, f, indent=4)
        print(f"{queries_json} created successfully!")
    
    if qrels_tsv and qrels_json:
        qrels_df = pd.read_csv(qrels_tsv, delimiter='\t', header=None)
        qrels_df.columns = ['query_id', 'iter', 'doc_id', 'relevance']
        qrelsData = qrels_df.to_dict(orient='records')
        # Save to JSON file
        with open(qrels_json, 'w') as f:
            json.dump(qrelsData, f, indent=4)
        print(f"{qrels_json} created successfully!")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Convert TSV files to JSON")
    parser.add_argument("--collection_tsv", help="Path to the collection.tsv file")
    parser.add_argument("--queries_tsv", help="Path to the queries.tsv file")
    parser.add_argument("--qrels_tsv", help="Path to the qrels.tsv file")
    parser.add_argument("--collection_json", help="Path to save the collection.json file")
    parser.add_argument("--queries_json", help="Path to save the queries.json file")
    parser.add_argument("--qrels_json", help="Path to save the qrels.json file")

    args = parser.parse_args()
    
    main(args.collection_tsv, args.queries_tsv, args.qrels_tsv, args.collection_json, args.queries_json, args.qrels_json)


