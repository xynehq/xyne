// import * as parser from 'tree-sitter'; // Remove namespace import
import * as fs from "fs"
import * as path from "path"
import crypto from "crypto" // Import crypto for hashing
import Parser from "tree-sitter" // Use default import
import type { SyntaxNode } from "tree-sitter" // Use type-only import for SyntaxNode
import { insert } from "@/search/vespa" // Import the insert function
import { codeRustSchema } from "@/search/types" // Import the schema constant

// Helper function to create a consistent hash for the docId
const hashFilePath = (filePath: string): string => {
  return crypto.createHash("sha256").update(filePath).digest("hex")
}
// Tree-sitter extractor for Rust code - Basic version with direct node traversal
class RustCodeExtractor {
  private parser: Parser // Use default import 'Parser' for type

  constructor() {
    // Initialize Tree-sitter
    this.parser = new Parser()

    // We need to dynamically load the Rust grammar
    this.loadRustLanguage()
  }

  // Load Rust language grammar
  private async loadRustLanguage() {
    try {
      // Load Rust grammar - use the approach that works with your setup
      const Rust = await import("tree-sitter-rust")
      // Cast to 'any' to resolve potential type mismatch with dynamic import
      this.parser.setLanguage((Rust.default || Rust) as any)
    } catch (error) {
      console.error("Failed to load tree-sitter-rust:", error)
      throw new Error("Unable to load Rust language for Tree-sitter")
    }
  }

  private getNodeText(sourceCode: string, node: SyntaxNode): string {
    // Use imported SyntaxNode
    return sourceCode.substring(node.startIndex, node.endIndex)
  }

  // Traverse the node tree and collect nodes of specific types
  private traverseTree(
    node: SyntaxNode,
    callback: (node: SyntaxNode) => void,
  ): void {
    // Use imported SyntaxNode
    callback(node)

    // Iterate through all children
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (child) {
        this.traverseTree(child, callback)
      }
    }
  }

  // Extract all symbol names (functions, structs, enums, traits, etc.)
  private extractSymbolNames(
    sourceCode: string,
    rootNode: SyntaxNode,
  ): string[] {
    // Use imported SyntaxNode
    const symbolSet = new Set<string>()

    this.traverseTree(rootNode, (node) => {
      let nameNode = null

      // Check various node types and extract their names
      if (
        node.type === "function_item" ||
        node.type === "struct_item" ||
        node.type === "enum_item" ||
        node.type === "trait_item" ||
        node.type === "mod_item" ||
        node.type === "type_item" ||
        node.type === "const_item" ||
        node.type === "static_item" ||
        node.type === "macro_definition"
      ) {
        nameNode = node.childForFieldName("name")
        if (nameNode) {
          symbolSet.add(this.getNodeText(sourceCode, nameNode))
        }
      }
    })

    return Array.from(symbolSet)
  }

  // Extract code chunks (functions, structs, etc.) into flattened arrays
  private extractCodeChunksFlattened(
    sourceCode: string,
    rootNode: SyntaxNode,
  ): {
    // Use SyntaxNode type
    kinds: string[]
    names: string[]
    contents: string[]
    startLines: number[]
    endLines: number[]
  } {
    const kinds: string[] = []
    const names: string[] = []
    const contents: string[] = []
    const startLines: number[] = []
    const endLines: number[] = []
    const itemTypes = [
      // Keep only one declaration
      "function_item",
      "struct_item",
      "enum_item",
      "trait_item",
      "impl_item", // Assuming impl blocks might be relevant chunks
      "type_item",
      "const_item",
      "static_item",
      "macro_definition",
    ]

    this.traverseTree(rootNode, (node) => {
      if (itemTypes.includes(node.type)) {
        // Use 'identifier' for name in some cases like impl blocks if 'name' isn't present
        const nameNode =
          node.childForFieldName("name") || node.childForFieldName("identifier")
        // For impl blocks, the type might be more relevant than a specific name
        const typeNode = node.childForFieldName("type")

        let chunkName = "unknown"
        if (nameNode) {
          chunkName = this.getNodeText(sourceCode, nameNode)
        } else if (typeNode) {
          // Use type as name for impl blocks if no direct name
          chunkName = `impl_${this.getNodeText(sourceCode, typeNode)}`
        }

        kinds.push(node.type.replace("_item", ""))
        names.push(chunkName)
        contents.push(this.getNodeText(sourceCode, node))
        startLines.push(node.startPosition.row)
        endLines.push(node.endPosition.row)
      }
    })

    return { kinds, names, contents, startLines, endLines }
  }

  // Extract doc comments into flattened arrays
  private extractDocCommentsFlattened(
    sourceCode: string,
    rootNode: SyntaxNode,
  ): {
    // Use SyntaxNode type
    texts: string[]
    targets: string[] // Placeholder, logic to determine target needed
    startLines: number[]
  } {
    const texts: string[] = []
    const targets: string[] = [] // Need logic to associate comments with code items
    const startLines: number[] = []
    const docLines: Record<number, string> = {}
    // Removed duplicate docLines declaration here

    // First pass: collect all doc comment lines and simple block comments
    this.traverseTree(rootNode, (node) => {
      if (node.type === "line_comment") {
        const text = this.getNodeText(sourceCode, node)
        if (text.trim().startsWith("///")) {
          docLines[node.startPosition.row] = text.trim().substring(3).trim()
        }
      } else if (node.type === "block_comment") {
        const text = this.getNodeText(sourceCode, node)
        if (text.trim().startsWith("/**")) {
          // Basic block comment processing
          const cleanedText = text
            .trim()
            .replace(/^\/\*\*/, "")
            .replace(/\*\/$/, "")
            .trim()

          // Process block comments simply by adding them as single entries
          // Correctly push to the flattened arrays
          texts.push(cleanedText)
          targets.push("unknown") // Placeholder - associating comments needs more logic
          startLines.push(node.startPosition.row)
        }
      }
    })

    // Second pass: group consecutive line comments
    let currentComment = ""
    let currentLine = -1

    const lineNumbers = Object.keys(docLines)
      .map(Number)
      .sort((a, b) => a - b)

    for (const lineNum of lineNumbers) {
      if (currentLine === -1 || lineNum === currentLine + 1) {
        // Continuous comment
        if (currentComment) currentComment += "\n"
        currentComment += docLines[lineNum]
        currentLine = lineNum
      } else {
        // Gap found, store the current comment group
        if (currentComment) {
          // Correctly push to the flattened arrays
          texts.push(currentComment)
          targets.push("unknown") // Placeholder
          startLines.push(currentLine - currentComment.split("\n").length + 1)
        }

        // Start a new comment
        currentComment = docLines[lineNum]
        currentLine = lineNum
      }
    }
    // Don't forget the last comment group
    if (currentComment) {
      texts.push(currentComment)
      targets.push("unknown") // Placeholder
      startLines.push(currentLine - currentComment.split("\n").length + 1)
    }

    return { texts, targets, startLines }
  }

  // Extract dependencies into flattened arrays
  private extractDependenciesFlattened(
    sourceCode: string,
    rootNode: SyntaxNode,
  ): {
    // Use SyntaxNode type
    names: string[]
    fullPaths: string[]
    lines: number[]
  } {
    const names: string[] = []
    const fullPaths: string[] = []
    const lines: number[] = []

    this.traverseTree(rootNode, (node: SyntaxNode) => {
      // Add type annotation
      if (node.type === "use_declaration") {
        const treeNode = node.childForFieldName("tree")
        if (treeNode) {
          const path = this.getNodeText(sourceCode, treeNode)
          const pathParts = path.split("::")
          const mainDep = pathParts[0].trim()

          if (mainDep) {
            names.push(mainDep)
            fullPaths.push(path)
            lines.push(node.startPosition.row)
          }
        }
      } else if (node.type === "extern_crate_declaration") {
        const nameNode = node.childForFieldName("name")
        if (nameNode) {
          const name = this.getNodeText(sourceCode, nameNode)
          names.push(name)
          fullPaths.push(name) // Use name as full path for extern crate
          lines.push(node.startPosition.row)
        }
      }
    })

    return { names, fullPaths, lines }
  }

  // Extract feature flags (already returns a suitable structure for array<string>)
  private extractFeatureFlags(
    sourceCode: string,
    rootNode: SyntaxNode,
  ): string[] {
    // Use imported SyntaxNode
    const features: string[] = []

    this.traverseTree(rootNode, (node) => {
      if (node.type === "attribute_item") {
        const text = this.getNodeText(sourceCode, node)
        const featureMatch = text.match(/#\[cfg\(feature\s*=\s*"([^"]+)"\)\]/)

        if (featureMatch) {
          const featureName = featureMatch[1]
          features.push(featureName) // Just push the name string
        }
      }
    })

    return features
  }

  // Main extraction method
  public async extract(filePath: string): Promise<any> {
    try {
      const sourceCode = fs.readFileSync(filePath, "utf-8")

      // Wait for language initialization
      await this.loadRustLanguage()

      const tree = this.parser.parse(sourceCode)
      const rootNode = tree.rootNode
      // Extract all code data using flattened methods
      const symbolNames = this.extractSymbolNames(sourceCode, rootNode)
      const {
        kinds: codeChunkKinds,
        names: codeChunkNames,
        contents: codeChunkContents,
        startLines: codeChunkStartLines,
        endLines: codeChunkEndLines,
      } = this.extractCodeChunksFlattened(sourceCode, rootNode)
      const {
        texts: docCommentsTexts,
        targets: docCommentsTargets,
        startLines: docCommentsStartLines,
      } = this.extractDocCommentsFlattened(sourceCode, rootNode)
      const {
        names: dependenciesNames,
        fullPaths: dependenciesFullPaths,
        lines: dependenciesLines,
      } = this.extractDependenciesFlattened(sourceCode, rootNode)
      const featureFlags = this.extractFeatureFlags(sourceCode, rootNode) // Already returns string[]

      // Create a document ready for Vespa using flattened fields
      const docId = hashFilePath(filePath) // Calculate hash for docId
      const vespaDoc = {
        docId: docId, // Add the hashed docId field
        filename: path.basename(filePath),
        path: filePath,
        language: "rust",
        raw_content: sourceCode,
        symbol_names: symbolNames,
        code_chunk_kinds: codeChunkKinds,
        code_chunk_names: codeChunkNames,
        code_chunk_contents: codeChunkContents,
        code_chunk_start_lines: codeChunkStartLines,
        code_chunk_end_lines: codeChunkEndLines,
        doc_comments_texts: docCommentsTexts,
        doc_comments_targets: docCommentsTargets, // Placeholder targets
        doc_comments_start_lines: docCommentsStartLines,
        dependencies_names: dependenciesNames,
        dependencies_full_paths: dependenciesFullPaths,
        dependencies_lines: dependenciesLines,
        feature_flags: featureFlags, // Directly use the string array
        // Metadata fields removed as they are not in the code_rust.sd schema
        // line_count: sourceCode.split('\n').length,
        // char_count: sourceCode.length,
        // symbol_count: symbolNames.length,
      }

      return vespaDoc
    } catch (error) {
      console.error("Error extracting data:", error)
      throw error
    }
  }

  // Generate Vespa document JSON format
  public toVespaDocument(extractedData: any): string {
    return JSON.stringify(extractedData, null, 2)
  }
}

// Example usage
async function processRustFile(filePath: string) {
  try {
    const extractor = new RustCodeExtractor()

    console.log(`Processing ${filePath}...`)
    const extractedData = await extractor.extract(filePath)

    // Directly insert the document into Vespa
    console.log(`Inserting document for ${filePath} into Vespa...`)
    // Pass the extracted data (which now includes docId) directly
    await insert(extractedData, codeRustSchema)
    console.log(
      `Successfully inserted document with ID ${extractedData.docId} for ${filePath}.`,
    )

    // Update console logs to reflect direct insertion
    console.log(`Processed and Inserted ${filePath}`)
    console.log(`- Extracted ${extractedData.symbol_names.length} symbols`)
    console.log(
      `- Extracted ${extractedData.code_chunk_names.length} code chunks`,
    ) // Use names length as chunk count indicator
    console.log(
      `- Extracted ${extractedData.doc_comments_texts.length} doc comments`,
    )
    console.log(
      `- Extracted ${extractedData.dependencies_names.length} dependencies`,
    )
    console.log(
      `- Extracted ${extractedData.feature_flags.length} feature flags`,
    )
    // No output path needed anymore
    // console.log(`- Output: ${outputPath}`);

    return {
      status: "success", // Indicate success of extraction and insertion
      stats: {
        // Update stats object keys
        symbols: extractedData.symbol_names.length,
        chunks: extractedData.code_chunk_names.length, // Use names length
        docComments: extractedData.doc_comments_texts.length,
        dependencies: extractedData.dependencies_names.length,
        featureFlags: extractedData.feature_flags.length,
      },
      // No outputPath in return value
    }
  } catch (error: any) {
    console.error("Error processing file:", error)
    return {
      status: "error",
      error: error?.toString(), // Use optional chaining
    }
  }
}

// If this script is run directly
if (require.main === module) {
  const filePath = process.argv[2]
  if (!filePath) {
    console.error("Please provide a Rust file path")
    process.exit(1)
  }

  processRustFile(filePath).catch(console.error)
}

export { RustCodeExtractor, processRustFile }
