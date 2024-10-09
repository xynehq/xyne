
## search eval using FiQA dataset

The [FiQA](https://sites.google.com/view/fiqa/home) (Financial Question Answering) dataset is a valuable resource for financial questions and answers,  This README walks through downloading the dataset, processing it for Vespa, feeding it into the Vespa search engine, and evaluating the results using `pytrec_eval`.

you can easily download the dataset from [BeIR](https://github.com/beir-cellar/beir?tab=readme-ov-file) or just hit the below commands commands
		
			
	cd server/eval && wget https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/fiqa.zip -P  data
or
   

     cd server/eval && curl -o data/fiqa.zip https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/fiqa.zip
   _

     unzip data/fiqa.zip -d data
    
Before proceeding, we also need to convert the qrels (query relevance) file into TREC format

    bun run qrelsToTrecFormat.ts

Next, we need to make the documents compatible with Vespa. The processing step can take up to 3 hours (depending on your machine), as it involves generating embeddings for each document chunk. for now we are doing this method later on we should generate the embeddings within vespa itself then we should get this indexing fast

    npx tsx processDataForVespa.ts
   
once processed it will generate 6 files 10K docs per file except the last one which contains 7638 docs, now start feeding into vespa (make sure vespa client running)

    vespa feed -t http://localhost:8080 data/output/process_data_1.json
   
After all files have been fed into Vespa, you can start the evaluation process by running:
  
    bun run evaluate.ts
    
 this will generate  a .tsv file  `data/output/fiqa_result_qrels.tsv` , now

to run the evaluation script you need a `pytrec_eval` python package tobe installed, lets create a virtual environment to run the python scripts.

	uv venv
_
	
    source .venv/bin/activate
   _
   
     uv pip install pytrec_eval


Finally, run the following Python script to calculate the evaluation metrics:

    python trec_eval.py
   or

    python trec_eval.py --qrel_file path/to/qrels  --run_file  path/to/result_file
	  

This will compute the evaluation scores based on the provided qrels and results file.
