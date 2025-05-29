from beir import util
import os

# List of BEIR datasets you want to download
datasets = [
    "fiqa",
    "scifact",
    "quora",
    "nfcorpus",
    "dbpedia-entity",
    "msmarco",
    "hotpotqa"]

# Base directory where all BEIR datasets will be saved
out_dir = os.path.join(os.getcwd(), "datasets")

# Loop and download
for dataset in datasets:
    print(f"\n📥 Downloading: {dataset}")
    url = f"https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/{dataset}.zip"
    data_path = util.download_and_unzip(url, out_dir)
    print(f"✅ Downloaded and extracted: {data_path}")
