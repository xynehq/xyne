

## search evaluation

Currently we can run eval locally for [FiQA](https://sites.google.com/view/fiqa/home) (Financial Question Answering) , [SciFact](https://leaderboard.allenai.org/scifact/submissions/about) and [NFCorpus](https://www.cl.uni-heidelberg.de/statnlpgroup/nfcorpus/) .

The [FiQA](https://sites.google.com/view/fiqa/home) (Financial Question Answering) , [SciFact](https://leaderboard.allenai.org/scifact/submissions/about)  and [NFCorpus](https://www.cl.uni-heidelberg.de/statnlpgroup/nfcorpus/) datasets is a valuable resource for evaluation, This README walks through downloading the datasets, processing it for Vespa, feeding it into the Vespa search engine, and evaluating the results using `pytrec_eval`.

you can easily download the dataset from [BeIR](https://github.com/beir-cellar/beir?tab=readme-ov-file) or just hit the below commands
		

> Note: Ensure you have run `server/vespa/deploy.sh ` to get the schema deployed to vespa.
			
	cd server/eval && wget https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/fiqa.zip -P  data
or
   

     cd server/eval && curl -o data/fiqa.zip https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/fiqa.zip
   _

     unzip data/fiqa.zip -d data

same steps for the SciFact and NFCorpus

     cd server/eval && curl -o data/scifact.zip https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip
_

    cd server/eval && curl -o data/nfcorpus.zip https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/nfcorpus.zip

_

     unzip data/scifact.zip -d data | unzip data/nfcorpus.zip -d data
Before proceeding, we also need to convert the qrels (query relevance) file into TREC format

    bun run qrelsToTrecFormat.ts --file path/to/qrels/.tsv --output path/to/trec_qrels/.tsv

Next, we need to make the documents compatible with Vespa. 

    bun run processDataForVespa.ts --corpus path/to/corpus.jsonl --output path/to/processedData.json
   
once processed it will create a json file at `--output` specified path. The ingesting step can take some time (depending on your machine), as vespa inside generating embeddings for each document chunk. 

    vespa feed -t http://localhost:8080 path/to/processedData.json
   
After all files have been fed into Vespa, you can start the evaluation process by running:
  
    bun run evaluate.ts --queries path/to/queries.jsonl --output path/to/output/.tsv
    
 this will generate  a .tsv file  at `--output` specified path, now

to run the evaluation script you need a `pytrec_eval` python package tobe installed, lets create a virtual environment to run the python scripts. 
to install uv please refer [here](https://github.com/astral-sh/uv)

	uv venv
_
	
    source .venv/bin/activate
   _
   
     uv pip install pytrec_eval

Finally, run the following Python script to calculate the evaluation metrics:

    python trec_eval.py --qrel_file path/to/trec_qrels.tsv --run_file path/to/results/.tsv


This will compute the evaluation scores based on the provided qrels and results file.


___

To run NanoBeir eval

make sure you've venv setup

    uv pip install datasets
  
	python getNanoBeir.py

this is will download all nanoBeir datasets

next remains the same steps as above for each dataset