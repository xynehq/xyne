# fix_qrels_format.py
input_path = "datasets/hotpotqa/qrels/test.tsv"
output_path = "datasets/hotpotqa/qrels/test_fixed.tsv"

with open(input_path, "r") as fin, open(output_path, "w") as fout:
    for line in fin:
        parts = line.strip().split()
        if len(parts) == 3:
            query_id, doc_id, score = parts
            fout.write(f"{query_id} Q0 {doc_id} {score}\n")
