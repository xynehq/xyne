import fs from "node:fs";
import path from "node:path";
const transformers = require('@xenova/transformers')
const { env } = transformers
import { getExtractor } from "@/embedding";
import { chunkDocument } from "@/chunks";
import PQueue from "p-queue";
import { searchVespa } from "@/search/vespa";
import type { VespaResponse } from "@/types";
const readline = require('readline');
env.backends.onnx.wasm.numThreads = 1;


const processedResultsData: string[] = []
let counts = 0
const evaluate = async (queriesListPath: string) => {
    const k = 10;
    const queue = new PQueue({ concurrency: 100 });

    const processQuery = async ({ query, query_id }: { query: string, query_id: number }) => {
        console.log(query)
        try {
            const results = await searchVespa(query, "junaid.s@xynehq.com", "", "", k);

            if ("children" in results.root) {
                const hits = results.root.children
                for (let idx = 0; idx < hits.length; idx++) {
                    processedResultsData.push(`${query_id}\t${hits[idx].fields.docId}\t${idx + 1}`)
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
        const columns = line.split('\t')
        queue.add(() => processQuery({ query_id: columns[0], query: columns[1] }));
    }

    await queue.onIdle();

    fs.promises.writeFile('./test_demo.tsv', processedResultsData.join("\n"))
}


evaluate(path.resolve(__dirname, "data/collectionandqueries/queries.dev.small.tsv"))
    .then(() => {
        console.log('Evaluation completed');
    })