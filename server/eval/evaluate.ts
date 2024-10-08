import fs from "node:fs";
import path from "node:path";
const transformers = require('@xenova/transformers')
const { env } = transformers
import PQueue from "p-queue";
import { searchVespa } from "@/search/vespa";
const readline = require('readline');
env.backends.onnx.wasm.numThreads = 1;
env.localModelPath = '../'
env.cacheDir = '../'

const processedResultsData: string[] = []
let counts = 0
const evaluate = async (queriesListPath: string) => {
    const k = 10;
    const queue = new PQueue({ concurrency: 15 });

    const processQuery = async ({ query, query_id }: { query: string, query_id: number }) => {
        try {
            const results = await searchVespa(query, "junaid.s@xynehq.com", "", "", k);
            if ("children" in results.root) {
                const hits = results.root.children
                for (let idx = 0; idx < hits.length; idx++) {
                    // TREC format query_id Q0 document_id rank score run_id
                    processedResultsData.push(`${query_id}\tQ0\t${hits[idx].fields.docId}\t${idx + 1}\t${hits[idx].relevance}\trun-1`)
                }
            }
            counts++
            console.log(query, "---->", counts);
        } catch (error) {
            console.log("error searcing vespa", error)
        }
    }

    const fileStream = fs.createReadStream(queriesListPath);
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity // Handle different newline characters
    });
    for await (const line of rl) {
        // const columns = line.split('\t')
        const columns = JSON.parse(line)
        queue.add(() => processQuery({ query_id: columns._id, query: columns.text }));
    }

    await queue.onIdle();

    fs.promises.writeFile('data/output/fiqa_result_qrels.tsv', processedResultsData.join("\n"))
}


evaluate(path.resolve(__dirname, "data/fiqa/queries.jsonl"))
    .then(() => {
        console.log('Evaluation completed');
    })