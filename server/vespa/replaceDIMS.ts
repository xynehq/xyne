import * as fs from "fs"
import * as path from "path"

const args = process.argv.slice(2)

if (!args.length) {
  throw new Error(
    "Model dimensions are missing. Please provide the model dimensions as an argument.",
  )
}

if (Number.isNaN(parseInt(args[0]))) {
  throw new Error("invalid dimensions")
}

const replaceDimensions = (filePath: string, modelDimension: number): void => {
  try {
    const schemaContent = fs.readFileSync(filePath, "utf8")
    const replacedContent = schemaContent.replace(
      /v\[(?:DIMS|\d+)\]/g,
      `v[${modelDimension.toString()}]`,
    )

    // Write the modified content to the output file
    fs.writeFileSync(filePath, replacedContent, "utf8")
  } catch (error) {
    console.error("Error processing Vespa schema file:", error)
    process.exit(1)
  }
}

const replaceModelDIMS = (
  filePaths: Array<string>,
  modelDimension: number,
): void => {
  filePaths.forEach((p) => {
    try {
      replaceDimensions(p, modelDimension)
    } catch (error) {
      console.error(`Failed to process ${p}:`, error)
    }
  })
}

const getSchemaDefinitionPaths = (directory: string) => {
  return fs
    .readdirSync(directory)
    .filter((file) => path.extname(file) === ".sd")
    .map((file) => path.join(directory, file))
}

const paths = getSchemaDefinitionPaths("./schemas")

replaceModelDIMS(paths, parseInt(args[0]))
