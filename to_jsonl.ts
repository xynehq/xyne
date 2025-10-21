import * as fs from "fs"

const inputPath = "flipkart_clean_data_with_refs.json"
const outputPath = "flipkart_clean_data_with_refs.jsonl"

const data = JSON.parse(fs.readFileSync(inputPath, "utf-8"))

const jsonlData = data.map((item) => JSON.stringify(item)).join("\n")

fs.writeFileSync(outputPath, jsonlData)

console.log(`Successfully created ${outputPath}`)
