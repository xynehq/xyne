import fs from "node:fs"
import path from "node:path"
import * as transformers from "@xenova/transformers"
import PQueue from "p-queue"
import { searchVespa } from "@/search/vespa"
const { env } = transformers
const readline = require("readline")

// this will share the cache embedding model from /server
env.localModelPath = "../"
env.cacheDir = "../"
env.backends.onnx.wasm.numThreads = 1

const queriesPath = "data/fiqa/queries.jsonl"

const processedResultsData: string[] = []
let counts = 0
const evaluate = async (queriesListPath: string) => {
  const k = 10
  const queue = new PQueue({ concurrency: 15 })

  const processQuery = async ({
    query,
    query_id,
  }: { query: string; query_id: number }) => {
    try {
      const results = await searchVespa(
        query,
        "junaid.s@xynehq.com",
        "",
        "",
        k,
        0,
      )
      if ("children" in results.root) {
        const hits = results.root.children
        for (let idx = 0; idx < hits.length; idx++) {
          // TREC format query_id Q0 document_id rank score run_id
          processedResultsData.push(
            // @ts-ignore
            `${query_id}\tQ0\t${hits[idx]?.fields?.docId}\t${idx + 1}\t${hits[idx].relevance}\trun-1`,
          )
        }
      }
      counts++
      console.log(query, "---->", counts)
    } catch (error) {
      console.log("error searcing vespa", error)
    }
  }

  const fileStream = fs.createReadStream(queriesListPath)
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity, // Handle different newline characters
  })
  for await (const line of rl) {
    // const columns = line.split('\t')
    const columns = JSON.parse(line)
    queue.add(() =>
      processQuery({ query_id: columns._id, query: columns.text }),
    )
  }

  await queue.onIdle()

  const outputPath = path.resolve(
    import.meta.dirname,
    "data/output/fiqa_result_qrels.tsv",
  )
  fs.promises.writeFile(outputPath, processedResultsData.join("\n"))
}

evaluate(path.resolve(import.meta.dirname, queriesPath)).then(() => {
  console.log("Evaluation completed")
})
