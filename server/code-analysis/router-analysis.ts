import fs from "node:fs/promises"
import path from "node:path"
import type { SyntaxNode, Tree } from "tree-sitter" // Added Tree
import Parser from "tree-sitter"
import Rust from "tree-sitter-rust"
import { insert } from "@/search/vespa" // Import the insert function
import {
  Apps,
  codeApiDocsSchema,
  type VespaCodeApiDocs,
  CodeEntity,
} from "@/search/types" // Import correct schema name, type, and enum

// --- Types (Updated) ---
interface OpenApiRouteInfo {
  path: string
  method: string
  operationId?: string
  summary?: string
  description?: string
  parameters?: any[]
  requestBody?: any
  responses?: Record<string, any>
}

// Added handler analysis fields
interface RustRouteLocation {
  path: string
  method: string
  handler: string
  file: string // File where route is defined
  line: number
  struct?: string
  // --- Merged OpenAPI Data ---
  openapi_summary?: string
  openapi_description?: string
  openapi_operationId?: string
  openapi_parameters?: any[]
  openapi_requestBody?: any
  openapi_responses?: Record<string, any>
  // --- Handler Source & Analysis Info ---
  handler_source_file?: string // Best guess file where handler fn is defined
  handler_source_line?: number // Line where handler fn starts
  handler_dependencies?: string[] // Functions/methods called directly
  handler_keywords?: string[] // Keywords like 'match', '?', 'for', 'loop', 'await'
  // --- Status Flags ---
  is_ambiguous?: boolean // Flag if multiple Rust impls match one OpenAPI route
  not_in_openapi?: boolean // Flag if this Rust route isn't in OpenAPI
}

// Type for storing parsed trees
type ParsedTreesMap = Map<string, Tree>

// --- Tree-sitter and Path Helpers (mostly unchanged, added logging) ---

type ParserType = new () => Parser
const parser = new (Parser as any as ParserType)()
parser.setLanguage(Rust)
const DEBUG_LOGGING = false // Set to true for detailed parsing logs

function debugLog(...args: any[]) {
  if (DEBUG_LOGGING) {
    console.debug("[DEBUG]", ...args)
  }
}

function findFirstChild(
  node: SyntaxNode | null,
  type: string,
): SyntaxNode | null {
  if (!node) return null
  return node.children.find((c) => c.type === type) || null
}

function findFirstNamedChild(
  node: SyntaxNode | null,
  type: string,
): SyntaxNode | null {
  if (!node) return null
  return node.namedChildren.find((c) => c.type === type) || null
}

function findDescendantOfType(
  node: SyntaxNode | null,
  type: string,
): SyntaxNode | null {
  if (!node) return null
  // Limit search depth? Maybe not necessary yet.
  return node.descendantsOfType(type)[0] || null
}

function getIdentifierText(node: SyntaxNode | null): string {
  if (!node || node.type !== "identifier") return ""
  return node.text
}

function getScopedIdentifierText(node: SyntaxNode | null): string {
  if (!node || node.type !== "scoped_identifier") return ""
  // Adjusted to handle potentially deeper nesting like `crate::modules::name`
  const pathNode = node.childForFieldName("path") // Path can be identifier or another scoped_identifier
  const nameNode = node.childForFieldName("name") // Name is usually identifier

  if (pathNode && nameNode && nameNode.type === "identifier") {
    let scopeText = ""
    if (pathNode.type === "identifier") {
      scopeText = pathNode.text
    } else if (pathNode.type === "scoped_identifier") {
      scopeText = getScopedIdentifierText(pathNode) // Recurse
    } else {
      scopeText = pathNode.text // Fallback for other types?
    }
    return `${scopeText}::${nameNode.text}`
  }
  // Fallback for simpler cases or unexpected structures
  debugLog(`Couldn't fully parse scoped_identifier: ${node.text}`)
  return node.text
}

function getStringLiteralText(node: SyntaxNode | null): string {
  if (!node || node.type !== "string_literal") return ""
  // Handle raw strings r#"..."# as well
  return node.text.replace(/^r?#?"|"#?$/g, "")
}

const normalizePath = (p: string): string => {
  let np = p.replace(/^\/+|\/+$/g, "")
  np = np.replace(/:([^\/\s{}]+)/g, "{$1}")
  np = np.replace(/{([^\/\s{}]+)(:[^}]+)?}/g, "{$1}")
  return np ? `/${np}` : "/"
}

const joinPaths = (a: string, b: string): string => {
  const na = a.replace(/\/+$/g, "")
  const nb = b.replace(/^\/+|\/+$/g, "")
  if (!na && !nb) return "/"
  if (!na) return normalizePath(nb)
  if (!nb) return normalizePath(na)
  return normalizePath(`${na}/${nb}`)
}

// --- Rust Code Parsing (extractAllRoutesFromFile - Unchanged) ---
// ... function extractAllRoutesFromFile ... // Assuming this exists from previous context

// --- OpenAPI Parsing (parseOpenApi - Unchanged) ---
// ... function parseOpenApi ... // Assuming this exists

// --- Recursive File Finder (getAllRustFiles - Unchanged) ---
// ... function getAllRustFiles ... // Assuming this exists

// --- Process Rust Files (Updated to return Trees) ---
async function parseRustFilesAndTrees(
  files: string[],
): Promise<{ locations: RustRouteLocation[]; trees: ParsedTreesMap }> {
  const allLocations: RustRouteLocation[] = []
  const parsedTrees: ParsedTreesMap = new Map()
  for (const f of files) {
    try {
      const src = await fs.readFile(f, "utf8")
      const tree = parser.parse(src) // Parse once
      parsedTrees.set(f, tree) // Store the tree
      // Use the already parsed tree for route extraction
      allLocations.push(...extractAllRoutesFromFileWithTree(tree, f)) // Use the tree-based extractor
    } catch (err: any) {
      console.warn(`Skipping file ${f} due to error: ${err.message}`)
    }
  }
  return { locations: allLocations, trees: parsedTrees }
}

// --- Rust Route Extraction (Using Pre-parsed Tree) ---
// Renamed and adapted from extractAllRoutesFromFile to accept a tree
function extractAllRoutesFromFileWithTree(
  tree: Tree,
  filePath: string,
): RustRouteLocation[] {
  // --- This function's body is IDENTICAL to the previous extractAllRoutesFromFile ---
  // --- EXCEPT it takes 'tree: Tree' as input instead of 'src: string' ---
  // --- and does NOT call 'parser.parse(src)' inside. ---
  debugLog(`Extracting routes from pre-parsed tree: ${filePath}`)
  const locations: RustRouteLocation[] = []

  for (const implNode of tree.rootNode.descendantsOfType("impl_item")) {
    const typeNode =
      findFirstNamedChild(implNode, "type_identifier") ??
      findFirstNamedChild(implNode, "scoped_type_identifier")
    const structName = typeNode?.text

    const serverFn = implNode
      .descendantsOfType("function_item")
      .find((fn) => fn.childForFieldName("name")?.text === "server")

    if (!serverFn) continue
    // ... (rest of the logic is identical to the previous version) ...
    const serverBody = serverFn.childForFieldName("body")
    if (!serverBody) continue

    let baseScopePath = ""
    const scopeCall = serverBody
      .descendantsOfType("call_expression")
      .find((call) => {
        const func = call.childForFieldName("function")
        return (
          func?.type === "scoped_identifier" &&
          getScopedIdentifierText(func) === "web::scope"
        )
      })
    if (scopeCall) {
      const scopeArgs = scopeCall.childForFieldName("arguments")
      baseScopePath = getStringLiteralText(scopeArgs?.firstNamedChild)
    }

    for (const serviceCall of serverBody.descendantsOfType("call_expression")) {
      const serviceFunc = serviceCall.childForFieldName("function")
      if (
        serviceFunc?.type !== "field_expression" ||
        serviceFunc.childForFieldName("field")?.text !== "service"
      ) {
        continue
      }
      const serviceArgs = serviceCall.childForFieldName("arguments")
      const serviceArgExpression = serviceArgs?.firstNamedChild
      if (!serviceArgExpression) continue

      let subPath = ""
      let method = ""
      let handler = ""
      let line = serviceCall.startPosition.row + 1

      const resourceCall = serviceArgExpression
        .descendantsOfType("call_expression")
        .find((call) => {
          const func = call.childForFieldName("function")
          return (
            func?.type === "scoped_identifier" &&
            getScopedIdentifierText(func) === "web::resource"
          )
        })
      if (resourceCall) {
        const resourceArgs = resourceCall.childForFieldName("arguments")
        subPath = getStringLiteralText(resourceArgs?.firstNamedChild) || ""
      } else {
        continue
      }

      const routeCall = serviceArgExpression
        .descendantsOfType("call_expression")
        .find((call) => {
          const func = call.childForFieldName("function")
          return (
            func?.type === "field_expression" &&
            func.childForFieldName("field")?.text === "route"
          )
        })
      if (!routeCall) continue

      const routeArgs = routeCall.childForFieldName("arguments")
      const methodCall = routeArgs
        ?.descendantsOfType("call_expression")
        .find((call) => {
          const func = call.childForFieldName("function")
          if (func?.type === "scoped_identifier") {
            const scope = func.namedChildren[0]
            const name = func.namedChildren[1]
            return (
              scope?.text === "web" &&
              ["get", "post", "put", "delete", "patch"].includes(name?.text)
            )
          }
          return false
        })
      if (methodCall) {
        const methodFunc = methodCall.childForFieldName("function")
        method = methodFunc!.namedChildren[1].text.toUpperCase()
      } else {
        continue
      }

      const toCall = serviceArgExpression
        .descendantsOfType("call_expression")
        .find((call) => {
          const func = call.childForFieldName("function")
          return (
            func?.type === "field_expression" &&
            func.childForFieldName("field")?.text === "to"
          )
        })
      if (!toCall) continue
      line = toCall.startPosition.row + 1

      const toArgs = toCall.childForFieldName("arguments")
      const handlerArg = toArgs?.firstNamedChild
      if (handlerArg) {
        if (handlerArg.type === "identifier")
          handler = getIdentifierText(handlerArg)
        else if (handlerArg.type === "scoped_identifier")
          handler = getScopedIdentifierText(handlerArg)
        else if (handlerArg.type === "closure_expression") {
          const innerScopedCall =
            handlerArg.descendantsOfType("scoped_identifier")[0]
          if (innerScopedCall)
            handler = getScopedIdentifierText(innerScopedCall)
          else handler = handlerArg.text
        } else handler = handlerArg.text
      } else {
        continue
      }

      if (method && handler) {
        const fullPath = joinPaths(baseScopePath, subPath)
        // Initialize with defaults for new fields
        locations.push({
          file: filePath,
          line,
          method,
          path: fullPath,
          handler,
          struct: structName,
          is_ambiguous: false,
          not_in_openapi: false,
        })
      }
    } // end service call loop
  } // end impl loop
  return locations
}

// --- Handler Analysis Function ---
interface HandlerAnalysisResult {
  handler_source_file?: string
  handler_source_line?: number
  handler_dependencies?: string[]
  handler_keywords?: string[]
}

function analyzeHandler(
  handlerString: string,
  trees: ParsedTreesMap,
): HandlerAnalysisResult {
  const result: HandlerAnalysisResult = {}
  const handlerParts = handlerString.split("::")
  const handlerName = handlerParts.pop() // Get the function name itself
  if (!handlerName) return result // Invalid handler string

  let foundFile: string | undefined
  let foundNode: SyntaxNode | undefined
  let potentialFiles: string[] = []

  // Heuristic: Search all trees for the function definition
  for (const [filePath, tree] of trees.entries()) {
    const funcNode = tree.rootNode
      .descendantsOfType("function_item")
      .find((fn) => fn.childForFieldName("name")?.text === handlerName)

    if (funcNode) {
      // Basic check: does the file path seem related to the module path?
      // e.g., handler "payments::create" in file "payments.rs" or "payments/mod.rs"
      const modulePathGuess = handlerParts.join("/")
      if (filePath.includes(modulePathGuess)) {
        // Stronger candidate
        foundFile = filePath
        foundNode = funcNode
        potentialFiles = [filePath] // Reset potential files if strong candidate found
        break // Assume first strong candidate is correct (simplification)
      } else {
        potentialFiles.push(filePath)
        if (!foundNode) {
          // Keep the first match found as a fallback
          foundFile = filePath
          foundNode = funcNode
        }
      }
    }
  }

  if (
    potentialFiles.length > 1 &&
    foundFile &&
    !foundFile.includes(handlerParts.join("/"))
  ) {
    console.warn(
      `[ANALYSIS WARN] Ambiguous handler definition for "${handlerName}" found in: ${potentialFiles.join(", ")}. Using first match: ${foundFile}`,
    )
  }

  if (foundNode && foundFile) {
    result.handler_source_file = foundFile
    result.handler_source_line = foundNode.startPosition.row + 1
    result.handler_dependencies = []
    result.handler_keywords = []
    const uniqueDeps = new Set<string>()
    const uniqueKeywords = new Set<string>()

    const body = foundNode.childForFieldName("body")
    if (body) {
      // Find direct calls
      for (const call of body.descendantsOfType("call_expression")) {
        const func = call.childForFieldName("function")
        let callName = ""
        if (func?.type === "identifier") {
          callName = getIdentifierText(func)
        } else if (func?.type === "scoped_identifier") {
          callName = getScopedIdentifierText(func)
        } else if (func?.type === "field_expression") {
          // Record method calls like '.method_name()'
          const fieldName = func.childForFieldName("field")?.text
          if (fieldName) callName = `.${fieldName}`
        }
        if (callName && !callName.startsWith("web::")) {
          // Exclude actix web builders
          uniqueDeps.add(callName)
        }
      }

      // Find keywords/operators
      body
        .descendantsOfType("match_expression")
        .forEach(() => uniqueKeywords.add("match"))
      body
        .descendantsOfType("try_expression")
        .forEach(() => uniqueKeywords.add("?")) // The ? operator
      body
        .descendantsOfType("for_expression")
        .forEach(() => uniqueKeywords.add("for"))
      body
        .descendantsOfType("while_expression")
        .forEach(() => uniqueKeywords.add("while"))
      body
        .descendantsOfType("loop_expression")
        .forEach(() => uniqueKeywords.add("loop"))
      body
        .descendantsOfType("await_expression")
        .forEach(() => uniqueKeywords.add("await"))
    }
    result.handler_dependencies = Array.from(uniqueDeps).sort()
    result.handler_keywords = Array.from(uniqueKeywords).sort()
  } else {
    debugLog(
      `[ANALYSIS] Could not find function definition for handler: ${handlerString}`,
    )
  }

  return result
}

function extractAllRoutesFromFile(
  src: string,
  filePath: string,
): RustRouteLocation[] {
  debugLog(`Parsing file: ${filePath}`)
  const tree = parser.parse(src)
  const locations: RustRouteLocation[] = []

  for (const implNode of tree.rootNode.descendantsOfType("impl_item")) {
    const typeNode =
      findFirstNamedChild(implNode, "type_identifier") ??
      findFirstNamedChild(implNode, "scoped_type_identifier")
    const structName = typeNode?.text

    const serverFn = implNode
      .descendantsOfType("function_item")
      .find((fn) => fn.childForFieldName("name")?.text === "server")

    if (!serverFn) continue
    debugLog(
      `Found 'server' function for struct ${structName || "Unknown"} in ${filePath}`,
    )

    const serverBody = serverFn.childForFieldName("body")
    if (!serverBody) continue

    let baseScopePath = ""
    const scopeCall = serverBody
      .descendantsOfType("call_expression")
      .find((call) => {
        const func = call.childForFieldName("function")
        return (
          func?.type === "scoped_identifier" &&
          getScopedIdentifierText(func) === "web::scope"
        )
      })
    if (scopeCall) {
      const scopeArgs = scopeCall.childForFieldName("arguments")
      baseScopePath = getStringLiteralText(scopeArgs?.firstNamedChild)
      debugLog(`Found base scope "${baseScopePath}" in server fn`)
    } else {
      debugLog(`Could not find base web::scope call in server fn`)
    }

    for (const serviceCall of serverBody.descendantsOfType("call_expression")) {
      const serviceFunc = serviceCall.childForFieldName("function")
      if (
        serviceFunc?.type !== "field_expression" ||
        serviceFunc.childForFieldName("field")?.text !== "service"
      ) {
        continue
      }
      debugLog(
        `Found a .service() call at line ${serviceCall.startPosition.row + 1}`,
      )

      const serviceArgs = serviceCall.childForFieldName("arguments")
      const serviceArgExpression = serviceArgs?.firstNamedChild

      if (!serviceArgExpression) {
        debugLog(`  -> No argument found for .service()`)
        continue
      }

      let subPath = ""
      let method = ""
      let handler = ""
      let line = serviceCall.startPosition.row + 1

      const resourceCall = serviceArgExpression
        .descendantsOfType("call_expression")
        .find((call) => {
          const func = call.childForFieldName("function")
          return (
            func?.type === "scoped_identifier" &&
            getScopedIdentifierText(func) === "web::resource"
          )
        })
      if (resourceCall) {
        const resourceArgs = resourceCall.childForFieldName("arguments")
        subPath = getStringLiteralText(resourceArgs?.firstNamedChild) || ""
        debugLog(`  -> Found web::resource("${subPath}") within service arg`)
      } else {
        debugLog(
          `  -> Could not find web::resource call within service arg: ${serviceArgExpression.text.substring(0, 50)}...`,
        )
        continue
      }

      const routeCall = serviceArgExpression
        .descendantsOfType("call_expression")
        .find((call) => {
          const func = call.childForFieldName("function")
          return (
            func?.type === "field_expression" &&
            func.childForFieldName("field")?.text === "route"
          )
        })
      if (!routeCall) {
        debugLog(`  -> Could not find .route() call within service arg`)
        continue
      }
      debugLog(
        `  -> Found .route() call at line ${routeCall.startPosition.row + 1}`,
      )

      const routeArgs = routeCall.childForFieldName("arguments")
      const methodCall = routeArgs
        ?.descendantsOfType("call_expression")
        .find((call) => {
          const func = call.childForFieldName("function")
          if (func?.type === "scoped_identifier") {
            const scope = func.namedChildren[0]
            const name = func.namedChildren[1]
            return (
              scope?.text === "web" &&
              ["get", "post", "put", "delete", "patch"].includes(name?.text)
            )
          }
          return false
        })
      if (methodCall) {
        const methodFunc = methodCall.childForFieldName("function")
        method = methodFunc!.namedChildren[1].text.toUpperCase()
        debugLog(`  -> Found method web::${method.toLowerCase()}()`)
      } else {
        debugLog(`  -> Could not determine HTTP method within .route()`)
        continue
      }

      const toCall = serviceArgExpression
        .descendantsOfType("call_expression")
        .find((call) => {
          const func = call.childForFieldName("function")
          return (
            func?.type === "field_expression" &&
            func.childForFieldName("field")?.text === "to"
          )
        })
      if (!toCall) {
        debugLog(`  -> Could not find .to() call within service arg`)
        continue
      }
      line = toCall.startPosition.row + 1
      debugLog(`  -> Found .to() call at line ${line}`)

      const toArgs = toCall.childForFieldName("arguments")
      const handlerArg = toArgs?.firstNamedChild
      if (handlerArg) {
        if (handlerArg.type === "identifier") {
          handler = getIdentifierText(handlerArg)
        } else if (handlerArg.type === "scoped_identifier") {
          handler = getScopedIdentifierText(handlerArg)
        } else if (handlerArg.type === "closure_expression") {
          const innerScopedCall =
            handlerArg.descendantsOfType("scoped_identifier")[0]
          if (innerScopedCall) {
            handler = getScopedIdentifierText(innerScopedCall)
          } else {
            handler = handlerArg.text
          }
        } else {
          handler = handlerArg.text
        }
        debugLog(`  -> Found handler: ${handler}`)
      } else {
        debugLog(`  -> Could not extract handler from .to()`)
        continue
      }

      if (method && handler) {
        const fullPath = joinPaths(baseScopePath, subPath)
        debugLog(
          `  -> SUCCESS: Adding route: ${method} ${fullPath} -> ${handler}`,
        )
        locations.push({
          file: filePath,
          line: line,
          method: method,
          path: fullPath,
          handler: handler,
          struct: structName,
        })
      }
    }
  }

  debugLog(`Finished parsing ${filePath}, found ${locations.length} routes.`)
  return locations
}

async function parseRustFiles(files: string[]): Promise<RustRouteLocation[]> {
  // ... implementation ...
  const allLocations: RustRouteLocation[] = []
  for (const f of files) {
    try {
      const src = await fs.readFile(f, "utf8")
      allLocations.push(...extractAllRoutesFromFile(src, f))
    } catch (err: any) {
      console.warn(`Skipping file ${f} due to error: ${err.message}`)
    }
  }
  return allLocations
}

// --- OpenAPI Parsing (Updated) ---
async function parseOpenApi(openapiPath: string): Promise<OpenApiRouteInfo[]> {
  const routes: OpenApiRouteInfo[] = []
  try {
    const raw = await fs.readFile(openapiPath, "utf8")
    const openapi = JSON.parse(raw)
    if (!openapi.paths) {
      throw new Error('No "paths" object found in OpenAPI file.')
    }

    for (const [path, methods] of Object.entries(
      openapi.paths as Record<string, any>,
    )) {
      for (const [method, opDetails] of Object.entries(
        methods as Record<string, any>,
      )) {
        if (
          [
            "get",
            "post",
            "put",
            "delete",
            "patch",
            "options",
            "head",
            "trace",
          ].includes(method.toLowerCase())
        ) {
          routes.push({
            path: normalizePath(path),
            method: method.toUpperCase(),
            // --- Extract schema details ---
            operationId: opDetails.operationId,
            summary: opDetails.summary,
            description: opDetails.description,
            parameters: opDetails.parameters, // Copy parameters array
            requestBody: opDetails.requestBody, // Copy requestBody object
            responses: opDetails.responses, // Copy responses object
          })
        }
      }
    }
  } catch (e: any) {
    console.error(`Error processing OpenAPI file ${openapiPath}: ${e.message}`)
    throw e
  }
  return routes
}

async function getAllRustFiles(dir: string): Promise<string[]> {
  // ... implementation ...
  let dirents: fs.Dirent[] = []
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true })
  } catch (err: any) {
    if (err.code !== "EACCES" && err.code !== "ENOENT") {
      console.warn(`Could not read directory ${dir}: ${err.message}`)
    }
    return []
  }
  const files = await Promise.all(
    dirents.map(async (dirent) => {
      const res = path.resolve(dir, dirent.name)
      if (
        dirent.name === "target" ||
        dirent.name.startsWith(".") ||
        dirent.name === "node_modules"
      ) {
        return []
      }
      return dirent.isDirectory()
        ? getAllRustFiles(res)
        : res.endsWith(".rs")
          ? [res]
          : []
    }),
  )
  return files.flat()
}

// --- Main Logic (Updated to use Trees and Analyze Handler) ---
if (require.main === module) {
  ;(async () => {
    const [, , openapiPath, routerDir] = process.argv
    // ... arg checking ...
    if (!openapiPath || !routerDir) {
      console.error(
        "Usage: node <script.js> <openapi_json_path> <router_source_directory>",
      )
      console.error(
        "Example: node script.js ./crates/openapi/spec/openapi_v1.json ./crates/router/src",
      ) // Point to src
      process.exit(1)
    }

    console.log(`Parsing OpenAPI spec: ${openapiPath}`)
    const openApiRoutes = await parseOpenApi(openapiPath)
    console.log(`Found ${openApiRoutes.length} routes in OpenAPI spec.`)

    console.log(`\nScanning and parsing Rust files in: ${routerDir}`)
    const rustFiles = await getAllRustFiles(routerDir) // Get file list first
    console.log(`Found ${rustFiles.length} Rust files to scan.`)
    // Parse all files and get locations + trees
    const { locations: parsedRustRouteLocations, trees: parsedTrees } =
      await parseRustFilesAndTrees(rustFiles)
    console.log(
      `Parsed ${parsedRustRouteLocations.length} potential route definitions from Rust code.`,
    )

    const mergedRouteInfo: RustRouteLocation[] = []
    const matchedRustIndices = new Set<number>()
    // ... counters (uniqueMatches, etc.) ...
    let uniqueMatches = 0 // Count of OpenAPI routes with exactly one Rust match
    let missingImplementations = 0 // Count of OpenAPI routes with zero Rust matches
    let ambiguousMatches = 0 // Count of OpenAPI routes with more than one Rust match
    let rustOnlyCount = 0 // Count of Rust routes not in OpenAPI

    console.log("\n--- Matching OpenAPI Routes and Analyzing Handlers ---")

    for (const apiRoute of openApiRoutes) {
      const matchingRustRoutesIndices: number[] = []
      // ... find matching indices ...
      parsedRustRouteLocations.forEach((rustRoute, index) => {
        if (
          rustRoute.path === apiRoute.path &&
          rustRoute.method === apiRoute.method
        ) {
          matchingRustRoutesIndices.push(index)
        }
      })

      // ... logging OpenAPI route ...
      console.log(
        `\nOpenAPI: ${apiRoute.method} ${apiRoute.path}` +
          ` (OpId: ${apiRoute.operationId || "N/A"}, Summary: ${apiRoute.summary || "N/A"})`,
      )

      if (matchingRustRoutesIndices.length === 0) {
        // ... handle missing implementation (add placeholder with OpenAPI data) ...
        console.log("  -> No matching implementation found.")
        missingImplementations++
        // Don't add missing implementations to the final list for Vespa
        // mergedRouteInfo.push({ ... });
      } else {
        const isAmbiguous = matchingRustRoutesIndices.length > 1
        // ... handle ambiguous/unique logging ...
        if (isAmbiguous) {
          console.log(
            `  -> Found AMBIGUOUS implementations (${matchingRustRoutesIndices.length}):`,
          )
          ambiguousMatches++
        } else {
          console.log(`  -> Found unique implementation:`)
          uniqueMatches++
        }

        for (const index of matchingRustRoutesIndices) {
          if (matchedRustIndices.has(index)) continue
          const rustMatch = parsedRustRouteLocations[index]
          matchedRustIndices.add(index)

          // --- Analyze the handler ---
          const analysisResult = analyzeHandler(rustMatch.handler, parsedTrees)
          // --- ---

          const merged: RustRouteLocation = {
            ...rustMatch,
            // --- Merge OpenAPI Data ---
            openapi_summary: apiRoute.summary,
            openapi_description: apiRoute.description,
            openapi_operationId: apiRoute.operationId,
            openapi_parameters: apiRoute.parameters,
            openapi_requestBody: apiRoute.requestBody,
            openapi_responses: apiRoute.responses,
            // --- Merge Analysis Data ---
            handler_source_file: analysisResult.handler_source_file,
            handler_source_line: analysisResult.handler_source_line,
            handler_dependencies: analysisResult.handler_dependencies,
            handler_keywords: analysisResult.handler_keywords,
            // --- Set Status Flags ---
            is_ambiguous: isAmbiguous,
            not_in_openapi: false, // Explicitly false as it matched
          }
          mergedRouteInfo.push(merged)

          // ... logging Rust match details ...
          if (isAmbiguous)
            console.log(
              `     [Ambiguous] Handler: ${rustMatch.handler}, File: ${rustMatch.file}:${rustMatch.line}`,
            )
          else {
            console.log(`     Handler: ${rustMatch.handler}`)
            console.log(`     File:    ${rustMatch.file}:${rustMatch.line}`)
            if (analysisResult.handler_source_file) {
              console.log(
                `     Handler Def: ${analysisResult.handler_source_file}:${analysisResult.handler_source_line || "?"}`,
              )
            }
            if (
              analysisResult.handler_dependencies &&
              analysisResult.handler_dependencies.length > 0
            ) {
              console.log(
                `     Deps:    [${analysisResult.handler_dependencies.slice(0, 5).join(", ")}${analysisResult.handler_dependencies.length > 5 ? ", ..." : ""}]`,
              )
            }
            if (
              analysisResult.handler_keywords &&
              analysisResult.handler_keywords.length > 0
            ) {
              console.log(
                `     Keywords:[${analysisResult.handler_keywords.join(", ")}]`,
              )
            }
          }
        }
      }
    }

    // Add unmatched Rust routes (and analyze their handlers)
    parsedRustRouteLocations.forEach((rustRoute, index) => {
      if (!matchedRustIndices.has(index)) {
        rustOnlyCount++ // Increment counter
        const analysisResult = analyzeHandler(rustRoute.handler, parsedTrees) // Analyze handler
        // Temporarily add the object with the flag for filtering later
        mergedRouteInfo.push({
          ...rustRoute, // Keep original Rust info
          openapi_summary: "[No OpenAPI Definition Found]", // Indicate missing OpenAPI
          // Add analysis results
          handler_source_file: analysisResult.handler_source_file,
          handler_source_line: analysisResult.handler_source_line,
          handler_dependencies: analysisResult.handler_dependencies,
          handler_keywords: analysisResult.handler_keywords,
          // Set flags for filtering
          is_ambiguous: false, // Cannot be ambiguous if not in OpenAPI
          not_in_openapi: true, // Mark as not found in OpenAPI
          // Ensure JSON fields are null/undefined for consistency
          openapi_parameters: undefined,
          openapi_requestBody: undefined,
          openapi_responses: undefined,
        })
        matchedRustIndices.add(index) // Mark as processed
      }
    })

    // --- Filter out ambiguous and OpenAPI-missing routes ---
    const finalMergedRouteInfo = mergedRouteInfo.filter(
      (doc) => !doc.is_ambiguous && !doc.not_in_openapi,
    )
    console.log(
      `\nFiltered out ${mergedRouteInfo.length - finalMergedRouteInfo.length} ambiguous or OpenAPI-missing routes.`,
    )

    // --- Generate docId, combined_text, and Insert into Vespa ---
    const vespaDocs: VespaCodeApiDocs[] = [] // Use correct type
    finalMergedRouteInfo.forEach((doc) => {
      // Generate docId (ensure uniqueness)
      // Use a combination like method + path + file hash? For now, just path + method.
      // Needs to be unique. Consider adding file hash if needed.
      const docId =
        `${doc.method}-${doc.path}-${path.basename(doc.file || "unknown")}`.replace(
          /[^a-zA-Z0-9-_]/g,
          "_",
        ) // Basic sanitization

      // Create combined_text field
      const combined_text = [
        doc.path,
        doc.method,
        doc.handler,
        doc.struct,
        doc.openapi_summary,
        doc.openapi_description,
        doc.openapi_operationId,
        ...(doc.handler_dependencies || []),
        ...(doc.handler_keywords || []),
      ]
        .filter(Boolean)
        .join(" ") // Join non-null/empty strings

      const vespaDoc: VespaCodeApiDocs = {
        // Use correct type
        docId: docId,
        path: doc.path,
        method: doc.method,
        handler: doc.handler,
        app: Apps.Code,
        entity: CodeEntity.ApiDocs,
        file: doc.file,
        line: doc.line,
        struct: doc.struct,
        openapi_summary: doc.openapi_summary,
        openapi_description: doc.openapi_description,
        openapi_operationId: doc.openapi_operationId,
        openapi_parameters_json: doc.openapi_parameters
          ? JSON.stringify(doc.openapi_parameters)
          : undefined,
        openapi_requestBody_json: doc.openapi_requestBody
          ? JSON.stringify(doc.openapi_requestBody)
          : undefined,
        openapi_responses_json: doc.openapi_responses
          ? JSON.stringify(doc.openapi_responses)
          : undefined,
        handler_source_file: doc.handler_source_file,
        handler_source_line: doc.handler_source_line,
        handler_dependencies: doc.handler_dependencies,
        handler_keywords: doc.handler_keywords,
        combined_text: combined_text,
      }
      vespaDocs.push(vespaDoc)
    })

    // Insert documents into Vespa
    console.log(
      `\nAttempting to insert ${vespaDocs.length} API docs documents into Vespa...`,
    )
    try {
      // Consider batching if inserting many documents
      for (const vespaDoc of vespaDocs) {
        await insert(vespaDoc, codeApiDocsSchema) // Use correct schema name
      }
      console.log(`Successfully inserted ${vespaDocs.length} documents.`)
    } catch (error) {
      console.error("Error inserting API docs documents into Vespa:", error)
    }

    // ... Summary logging ...
    console.log("\n--- Summary ---")
    console.log(`Total OpenAPI Routes Processed: ${openApiRoutes.length}`)
    console.log(` -> Unique Matches (1 OpenAPI -> 1 Rust): ${uniqueMatches}`)
    console.log(
      ` -> Ambiguous Matches (1 OpenAPI -> >1 Rust): ${ambiguousMatches}`,
    ) // Count based on OpenAPI routes
    console.log(
      ` -> Missing Implementations (1 OpenAPI -> 0 Rust): ${missingImplementations}`,
    )
    console.log(
      `Total Rust Routes Parsed:       ${parsedRustRouteLocations.length}`,
    )
    console.log(` -> Rust Routes NOT in OpenAPI: ${rustOnlyCount}`)
    console.log(
      `Total Merged Entries BEFORE Filtering: ${mergedRouteInfo.length}`,
    )
    console.log(
      `Total Merged Entries AFTER Filtering (for Vespa): ${vespaDocs.length}`,
    ) // Use vespaDocs length

    console.log(
      "\n--- Merged Route Information (JSON Example - Filtered for Vespa) ---",
    )
    // Find an example from the prepared Vespa docs
    const exampleEntry = vespaDocs.find(
      (r) => r.handler_dependencies && r.handler_dependencies.length > 0,
    )
    const firstEntry =
      vespaDocs.length > 0
        ? vespaDocs[0]
        : { info: "No routes found or merged after filtering." }
    console.log(JSON.stringify(exampleEntry ?? firstEntry, null, 2))

    // --- Writing to file is now optional, as data is inserted directly ---
    // const outputFilename = 'merged_api_docs_filtered.json';
    // fs.writeFileSync(outputFilename, JSON.stringify(vespaDocs, null, 2));
    // console.log(`\nFiltered route information written to ${outputFilename}`);
  })().catch((err) => {
    console.error("Error during route analysis script execution:", err)
    process.exit(1)
  })
}

// --- Helper Functions (getScopedIdentifierText, etc. - include necessary ones) ---
// ... include getScopedIdentifierText, getStringLiteralText, getIdentifierText, findFirstNamedChild, findDescendantOfType ...
// ... parseOpenApi, getAllRustFiles ...
