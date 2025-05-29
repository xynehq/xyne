# fix_qrels_header.py
infile = "datasets/hotpotqa/qrels/test_fixed.tsv"
outfile = "datasets/hotpotqa/qrels/test_fixed_clean.tsv"

with open(infile, "r") as fin, open(outfile, "w") as fout:
    lines = fin.readlines()
    # Skip first line (header)
    fout.writelines(lines[1:])

print("✅ Header removed → saved as test_fixed_clean.tsv")
