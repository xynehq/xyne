import path from "node:path"
const args = process.argv.slice(2)

const expectedArgsLen = 4
const requiredArgs = ["--queries", "--output"]
let queriesPath = "",
  outputPath = ""

if (!args || args.length < expectedArgsLen) {
  throw new Error(
    "path not provided, this script requires --queries path/to/queries.jsonl --output path/to/output/.tsv",
  )
}

const argMap: { [key: string]: string } = {}
args.forEach((arg, idx) => {
  if (requiredArgs.includes(arg)) {
    argMap[arg] = args[idx + 1]
  }
})

queriesPath = argMap["--queries"]
outputPath = argMap["--output"]
if (!queriesPath || !outputPath) {
  throw new Error("invalid arguments: --queries and --output are required")
}

if (path.extname(outputPath) !== ".tsv") {
  throw new Error("Output file must be a .tsv file.")
}

import fs from "node:fs"
import PQueue from "p-queue"
import { searchVespa } from "@/search/vespa"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
const readline = require("readline")

const Logger = getLogger(Subsystem.Eval)
const start = performance.now()
const processedResultsData: string[] = []
let counts = 0
const user = "junaid.s@xynehq.com"
const evaluate = async (queriesListPath: string) => {
  const k = 10
  const queue = new PQueue({ concurrency: 10 })

  const processQuery = async ({
    query,
    query_id,
  }: { query: string; query_id: number }) => {
    try {
      const results = await searchVespa(query, user, null, null, { limit: k })
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
    const columns = JSON.parse(line)
    queue.add(() =>
      processQuery({ query_id: columns._id, query: columns.text }),
    )
  }

  await queue.onIdle()

  const output = path.resolve(import.meta.dirname, outputPath)
  fs.promises.writeFile(output, processedResultsData.join("\n"))
}

try {
  evaluate(path.resolve(import.meta.dirname, queriesPath)).then(() => {
    const end = performance.now()
    const timeTaken = (end - start) / 1000
    Logger.info(`Evaluation completed in ${timeTaken.toFixed(2)} seconds`)
  })
} catch (error) {
  console.error(error)
}
