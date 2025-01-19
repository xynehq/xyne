import os
from datasets import load_dataset

# nanoBeir datasets
datasets = [
    "NanoClimateFEVER",
    "NanoDBPedia",
    "NanoFEVER",
    "NanoFiQA2018",
    "NanoHotpotQA",
    "NanoMSMARCO",
    "NanoNFCorpus",
    "NanoNQ",
    "NanoQuoraRetrieval",
    "NanoSCIDOCS",
    "NanoArguAna",
    "NanoSciFact",
    "NanoTouche2020"
]

for d in datasets:
    # Create dataset-specific folder
    datasetFolder = f"data/nanoBeir/{d}"
    os.makedirs(datasetFolder, exist_ok=True)
    
    dataset = load_dataset(f"zeta-alpha-ai/{d}", "corpus")
    queries = load_dataset(f"zeta-alpha-ai/{d}", "queries")
    qrels = load_dataset(f"zeta-alpha-ai/{d}", "qrels")
    
    for split in dataset:
        corpus_file = f"{datasetFolder}/corpus.jsonl"
        dataset[split].to_json(corpus_file, orient="records", lines=True)
        print(f"Exported {datasetFolder} corpus to {corpus_file}")
        
        # Save queries as JSONL
        queries_file = f"{datasetFolder}/queries.jsonl"
        queries[split].to_json(queries_file, orient="records", lines=True)
        print(f"Exported {datasetFolder} queries to {queries_file}")
        
        qrels_data = qrels[split]
        
        # Prepare TSV content to trec format
        tsv_content = []
        for item in qrels_data:
            query_id = item['query-id']
            doc_id = item['corpus-id']
            tsv_line = f"{query_id}\t0\t{doc_id}\t1"
            tsv_content.append(tsv_line)
        
        qrels_file = f"{datasetFolder}/qrels.tsv"
        with open(qrels_file, 'w') as f:
            f.write('\n'.join(tsv_content))
        print(f"Exported {datasetFolder} qrels to {qrels_file}")