import path from "node:path"
const args = process.argv.slice(2)

const expectedArgsLen = 4
const requiredArgs = ["--file", "--output"]
let filePath = "",
  outputPath = ""

if (!args || args.length < expectedArgsLen) {
  throw new Error(
    "path not provided, this script requires --file path/to/file.tsv --output path/to/output/.tsv",
  )
}

const Logger = getLogger(Subsystem.Eval)

const argMap: { [key: string]: string } = {}
args.forEach((arg, idx) => {
  if (requiredArgs.includes(arg)) {
    argMap[arg] = args[idx + 1]
  }
})

filePath = argMap["--file"]
outputPath = argMap["--output"]
if (!filePath || !outputPath) {
  throw new Error("invalid arguments: --file and --output are required")
}

if (path.extname(filePath) !== ".tsv" || path.extname(outputPath) !== ".tsv") {
  throw new Error("file and output must be a .tsv file.")
}

import fs from "node:fs"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
const readline = require("readline")

const modify = async () => {
  const processedResultsData: any[] = []

  try {
    const fileStream = fs.createReadStream(path.resolve(__dirname, filePath))
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    })
    for await (const line of rl) {
      const columns = line.split("\t")
      // if contains header skip
      if (columns[0] === "query-id") continue

      // TREC format for qrels query_id 0 document_id relevance_score
      processedResultsData.push(
        `${columns[0]}\t0\t${columns[1]}\t${columns[2]}`,
      )
    }
    fs.promises.writeFile(outputPath, processedResultsData.join("\n"))
    process.stdout.write("qrels processed successfull")
  } catch (error) {
    Logger.error(
      `Error processing : ${(error as Error).message} \n ${(error as Error).stack}`,
    )
  }
}

await modify()
