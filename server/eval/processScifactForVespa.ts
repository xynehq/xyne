import fs from "node:fs"
import path from "node:path"
import { chunkDocument } from "@/chunks"

const SCHEMA = "file" // Replace with your actual schema name
const NAMESPACE = "namespace"

const corpusPath = path.resolve(
  import.meta.dirname,
  "data/scifact/corpus.jsonl",
)
const user = "junaid.s@xynehq.com"

const processData = () => {
  fs.readFile(corpusPath, "utf8", (err, data) => {
    if (err) {
      console.error(err)
      return
    }

    const rows = data.split("\n")
    let pLines = 0
    const result = rows.map((row) => {
      if (!row) return // Skip empty lines

      const json = JSON.parse(row)
      pLines++
      return processVespaDoc(json)
    })
    console.log(pLines)
    fs.writeFile(
      "data/scifact/scifactCorpus.json",
      JSON.stringify(result, null, 2),
      (err) => {
        if (err) {
          console.error("Error writing file", err)
        } else {
          console.log("Successfully wrote file")
        }
      },
    )
  })
}

const processVespaDoc = (data: any) => {
  const chunks = chunkDocument(data.text)
  return {
    put: `id:${NAMESPACE}:${SCHEMA}::${data._id}`,
    fields: {
      docId: data._id,
      title: data.title,
      url: "https://example.com/vespa-hybrid-search",
      // Clean up the ASCII characters
      chunks: chunks.map((v) => v.chunk.replace(/[\x00-\x1F\x7F]/g, "")),
      permissions: [user],
    },
  }
}

processData()
process.exit(0)
