import * as fs from "fs"
import * as readline from "readline"

interface CleanDataObject {
  put: string
  fields: {
    [key: string]: any
    refs?: any[]
  }
}

interface RefsObject {
  put: {
    id: string
  }
  fields: {
    refs: any[]
    [key: string]: any
  }
}

async function mergeFiles() {
  const cleanDataPath = "server/qa_gen/sample_answers/flipkart_clean_data.json"
  const refsDataPath =
    "server/qa_gen/sample_answers/Scenarios 3/Flipkart Refund_Settelement.jsonl"
  const outputPath = "flipkart_clean_data_with_refs.json"

  // 1. Read the clean data file
  const cleanData: CleanDataObject[] = JSON.parse(
    fs.readFileSync(cleanDataPath, "utf-8"),
  )

  // 2. Create a map of refs from the JSONL file
  const refsMap = new Map<string, any[]>()
  const fileStream = fs.createReadStream(refsDataPath)
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    if (line.trim()) {
      const refsObject: RefsObject = JSON.parse(line)
      if (
        refsObject.put &&
        refsObject.put.id &&
        refsObject.fields &&
        refsObject.fields.refs
      ) {
        refsMap.set(refsObject.put.id, refsObject.fields.refs)
      }
    }
  }

  // 3. Merge the refs into the clean data
  const mergedData = cleanData.map((item) => {
    const refs = refsMap.get(item.put)
    if (refs) {
      item.fields.refs = refs
    }
    return item
  })

  // 4. Write the output file
  fs.writeFileSync(outputPath, JSON.stringify(mergedData, null, 2))

  console.log(`Successfully created ${outputPath}`)
}

mergeFiles()
