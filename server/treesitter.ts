import * as fs from "fs"
import * as path from "path"
import crypto from "crypto"
import Parser from "tree-sitter"
import type { SyntaxNode } from "tree-sitter"
import { insert } from "@/search/vespa"
import { Apps, codeRustSchema } from "@/search/types"
import pLimit from "p-limit"

const hashFilePath = (filePath: string): string => {
  return crypto.createHash("sha256").update(filePath).digest("hex")
}

class RustCodeExtractor {
  private parser: Parser
  private languageLoaded: boolean = false

  constructor() {
    this.parser = new Parser()
    this.loadRustLanguage().catch((err) => {
      console.error("Initial language load failed:", err)
    })
  }

  private async loadRustLanguage() {
    if (this.languageLoaded) return
    try {
      const Rust = await import("tree-sitter-rust")
      this.parser.setLanguage((Rust.default || Rust) as any)
      this.languageLoaded = true
    } catch (error) {
      console.error("Failed to load tree-sitter-rust:", error)
      this.languageLoaded = false
      throw new Error("Unable to load Rust language for Tree-sitter")
    }
  }

  private async ensureLanguageLoaded() {
    if (!this.languageLoaded) {
      await this.loadRustLanguage()
    }
    if (!this.languageLoaded) {
      throw new Error("Rust language could not be loaded.")
    }
  }

  private getNodeText(sourceCode: string, node: SyntaxNode): string {
    return sourceCode.substring(node.startIndex, node.endIndex)
  }

  private extractAllDataFromTree(
    sourceCode: string,
    rootNode: SyntaxNode,
  ): {
    symbolNames: string[]
    codeChunkKinds: string[]
    codeChunkNames: string[]
    codeChunkContents: string[]
    codeChunkStartLines: number[]
    codeChunkEndLines: number[]
    docCommentsTexts: string[]
    docCommentsTargets: string[]
    docCommentsStartLines: number[]
    dependenciesNames: string[]
    dependenciesFullPaths: string[]
    dependenciesLines: number[]
    featureFlags: string[]
  } {
    const symbolSet = new Set<string>()
    const kinds: string[] = []
    const names: string[] = []
    const contents: string[] = []
    const startLines: number[] = []
    const endLines: number[] = []
    const docTexts: string[] = []
    const docTargets: string[] = []
    const docStartLines: number[] = []
    const depNames: string[] = []
    const depFullPaths: string[] = []
    const depLines: number[] = []
    const features: string[] = []
    const docLines: Record<number, string> = {}

    const itemTypes = [
      "function_item",
      "struct_item",
      "enum_item",
      "trait_item",
      "impl_item",
      "type_item",
      "const_item",
      "static_item",
      "macro_definition",
      "mod_item",
    ]

    const traverse = (node: SyntaxNode) => {
      let nameNode: SyntaxNode | null = null

      if (itemTypes.includes(node.type)) {
        nameNode =
          node.childForFieldName("name") || node.childForFieldName("identifier")
        const typeNode = node.childForFieldName("type")
        let chunkName = "unknown"

        if (nameNode) {
          chunkName = this.getNodeText(sourceCode, nameNode)
          if (node.type !== "impl_item") {
            symbolSet.add(chunkName)
          }
        } else if (typeNode && node.type === "impl_item") {
          chunkName = `impl_${this.getNodeText(sourceCode, typeNode)}`
        } else if (node.type === "mod_item" && !nameNode) {
          const identifier = node.children.find((c) => c.type === "identifier")
          if (identifier) {
            chunkName = this.getNodeText(sourceCode, identifier)
            symbolSet.add(chunkName)
          }
        }

        if (itemTypes.includes(node.type)) {
          kinds.push(node.type.replace("_item", ""))
          names.push(chunkName)
          contents.push(this.getNodeText(sourceCode, node))
          startLines.push(node.startPosition.row)
          endLines.push(node.endPosition.row)
        }
      }

      if (node.type === "line_comment") {
        const text = this.getNodeText(sourceCode, node)
        if (text.trim().startsWith("///")) {
          docLines[node.startPosition.row] = text.trim().substring(3).trim()
        }
      } else if (node.type === "block_comment") {
        const text = this.getNodeText(sourceCode, node)
        if (text.trim().startsWith("/**")) {
          const cleanedText = text
            .trim()
            .replace(/^\/\*\*/, "")
            .replace(/\*\/$/, "")
            .trim()
          docTexts.push(cleanedText)
          docTargets.push("unknown")
          docStartLines.push(node.startPosition.row)
        }
      }

      if (node.type === "use_declaration") {
        const treeNode = node.childForFieldName("tree")
        if (treeNode) {
          const path = this.getNodeText(sourceCode, treeNode)
          const pathParts = path.split("::")
          const mainDep = pathParts[0].trim()
          if (mainDep) {
            depNames.push(mainDep)
            depFullPaths.push(path)
            depLines.push(node.startPosition.row)
          }
        }
      } else if (node.type === "extern_crate_declaration") {
        nameNode = node.childForFieldName("name")
        if (nameNode) {
          const name = this.getNodeText(sourceCode, nameNode)
          depNames.push(name)
          depFullPaths.push(name)
          depLines.push(node.startPosition.row)
        }
      }

      if (node.type === "attribute_item") {
        const text = this.getNodeText(sourceCode, node)
        const featureMatch = text.match(/#\[cfg\(feature\s*=\s*"([^"]+)"\)\]/)
        if (featureMatch) {
          features.push(featureMatch[1])
        }
      }

      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)
        if (child) {
          traverse(child)
        }
      }
    }

    traverse(rootNode)

    let currentComment = ""
    let currentLine = -1
    const lineNumbers = Object.keys(docLines)
      .map(Number)
      .sort((a, b) => a - b)

    for (const lineNum of lineNumbers) {
      if (currentLine === -1 || lineNum === currentLine + 1) {
        if (currentComment) currentComment += "\n"
        currentComment += docLines[lineNum]
        currentLine = lineNum
      } else {
        if (currentComment) {
          docTexts.push(currentComment)
          docTargets.push("unknown")
          docStartLines.push(
            currentLine - currentComment.split("\n").length + 1,
          )
        }
        currentComment = docLines[lineNum]
        currentLine = lineNum
      }
    }
    if (currentComment) {
      docTexts.push(currentComment)
      docTargets.push("unknown")
      docStartLines.push(currentLine - currentComment.split("\n").length + 1)
    }

    return {
      symbolNames: Array.from(symbolSet),
      codeChunkKinds: kinds,
      codeChunkNames: names,
      codeChunkContents: contents,
      codeChunkStartLines: startLines,
      codeChunkEndLines: endLines,
      docCommentsTexts: docTexts,
      docCommentsTargets: docTargets,
      docCommentsStartLines: docStartLines,
      dependenciesNames: depNames,
      dependenciesFullPaths: depFullPaths,
      dependenciesLines: depLines,
      featureFlags: features,
    }
  }

  public async extract(filePath: string): Promise<any> {
    try {
      await this.ensureLanguageLoaded()
      const sourceCode = await fs.promises.readFile(filePath, "utf-8")
      const tree = this.parser.parse(sourceCode)
      const rootNode = tree.rootNode
      const extractedData = this.extractAllDataFromTree(sourceCode, rootNode)

      const docId = hashFilePath(filePath)
      const vespaDoc = {
        docId: docId,
        filename: path.basename(filePath),
        path: filePath,
        app: Apps.Code,
        entity: "rust",
        raw_content: sourceCode,
        symbol_names: extractedData.symbolNames,
        code_chunk_kinds: extractedData.codeChunkKinds,
        code_chunk_names: extractedData.codeChunkNames,
        code_chunk_contents: extractedData.codeChunkContents,
        code_chunk_start_lines: extractedData.codeChunkStartLines,
        code_chunk_end_lines: extractedData.codeChunkEndLines,
        doc_comments_texts: extractedData.docCommentsTexts,
        doc_comments_targets: extractedData.docCommentsTargets,
        doc_comments_start_lines: extractedData.docCommentsStartLines,
        dependencies_names: extractedData.dependenciesNames,
        dependencies_full_paths: extractedData.dependenciesFullPaths,
        dependencies_lines: extractedData.dependenciesLines,
        feature_flags: extractedData.featureFlags,
      }

      return vespaDoc
    } catch (error) {
      console.error(`Error extracting data from ${filePath}:`, error)
      throw error
    }
  }

  public toVespaDocument(extractedData: any): string {
    return JSON.stringify(extractedData, null, 2)
  }
}

async function processRustFile(filePath: string, extractor: RustCodeExtractor) {
  try {
    const extractedData = await extractor.extract(filePath)
    await insert(extractedData, codeRustSchema)

    return {
      status: "success",
      stats: {
        symbols: extractedData.symbol_names.length,
        chunks: extractedData.code_chunk_names.length,
        docComments: extractedData.doc_comments_texts.length,
        dependencies: extractedData.dependencies_names.length,
        featureFlags: extractedData.feature_flags.length,
      },
    }
  } catch (error: any) {
    if (!String(error).includes("Error extracting data")) {
      console.error(
        `Error processing ${path.basename(filePath)} (post-extraction): ${error.message || error}`,
      )
    }
    return {
      status: "error",
      error: error?.toString(),
    }
  }
}

async function processRustRepository(repoPath: string) {
  const extractor = new RustCodeExtractor()
  try {
    await extractor.ensureLanguageLoaded()
  } catch (err) {
    console.error("Failed to initialize language parser. Aborting.", err)
    return
  }

  let totalStats = {
    filesProcessed: 0,
    filesFailed: 0,
    symbols: 0,
    chunks: 0,
    docComments: 0,
    dependencies: 0,
    featureFlags: 0,
  }

  async function findRustFiles(dir: string): Promise<string[]> {
    let rustFiles: string[] = []
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (
            ["target", "node_modules", ".git"].includes(entry.name) ||
            entry.name.startsWith(".")
          ) {
            continue
          }
          try {
            rustFiles = rustFiles.concat(await findRustFiles(fullPath))
          } catch (readDirError: any) {
            console.warn(
              `Skipping directory ${fullPath}: ${readDirError.message}`,
            )
          }
        } else if (entry.isFile() && entry.name.endsWith(".rs")) {
          rustFiles.push(fullPath)
        }
      }
    } catch (err: any) {
      console.error(`Error reading directory ${dir}: ${err.message}`)
      return rustFiles
    }
    return rustFiles
  }

  try {
    const concurrency = 10
    console.log(`Scanning repository at ${repoPath}...`)
    const rustFiles = await findRustFiles(repoPath)

    const totalFiles = rustFiles.length
    if (totalFiles === 0) {
      console.log("No Rust files found to process.")
      return totalStats
    }

    console.log(
      `Found ${totalFiles} Rust files to process. Processing with concurrency limit of ${concurrency}...`,
    )

    const limit = pLimit(concurrency)
    let processedCount = 0
    let failedCount = 0
    const startTime = Date.now()
    let progressInterval: NodeJS.Timer | null = null

    progressInterval = setInterval(() => {
      const elapsedTimeSeconds = (Date.now() - startTime) / 1000
      const rate =
        elapsedTimeSeconds > 0 ? processedCount / elapsedTimeSeconds : 0
      const percentage =
        totalFiles > 0 ? (processedCount / totalFiles) * 100 : 0
      process.stdout.write(
        `Progress: ${percentage.toFixed(1)}% (${processedCount}/${totalFiles}) - Rate: ${rate.toFixed(1)} files/sec\r`,
      )
    }, 4000)

    const promises = rustFiles.map((filePath) =>
      limit(async () => {
        const result = await processRustFile(filePath, extractor)
        processedCount++
        if (result?.status !== "success") {
          failedCount++
        }
        return result
      }),
    )

    const results = await Promise.allSettled(promises)

    if (progressInterval) {
      clearInterval(progressInterval)
    }
    const finalElapsedTimeSeconds = (Date.now() - startTime) / 1000
    const finalRate =
      finalElapsedTimeSeconds > 0 ? totalFiles / finalElapsedTimeSeconds : 0
    process.stdout.write(
      `Progress: 100.0% (${totalFiles}/${totalFiles}) - Final Rate: ${finalRate.toFixed(1)} files/sec\n`,
    )

    results.forEach((result, index) => {
      if (
        result.status === "fulfilled" &&
        result.value?.status === "success" &&
        result.value.stats
      ) {
        totalStats.filesProcessed += 1
        totalStats.symbols += result.value.stats.symbols
        totalStats.chunks += result.value.stats.chunks
        totalStats.docComments += result.value.stats.docComments
        totalStats.dependencies += result.value.stats.dependencies
        totalStats.featureFlags += result.value.stats.featureFlags
      } else {
        totalStats.filesFailed += 1
        let errorReason = "Unknown error"
        if (result.status === "rejected") {
          errorReason =
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason)
        } else if (result.value?.status === "error") {
          errorReason = result.value.error
        } else if (result.value) {
          errorReason = `Unexpected result value: ${JSON.stringify(result.value)}`
        } else {
          errorReason = "Fulfilled promise returned undefined or null value"
        }
      }
    })

    totalStats.filesProcessed = totalFiles - failedCount
    totalStats.filesFailed = failedCount

    console.log("\n=== Processing Summary ===")
    console.log(`Total Files Found: ${rustFiles.length}`)
    console.log(
      `Total Files Successfully Processed: ${totalStats.filesProcessed}`,
    )
    console.log(`Total Files Failed: ${totalStats.filesFailed}`)
    console.log(`Total Symbols Extracted: ${totalStats.symbols}`)
    console.log(`Total Code Chunks Extracted: ${totalStats.chunks}`)
    console.log(`Total Doc Comments Extracted: ${totalStats.docComments}`)
    console.log(`Total Dependencies Extracted: ${totalStats.dependencies}`)
    console.log(`Total Feature Flags Extracted: ${totalStats.featureFlags}`)

    return totalStats
  } catch (error) {
    console.error("Error processing repository:", error)
    throw error
  }
}

if (require.main === module) {
  const rawInputPath = process.argv[2]
  if (!rawInputPath) {
    console.error("Please provide a path (Rust file or repository directory)")
    process.exit(1)
  }

  const inputPath = path.resolve(rawInputPath)
  console.log(`Attempting to access resolved path: ${inputPath}`)

  fs.stat(inputPath, async (err, stats) => {
    if (err) {
      console.error(`Error accessing path ${inputPath}: ${err.message}`)
      process.exit(1)
    }

    if (stats.isDirectory()) {
      console.log(`Processing repository directory: ${inputPath}`)
      processRustRepository(inputPath).catch((error) => {
        console.error("Fatal error during repository processing:", error)
        process.exit(1)
      })
    } else if (stats.isFile() && inputPath.endsWith(".rs")) {
      console.log(`Processing single Rust file: ${inputPath}`)
      try {
        const extractor = new RustCodeExtractor()
        await extractor.ensureLanguageLoaded()
        const result = await processRustFile(inputPath, extractor)
        if (result.status === "success") {
          console.log(
            `Successfully processed and inserted data for ${path.basename(inputPath)}.`,
          )
          console.log("Stats:", result.stats)
        } else {
          console.error(
            `Failed to process ${path.basename(inputPath)}: ${result.error}`,
          )
          process.exit(1)
        }
      } catch (error: any) {
        console.error(
          `Fatal error processing file ${inputPath}:`,
          error.message || error,
        )
        process.exit(1)
      }
    } else {
      console.error(
        `Error: Provided path "${inputPath}" is not a directory or a .rs file.`,
      )
      process.exit(1)
    }
  })
}

export { RustCodeExtractor, processRustFile, processRustRepository }
