import { spawn, type ChildProcessWithoutNullStreams } from "child_process"
import { URI } from "vscode-uri"
import * as fs from "fs"
import * as path from "path"

// Call graph analyzer with JSON output for React Flow visualization

import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  RequestType,
  type MessageConnection,
} from "vscode-jsonrpc/node"
import {
  type InitializeParams,
  type InitializeResult,
  MessageType,
  type DocumentSymbolParams,
  SymbolKind,
  type DocumentSymbol,
  type CallHierarchyPrepareParams,
  type CallHierarchyItem,
  type CallHierarchyOutgoingCallsParams,
  type CallHierarchyOutgoingCall,
  type LogMessageParams,
} from "vscode-languageserver-protocol/node"

// --- Configuration ---
const projectPath = "/Users/sahebjotsingh/Code/Xyne/experiments/hyperswitch"
const defaultDepthLimit = 3 // How deep to explore the call hierarchy
const excludeExternalLibs = true // Skip exploring dependencies outside the project
const maxFunctionsPerDiagram = 100 // Limit diagram size for readability

// Add these new configuration options
const ignoredFunctionPatterns = [
  // Common method calls
  /\.clone$/,
  /^clone$/i, // Catch standalone clone functions
  /::clone$/i, // Catch trait implementations
  /Clone::clone/i, // Catch explicit trait calls
  /\bclone\b/i, // Catch any function with 'clone' as a word
  /^#\[derive/i, // Catch derive macro expansions
  /\.as_ref$/,
  /\.as_mut$/,
  /\.map$/,
  /\.map_err$/,
  /\.ok$/,
  /\.ok_or$/,
  /\.err$/,
  /\.unwrap(_or.*)?$/,
  /\.expect$/,
  /\.transpose$/,
  /\.to_string$/,
  /\.into$/,
  /\.await$/,
  /\.borrow$/,
  /\.borrow_mut$/,
  /\.deref$/,
  /\.deref_mut$/,
  /\.lock$/,
  /\.try_lock$/,
  /\.read$/,
  /\.write$/,
  /\.insert$/,
  /\.get$/,
  /\.entry$/,
  /\.or_insert$/,
  /\.len$/,
  /\.is_empty$/,
  /\.iter$/,
  /\.iter_mut$/,
  /\.next$/,
  /\.collect$/,
  /\.filter$/,
  /\.find$/,
  /\.fold$/,
  /\.zip$/,
  /\.chain$/,
  /\.then$/, // Future combinator
  /\.context$/, // Error handling context

  // Common function/constructor names (often simple)
  /^new$/, // Be careful, might filter important constructors if not combined with line count
  /^default$/,
  /^get_string_repr$/, // Added to ignore this specific function

  // Specific std/core paths (can be expanded)
  /^(std|core)::fmt::/,
  /^(std|core)::future::/,
  /^(std|core)::task::/,
  /^(std|core)::pin::/,
  /^(std|core)::ops::/,
  /^(std|core)::cmp::/,
  /^(std|core)::hash::/,
  /^(std|core)::(str|string)::/,
  /^(std|core)::option::Option::/,
  /^(std|core)::result::Result::/,
  /^(std|core)::convert::/,
  /^(std|core)::borrow::/,
  /^(std|core)::clone::Clone::/,
  /^(std|core)::default::Default::/,
  /^(std|core)::mem::/,
  /^(std|core)::ptr::/,
  /^(std|core)::slice::/,
  /^(std|core)::vec::/,

  // Common trait implementations / generated code markers
  /^(Debug|Display|From|Into|AsRef|AsMut|Default|Clone|PartialEq|Eq|PartialOrd|Ord|Hash|Send|Sync|Drop|Fn|FnMut|FnOnce)::/, // Trait methods
  /<impl.*>::/, // Explicit impl blocks
  /.* as .*/, // Trait coercions in names

  // Logging/Tracing
  /tracing::/,
  /log::/,

  // Serde attributes/derive helpers
  /serde::ser::/,
  /serde::de::/,

  // Tokio/Async runtime internals (examples)
  /tokio::runtime::/,
  /tokio::sync::/,
  /tokio::net::/,
  /tokio::task::/,

  // Common error handling patterns from crates like `anyhow`, `eyre`, `thiserror`
  /error_stack::/, // Hyperswitch specific?
  /^(anyhow|eyre|thiserror)::/,
  /^(from_error|into_report|change_context)$/, // error_stack helpers

  // Other potential noise (adjust based on project)
  /\.(record|current|is_disabled|in_current_span)$/, // tracing specifics
  /^(from_request|into_response)$/, // Web framework specifics (like actix/axum)
]

// Types for control flow
enum NodeType {
  Function = "function",
  Condition = "condition",
  Loop = "loop",
  Match = "match",
  Error = "error",
}

// --- Types for call graph ---
interface FunctionNode {
  id: string
  name: string
  uri: string
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  children: FunctionNode[]
  explored: boolean
  isExternal?: boolean // Outside the project path
  nodeType?: NodeType // Type of node for visualization
  conditions?: string[] // Condition expressions
  loops?: string[] // Loop types
  errors?: string[] // Error handling
  isBusinessLogic?: boolean // Flag for core business functions
  sourceCode?: string // The actual source code snippet for the function
}

interface CallGraph {
  rootNode: FunctionNode
  allNodes: Map<string, FunctionNode> // For quick lookups by ID
}

// Interface for React Flow visualization
interface ReactFlowNode {
  id: string
  type: string
  position: { x: number; y: number }
  data: {
    label: string
    nodeType: NodeType
    sourceCode?: string
    fileName?: string
    lineNumber?: number
    isExternal?: boolean
    isBusinessLogic?: boolean
    conditions?: string[]
    loops?: string[]
    errors?: string[]
  }
  style?: {
    width?: number
    height?: number
    background?: string
    border?: string
    borderRadius?: number
  }
}

interface ReactFlowEdge {
  id: string
  source: string
  target: string
  animated?: boolean
  label?: string
  type?: string
  style?: {
    stroke?: string
    strokeWidth?: number
  }
}

interface ReactFlowData {
  nodes: ReactFlowNode[]
  edges: ReactFlowEdge[]
}

// --- RustAnalyzerService class to maintain server state ---
class RustAnalyzerService {
  private process: ChildProcessWithoutNullStreams | null = null
  private connection: MessageConnection | null = null
  private isInitialized = false
  private functionCache = new Map<string, FunctionNode>() // Cache explored functions

  // Constructor initializes the service
  constructor(private projectPath: string) {}

  // Start the rust-analyzer server
  async start(): Promise<void> {
    if (this.process && this.connection) {
      console.log("Server already running.")
      return
    }

    console.log("Starting rust-analyzer server...")
    this.process = spawn("rust-analyzer", [], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
    })

    this.process.stderr.on("data", (data) =>
      console.error(`rust-analyzer stderr: ${data.toString()}`),
    )

    this.process.on("error", (err) => {
      console.error("Process error:", err)
      throw err
    })

    this.process.on("exit", (code, signal) => {
      console.log(
        `rust-analyzer process exited with code ${code}, signal ${signal}`,
      )
      this.connection?.dispose()
      this.connection = null
      this.process = null
      this.isInitialized = false
    })

    this.connection = createMessageConnection(
      new StreamMessageReader(this.process.stdout),
      new StreamMessageWriter(this.process.stdin),
    )

    // Add server logging
    this.connection.onNotification(
      "window/logMessage",
      (params: LogMessageParams) => {
        const typeMap = {
          [MessageType.Error]: "Error",
          [MessageType.Warning]: "Warning",
          [MessageType.Info]: "Info",
          [MessageType.Log]: "Log",
        }
        console.log(
          `[Server ${typeMap[params.type] || "Unknown"}] ${params.message}`,
        )
      },
    )

    this.connection.onNotification("$/progress", (params: any) => {
      console.log(`[Progress] Token: ${params.token}, Value:`, params.value)
    })

    this.connection.listen()
    console.log("LSP Connection established.")

    // Initialize the server
    await this.initialize()
  }

  // Initialize the LSP server
  private async initialize(): Promise<void> {
    if (!this.connection || this.isInitialized) return

    console.log("Initializing LSP server...")
    const initializeParams: InitializeParams = {
      processId: this.process?.pid ?? null,
      clientInfo: { name: "rust-handler-analyzer", version: "0.1.0" },
      rootUri: URI.file(this.projectPath).toString(),
      capabilities: {
        textDocument: {
          hover: { contentFormat: ["markdown", "plaintext"] },
          documentSymbol: {
            hierarchicalDocumentSymbolSupport: true,
            symbolKind: {
              valueSet: [
                SymbolKind.Function,
                SymbolKind.Method,
                SymbolKind.Struct,
                SymbolKind.Module,
                SymbolKind.Variable,
                SymbolKind.Field,
              ],
            },
          },
          callHierarchy: { dynamicRegistration: false },
        },
        workspace: { workspaceFolders: true },
      },
      workspaceFolders: [
        { uri: URI.file(this.projectPath).toString(), name: "project" },
      ],
      trace: "verbose",
    }

    try {
      const initializeResult: InitializeResult =
        await this.connection.sendRequest(
          new RequestType<InitializeParams, InitializeResult, void>(
            "initialize",
          ),
          initializeParams,
        )

      if (!initializeResult.capabilities.documentSymbolProvider) {
        throw new Error("Server doesn't support documentSymbolProvider")
      }
      if (!initializeResult.capabilities.callHierarchyProvider) {
        throw new Error("Server doesn't support callHierarchyProvider")
      }

      // Send initialized notification
      this.connection.sendNotification("initialized", {})
      this.isInitialized = true
      console.log("LSP server successfully initialized.")
    } catch (error) {
      console.error("Failed to initialize server:", error)
      throw error
    }
  }

  // Open a document in the server
  async openDocument(filePath: string): Promise<void> {
    if (!this.connection || !this.isInitialized) {
      throw new Error("Server not initialized")
    }

    try {
      const fileContent = fs.readFileSync(filePath, "utf-8")
      const didOpenParams = {
        textDocument: {
          uri: URI.file(filePath).toString(),
          languageId: "rust",
          version: 1,
          text: fileContent,
        },
      }
      this.connection.sendNotification("textDocument/didOpen", didOpenParams)

      // Wait for the document to be processed
      await this.waitForDocumentReady(filePath)
      console.log(`Document opened: ${filePath}`)
    } catch (e) {
      console.error(`Failed to open document ${filePath}:`, e)
      throw e
    }
  }

  // Wait until the document is ready for analysis
  private async waitForDocumentReady(filePath: string): Promise<void> {
    if (!this.connection) return

    const maxAttempts = 20
    const startTime = Date.now()
    const maxWaitTime = 30000

    console.log(`Waiting for document to be ready: ${filePath}`)

    // Give initial time for the server to start processing
    await new Promise((resolve) => setTimeout(resolve, 1000))

    const probeParams = {
      textDocument: { uri: URI.file(filePath).toString() },
    }

    let lastSymbolCount = 0
    let stabilityCounter = 0

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (Date.now() - startTime > maxWaitTime) {
        console.log(`Exceeded wait time limit. Proceeding anyway.`)
        break
      }

      try {
        const symbolsResult = await this.connection.sendRequest(
          "textDocument/documentSymbol",
          probeParams,
        )

        const symbols = Array.isArray(symbolsResult) ? symbolsResult : []

        if (symbols.length > 0 && symbols.length === lastSymbolCount) {
          stabilityCounter++
          if (stabilityCounter >= 2) {
            console.log(`Document ready. Found ${symbols.length} symbols.`)
            return
          }
        } else {
          stabilityCounter = 0
        }

        lastSymbolCount = symbols.length

        // Shorter delay when we have symbols
        const delay = symbols.length > 0 ? 500 : 1000
        await new Promise((resolve) => setTimeout(resolve, delay))
      } catch (error) {
        console.log(`Probe attempt ${attempt} failed. Retrying...`)
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }

    console.log("Document readiness check completed. Proceeding.")
  }

  // Find a function symbol by name in a file
  async findFunctionInFile(
    filePath: string,
    functionName: string,
  ): Promise<DocumentSymbol | null> {
    if (!this.connection || !this.isInitialized) {
      throw new Error("Server not initialized")
    }

    const symbolParams: DocumentSymbolParams = {
      textDocument: { uri: URI.file(filePath).toString() },
    }

    try {
      const symbolsResult = await this.connection.sendRequest(
        "textDocument/documentSymbol",
        symbolParams,
      )

      if (!symbolsResult || !Array.isArray(symbolsResult)) {
        console.error("Failed to get document symbols")
        return null
      }

      const findSymbol = (symbols: DocumentSymbol[]): DocumentSymbol | null => {
        for (const symbol of symbols) {
          if (
            (symbol.kind === SymbolKind.Function ||
              symbol.kind === SymbolKind.Method) &&
            symbol.name === functionName
          ) {
            return symbol
          }

          if (symbol.children?.length) {
            const found = findSymbol(symbol.children)
            if (found) return found
          }
        }
        return null
      }

      return findSymbol(symbolsResult as DocumentSymbol[])
    } catch (error) {
      console.error(
        `Error finding function ${functionName} in ${filePath}:`,
        error,
      )
      return null
    }
  }

  // Prepare call hierarchy for a function
  async prepareCallHierarchy(
    filePath: string,
    symbol: DocumentSymbol,
  ): Promise<CallHierarchyItem | null> {
    if (!this.connection || !this.isInitialized) {
      throw new Error("Server not initialized")
    }

    const prepareParams: CallHierarchyPrepareParams = {
      textDocument: { uri: URI.file(filePath).toString() },
      position: symbol.selectionRange.start,
    }

    try {
      const result = await this.connection.sendRequest(
        "textDocument/prepareCallHierarchy",
        prepareParams,
      )

      if (!result || !Array.isArray(result) || result.length === 0) {
        console.log(`No call hierarchy available for ${symbol.name}`)
        return null
      }

      return result[0] as CallHierarchyItem
    } catch (error) {
      console.error(`Error preparing call hierarchy for ${symbol.name}:`, error)
      return null
    }
  }

  // Get outgoing calls for a function (Keep this fast!)
  async getOutgoingCalls(
    item: CallHierarchyItem,
  ): Promise<CallHierarchyOutgoingCall[]> {
    if (!this.connection || !this.isInitialized) {
      throw new Error("Server not initialized")
    }

    const params: CallHierarchyOutgoingCallsParams = { item }

    try {
      const result = await this.connection.sendRequest(
        "callHierarchy/outgoingCalls",
        params,
      )

      if (!result || !Array.isArray(result)) {
        return []
      }

      // Enhanced filter for clone-related calls and implementations
      return result.filter((call) => {
        const name = call.to.name
        const uri = call.to.uri
        const isExternal = !uri.includes(this.projectPath)
        const lowerName = name.toLowerCase()

        // Filter 1: Ignored patterns (using the updated list)
        if (ignoredFunctionPatterns.some((pattern) => pattern.test(name))) {
          return false
        }

        // Filter 2: Special clone cases
        if (
          lowerName === "clone" ||
          lowerName.endsWith("::clone") ||
          lowerName.includes("clone::") ||
          lowerName.includes("#[derive") ||
          (lowerName.includes("clone") && uri.includes("types.rs"))
        ) {
          return false
        }

        // Filter 3: External libs/std (if configured)
        if (excludeExternalLibs && isExternal) {
          return false
        }

        // Keep the call if no filters match
        return true
      })
    } catch (error) {
      console.error(`Error getting outgoing calls for ${item.name}:`, error)
      return []
    }
  }

  // Fetch source code for a function
  async getSourceCodeForFunction(
    uri: string,
    range: {
      start: { line: number; character: number }
      end: { line: number; character: number }
    },
  ): Promise<string> {
    try {
      // Get the file path from the URI
      const filePath = URI.parse(uri).fsPath

      // Read the file content
      const fileContent = fs.readFileSync(filePath, "utf-8")

      // Split by lines and extract the function code
      const lines = fileContent.split("\n")
      const startLine = range.start.line
      const endLine = range.end.line

      // Extract the relevant lines
      const functionLines = lines.slice(startLine, endLine + 1)

      // Add line numbers to the code
      const codePlusLineNumbers = functionLines
        .map((line, idx) => `${startLine + idx + 1}: ${line}`)
        .join("\n")

      return codePlusLineNumbers
    } catch (error) {
      console.error("Failed to get source code:", error)
      return "// Failed to load source code"
    }
  }

  // Add method to analyze a function's source code for control flow
  async analyzeControlFlow(
    filePath: string,
    position: { line: number; character: number },
  ): Promise<{
    conditions: string[]
    loops: string[]
    matches: string[]
    errors: string[]
  }> {
    if (!this.connection || !this.isInitialized) {
      return { conditions: [], loops: [], matches: [], errors: [] }
    }

    try {
      // Use textDocument/hover to get detailed info about the function
      const hoverParams = {
        textDocument: { uri: filePath },
        position: position,
      }

      const hoverResult = await this.connection.sendRequest(
        "textDocument/hover",
        hoverParams,
      )
      const hoverContent = hoverResult?.contents?.value || ""

      // Extract control flow info from hover content
      const conditions = []
      const loops = []
      const matches = []
      const errors = []

      // Detect if statements
      if (hoverContent.includes("if ") || hoverContent.includes(" if")) {
        conditions.push("if")
      }

      // Detect match expressions
      if (hoverContent.includes("match ")) {
        matches.push("match")
      }

      // Detect loops
      if (hoverContent.includes("for ")) loops.push("for")
      if (hoverContent.includes("while ")) loops.push("while")
      if (hoverContent.includes("loop {")) loops.push("loop")

      // Detect error handling
      if (
        hoverContent.includes(".map_err(") ||
        hoverContent.includes("Err(") ||
        hoverContent.includes("?")
      ) {
        errors.push("error_handling")
      }

      return {
        conditions,
        loops,
        matches,
        errors,
      }
    } catch (error) {
      console.log("Failed to analyze control flow:", error)
      return { conditions: [], loops: [], matches: [], errors: [] }
    }
  }

  // Explore the call hierarchy recursively to build a call graph
  async buildCallGraph(
    filePath: string,
    functionName: string,
    depthLimit = defaultDepthLimit,
  ): Promise<CallGraph | null> {
    await this.openDocument(filePath)

    const symbol = await this.findFunctionInFile(filePath, functionName)
    if (!symbol) {
      console.error(`Function ${functionName} not found in ${filePath}`)
      return null
    }

    const rootItem = await this.prepareCallHierarchy(filePath, symbol)
    if (!rootItem) {
      console.error(`Failed to prepare call hierarchy for ${functionName}`)
      return null
    }

    const allNodes = new Map<string, FunctionNode>()

    const rootNode: FunctionNode = {
      id: this.generateNodeId(rootItem),
      name: rootItem.name,
      uri: rootItem.uri,
      range: rootItem.range,
      children: [],
      explored: false,
      isExternal: !rootItem.uri.includes(this.projectPath),
    }

    allNodes.set(rootNode.id, rootNode)

    // Explore the graph recursively
    await this.exploreNode(rootNode, allNodes, depthLimit, 0)

    return {
      rootNode,
      allNodes,
    }
  }

  // Helper function to generate a unique ID for a node
  private generateNodeId(item: CallHierarchyItem): string {
    const uri = item.uri
    const line = item.range.start.line
    const character = item.range.start.character
    return `${uri}:${line}:${character}:${item.name}`
  }

  // Recursively explore a node's outgoing calls
  private async exploreNode(
    node: FunctionNode,
    allNodes: Map<string, FunctionNode>,
    depthLimit: number,
    currentDepth: number,
  ): Promise<void> {
    // Skip if already explored or reached depth limit
    if (node.explored || currentDepth >= depthLimit) {
      return
    }

    // Skip external libraries if configured
    if (excludeExternalLibs && node.isExternal) {
      node.explored = true
      return
    }

    // Enhanced check for "clone" and other noise patterns
    // Catch full names like "Clone::clone" or any function containing "clone"
    const lowerName = node.name.toLowerCase()
    if (
      lowerName === "clone" ||
      lowerName.endsWith("::clone") ||
      lowerName.includes("clone::") ||
      lowerName.includes("#[derive") || // Skip derive macro expansions
      (lowerName.includes("clone") && node.uri.includes("types.rs")) // Special case for type-related clones
    ) {
      node.explored = true
      return // Skip exploring this node entirely
    }

    // Check cache
    const cachedNode = this.functionCache.get(node.id)
    if (cachedNode && cachedNode.explored) {
      node.children = cachedNode.children
      node.explored = true
      node.nodeType = cachedNode.nodeType
      node.conditions = cachedNode.conditions
      node.loops = cachedNode.loops
      node.errors = cachedNode.errors
      node.isBusinessLogic = cachedNode.isBusinessLogic
      node.sourceCode = cachedNode.sourceCode
      return
    }

    console.log(
      `Exploring calls from ${node.name} at depth ${currentDepth}/${depthLimit}`,
    )

    // Get source code for this function
    node.sourceCode = await this.getSourceCodeForFunction(node.uri, node.range)
    const lineCount = (node.sourceCode?.match(/\n/g) || []).length + 1 // Calculate line count

    // Reconstruct the CallHierarchyItem
    const item: CallHierarchyItem = {
      name: node.name,
      kind: SymbolKind.Function,
      uri: node.uri,
      range: node.range,
      selectionRange: node.range,
    }

    // Analyze control flow
    const fileUri = item.uri
    const controlFlow = await this.analyzeControlFlow(fileUri, item.range.start)

    // Update node with control flow info
    node.conditions = controlFlow.conditions
    node.loops = controlFlow.loops
    node.errors = controlFlow.errors

    // Determine node type based on control flow
    if (controlFlow.matches.length > 0) {
      node.nodeType = NodeType.Match
    } else if (controlFlow.conditions.length > 0) {
      node.nodeType = NodeType.Condition
    } else if (controlFlow.loops.length > 0) {
      node.nodeType = NodeType.Loop
    } else {
      node.nodeType = NodeType.Function
    }

    // --- Refined isBusinessLogic Calculation ---
    const fileName = URI.parse(node.uri).fsPath
    const relativePath = path.relative(this.projectPath, fileName)
    let businessScore = 0
    const minBusinessLogicLines = 4 // Functions shorter than this are likely utils/boilerplate

    // 1. Filter based on Ignored Patterns (Strong Negative Signal)
    if (ignoredFunctionPatterns.some((pattern) => pattern.test(node.name))) {
      businessScore -= 10 // Strongly penalize known utility patterns/stdlib
    }

    // 2. Filter based on Size (Small functions are less likely core logic)
    if (lineCount < minBusinessLogicLines) {
      businessScore -= 3
      // Further penalize short functions with common utility names
      if (
        /^(new|default|from|into|get|set|is|to)_/.test(node.name) ||
        /^(new|default|from|into)$/.test(node.name)
      ) {
        businessScore -= 2
      }
    } else if (lineCount > 15) {
      businessScore += 1 // Moderately complex
    }
    if (lineCount > 40) {
      businessScore += 2 // Quite complex
    }

    // 3. Location Heuristic (Moderate Signal) - Less emphasis than before
    // Prioritize core application logic directories, penalize utils/tests/db models slightly
    if (
      relativePath.startsWith("src/") &&
      !relativePath.includes("/util") &&
      !relativePath.includes("/errors") &&
      !relativePath.includes("/macros") &&
      !relativePath.includes("/tests") &&
      !relativePath.includes("/db/models")
    ) {
      businessScore += 1
    } else if (
      relativePath.includes("/utils/") ||
      relativePath.includes("/helpers/") ||
      relativePath.includes("/db/")
    ) {
      businessScore -= 1 // Less likely to be core *business* flow
    }

    // 4. Control Flow Complexity (Moderate Positive Signal)
    if (
      controlFlow.conditions.length > 0 ||
      controlFlow.loops.length > 0 ||
      controlFlow.matches.length > 0
    ) {
      // Only reward complexity if the function isn't tiny
      if (lineCount >= minBusinessLogicLines) {
        businessScore += 1
      }
    }
    // Reward significant error handling only in non-trivial functions
    if (controlFlow.errors.length > 0 && lineCount > 5) {
      businessScore += 1
    }

    // 5. External Code (Strong Negative Signal)
    if (node.isExternal) {
      businessScore -= 10
    }

    // 6. Name Heuristics (Weak Signals)
    // Penalize generic trait impl names slightly if not already caught by patterns
    if (node.name.includes("<impl") || node.name.includes(" as ")) {
      businessScore -= 1
    }
    // Penalize test functions
    if (node.name.startsWith("test_") || node.name.endsWith("_test")) {
      businessScore -= 5
    }

    // Set the flag based on a threshold (adjust as needed)
    // We require a positive score now, given the strong penalties
    node.isBusinessLogic = businessScore >= 1
    // --- End Refined Calculation ---

    // Fetch outgoing calls (using the fast filter)
    const outgoingCalls = await this.getOutgoingCalls(item)

    for (const call of outgoingCalls) {
      const calleeId = this.generateNodeId(call.to)

      // Check if we've already seen this node
      let calleeNode = allNodes.get(calleeId)

      if (!calleeNode) {
        calleeNode = {
          id: calleeId,
          name: call.to.name,
          uri: call.to.uri,
          range: call.to.range,
          children: [],
          explored: false,
          isExternal: !call.to.uri.includes(this.projectPath),
        }
        allNodes.set(calleeId, calleeNode)
      }

      // Add to children if not already there
      if (!node.children.some((child) => child.id === calleeId)) {
        node.children.push(calleeNode)
      }
    }

    node.explored = true

    // Cache this explored node
    this.functionCache.set(node.id, { ...node })

    // Recursively explore children
    for (const child of node.children) {
      await this.exploreNode(child, allNodes, depthLimit, currentDepth + 1)
    }
  }

  // Clean up resources
  async shutdown(): Promise<void> {
    if (!this.connection) return

    try {
      console.log("Shutting down rust-analyzer...")
      await this.connection.sendRequest("shutdown")
      this.connection.sendNotification("exit")

      // Give some time for the process to exit cleanly
      await new Promise((resolve) => setTimeout(resolve, 500))
    } catch (error) {
      console.error("Error during shutdown:", error)
    } finally {
      if (this.process && !this.process.killed) {
        this.process.kill()
        this.process = null
      }

      if (this.connection) {
        this.connection.dispose()
        this.connection = null
      }

      this.isInitialized = false
      console.log("Server shut down.")
    }
  }
}

// --- Conversion to React Flow format ---

// Convert a call graph to React Flow format with automatic layout
function convertToReactFlowFormat(graph: CallGraph): ReactFlowData {
  const nodes: ReactFlowNode[] = []
  const edges: ReactFlowEdge[] = []
  const processed = new Set<string>()

  // Replace simple grid layout with a hierarchical layout
  // Each depth level gets its own row, clearly showing call flow direction
  const levelSpacing = 250 // Vertical space between levels
  const nodeSpacing = 300 // Horizontal space between nodes at same level

  // Track nodes at each level for horizontal positioning
  const levelNodes: Map<number, FunctionNode[]> = new Map()

  // First pass - organize nodes by level through BFS
  const queue: { node: FunctionNode; level: number }[] = [
    { node: graph.rootNode, level: 0 },
  ]
  while (queue.length > 0) {
    const { node, level } = queue.shift()!

    if (processed.has(node.id)) continue
    processed.add(node.id)

    // Add node to its level
    if (!levelNodes.has(level)) {
      levelNodes.set(level, [])
    }
    levelNodes.get(level)!.push(node)

    // Add children to queue
    for (const child of node.children) {
      if (!processed.has(child.id)) {
        queue.push({ node: child, level: level + 1 })
      }
    }
  }

  // Reset processed set for second pass
  processed.clear()

  // Second pass - assign positions based on levels
  levelNodes.forEach((nodesInLevel, level) => {
    // Center nodes in level horizontally
    const levelWidth = nodesInLevel.length * nodeSpacing
    const startX = -levelWidth / 2 + nodeSpacing / 2

    nodesInLevel.forEach((node, idx) => {
      const xPos = startX + idx * nodeSpacing
      const yPos = level * levelSpacing

      // Create React Flow node
      const fileName = path.basename(URI.parse(node.uri).fsPath)
      const lineNumber = node.range.start.line + 1

      let nodeTypeString = "customNode"
      switch (node.nodeType) {
        case NodeType.Condition:
          nodeTypeString = "conditional"
          break
        case NodeType.Match:
          nodeTypeString = "match"
          break
        case NodeType.Loop:
          nodeTypeString = "loop"
          break
        default:
          nodeTypeString = "customNode"
      }

      nodes.push({
        id: node.id,
        type: nodeTypeString,
        position: {
          x: xPos,
          y: yPos,
        },
        data: {
          label: node.name,
          nodeType: node.nodeType || NodeType.Function,
          sourceCode: node.sourceCode || "Source code not available",
          fileName,
          lineNumber,
          isExternal: node.isExternal,
          isBusinessLogic: node.isBusinessLogic,
          conditions: node.conditions,
          loops: node.loops,
          errors: node.errors,
        },
        style: {
          width: 250,
        },
      })

      processed.add(node.id)
    })
  })

  // Process edges - use a different style to highlight flow direction clearly
  processed.clear()
  const queue2: FunctionNode[] = [graph.rootNode]

  while (queue2.length > 0) {
    const node = queue2.shift()!

    if (processed.has(node.id)) continue
    processed.add(node.id)

    // Process edges - create directional, more visible edges
    for (const child of node.children) {
      // Create more visually distinct edge
      edges.push({
        id: `e-${node.id}-${child.id}`,
        source: node.id,
        target: child.id,
        type: "step", // Use step for clearer flow direction visually
        animated: node.isBusinessLogic, // Animate edges for business logic paths
        style: {
          stroke: node.isBusinessLogic ? "#1a73e8" : "#888",
          strokeWidth: node.isBusinessLogic ? 2.5 : 1.5,
        },
        markerEnd: {
          type: "arrowclosed", // Explicit arrow for direction
          width: 15,
          height: 15,
          color: node.isBusinessLogic ? "#1a73e8" : "#888",
        },
      })

      if (!processed.has(child.id)) {
        queue2.push(child)
      }
    }
  }

  return { nodes, edges }
}

// Generate ReactFlow JSON for visualization
async function generateReactFlowJson(
  filePath: string,
  functionName: string,
  depthLimit = defaultDepthLimit,
): Promise<ReactFlowData | null> {
  const service = new RustAnalyzerService(projectPath)

  try {
    await service.start()

    console.log(`Analyzing function ${functionName} in ${filePath}...`)
    const graph = await service.buildCallGraph(
      filePath,
      functionName,
      depthLimit,
    )

    if (!graph) {
      console.error(`Failed to build call graph for ${functionName}`)
      return null
    }

    // Convert to React Flow format
    const reactFlowData = convertToReactFlowFormat(graph)

    return reactFlowData
  } catch (error) {
    console.error("Analysis error:", error)
    return null
  } finally {
    await service.shutdown()
  }
}

// Main entry point for analysis
async function analyzeHandlerFunction(
  filePath: string,
  functionName: string,
  depthLimit = defaultDepthLimit,
): Promise<{
  reactFlowJson: string // JSON string for React Flow
}> {
  try {
    const reactFlowData = await generateReactFlowJson(
      filePath,
      functionName,
      depthLimit,
    )

    if (!reactFlowData) {
      return {
        reactFlowJson: JSON.stringify({
          nodes: [
            {
              id: "error",
              type: "default",
              data: { label: "Analysis failed" },
              position: { x: 0, y: 0 },
            },
          ],
          edges: [],
        }),
      }
    }

    // Convert to JSON string
    const reactFlowJson = JSON.stringify(reactFlowData, null, 2)

    // Write output to file
    fs.writeFileSync("code_flow.json", reactFlowJson)
    console.log("Analysis complete. File written: code_flow.json")

    return { reactFlowJson }
  } catch (error) {
    console.error("Failed to run analysis:", error)
    return {
      reactFlowJson: JSON.stringify({
        nodes: [
          {
            id: "error",
            type: "default",
            data: { label: `Error: ${error}` },
            position: { x: 0, y: 0 },
          },
        ],
        edges: [],
      }),
    }
  }
}

// Example usage
if (require.main === module) {
  ;(async () => {
    const filePath =
      "/Users/sahebjotsingh/Code/Xyne/experiments/hyperswitch/crates/router/src/routes/payments.rs"
    const functionName = "payments_create"

    try {
      const result = await analyzeHandlerFunction(filePath, functionName, 2)
      console.log("\nAnalysis complete. JSON file written to code_flow.json")
    } catch (error) {
      console.error("Failed to run analysis:", error)
    }
  })()
}

export {
  RustAnalyzerService,
  analyzeHandlerFunction,
  generateReactFlowJson,
  type FunctionNode,
  type CallGraph,
  type ReactFlowData,
  type ReactFlowNode,
  type ReactFlowEdge,
}
