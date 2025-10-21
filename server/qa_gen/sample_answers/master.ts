import * as fs from "fs"
import { selector } from "./selector.js"

function filterJsonlData(rawData: string): any[] {
  const lines = rawData.trim().split("\n")
  const filteredRecords: any[] = []

  console.log(`Processing ${lines.length} records for filtering...`)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    try {
      const record = JSON.parse(line)

      // Create a deep copy of the record to avoid modifying the original
      const filteredRecord = JSON.parse(JSON.stringify(record))

      // Remove the specified fields from metadata if they exist
      if (filteredRecord.fields?.metadata) {
        const metadata = filteredRecord.fields.metadata

        // Remove jiraId from externalRefs
        if (metadata.externalRefs?.jiraId) {
          delete metadata.externalRefs.jiraId
        }

        // Remove jiraEpicId from projectMemory
        if (metadata.projectMemory?.jiraEpicId) {
          delete metadata.projectMemory.jiraEpicId
        }

        // Remove jira field
        if (metadata.jira) {
          delete metadata.jira
        }

        // Remove actions field
        if (metadata.actions) {
          delete metadata.actions
        }
      }

      filteredRecords.push(filteredRecord)
    } catch (error) {
      console.error(`Error parsing line ${i + 1}:`, error)
    }
  }

  console.log(`Successfully filtered ${filteredRecords.length} records`)
  return filteredRecords
}

function main() {
  console.log("--- Script started ---")
  const filePath = "./flipkart_clean_data_with_refs.jsonl"
  const n = parseInt(process.argv[2], 10)

  console.log("Input argument n:", n)
  console.log("File path:", filePath)

  if (isNaN(n) || n <= 0) {
    console.error("Please provide a positive integer as argument.")
    process.exit(1)
  }

  // Read the raw JSONL data
  const rawData = fs.readFileSync(filePath, "utf-8")
  console.log("File read successfully. Data length:", rawData.length)

  // Filter the data to extract required metadata fields
  console.log("Filtering data to extract metadata fields...")
  const filteredData = filterJsonlData(rawData)

  // Convert filtered data back to string format for selector
  const filteredDataString = filteredData
    .map((record) => JSON.stringify(record))
    .join("\n")

  const numChunks = n
  console.log("numChunks (number of groups to generate):", numChunks)
  console.log("Calling selector with filtered data...")

  // Pass filtered data to selector
  selector(filteredDataString, numChunks)
  console.log("Selector call finished.")
}

main()
