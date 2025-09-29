import { getLogger, getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
const loggerWithChild = getLoggerWithChild(Subsystem.WorkflowApi)
const Logger = getLogger(Subsystem.WorkflowApi)

enum ScriptLanguage {
  Python = "python",
  JavaScript = "javascript",
  R = "r"
}


interface ScriptExecutionInput {
  type: "restricted" | "complete"
  language: ScriptLanguage
  script: string
  input?: Record<string, any>
  config?: Record<string, any>
}

interface ScriptExecutionOutput {
  success: boolean
  output: Record<string, any>
  consoleLogs?: string
  error: string | null
  exitCode: number
}

const timeout_value = 20

// Bubblewrap sandbox toggle from environment
const USE_BUBBLEWRAP = process.env.USE_BUBBLEWRAP === 'true'


function validateJson(obj: any): string | null {
  try {
    if (typeof obj === 'string') {
      let processedJson = obj.trim()
      
      const escapeCharRegex = /\\[nrtfb"\\]/g
      
      if (escapeCharRegex.test(processedJson)) {
        processedJson = processedJson
          .replace(/\\n/g, '\\\\n')         // \n -> \\n
          .replace(/\\r/g, '\\\\r')         // \r -> \\r
          .replace(/\\t/g, '\\\\t')         // \t -> \\t
          .replace(/\\f/g, '\\\\f')         // \f -> \\f
          .replace(/\\b/g, '\\\\b')         // \b -> \\b
          .replace(/\\"/g, '\\\\"')         // \" -> \\"
          .replace(/\\\\/g, '\\\\\\\\')     // \\ -> \\\\
      }
      
      // Try to parse the processed JSON
      const parsed = JSON.parse(processedJson)
      // Return the object if it's a valid object type, otherwise null
      if (typeof parsed === 'object' && parsed !== null) {
        return processedJson
      } else {
        return null
      }
    } else {
      if (typeof obj === 'object' && obj !== null) {
        try {
          return JSON.stringify(obj)
        } catch (stringifyError) {
          return null
        }
      } else {
        return null
      }
    }
  } catch (error) {
    // If any parsing or validation fails, return null
    return null
  }
}

interface LanguageConfig {
  commentKeyword: string
  printStatement: (arg: string) => string
  fileExtension: string
  runCommand: string
  allowedImports: string[]
  restrictedKeywords: string[]
  getDataParser: (input: Record<string, any>, config: Record<string, any>) => { inputCode: string, configCode: string, inputComment: string, configComment: string }
  getFunctionDefinition: (inputVar1?: string, inputVar2?: string) => { start: string, end: string, call: string }
}

function getLanguageConfig(language: ScriptLanguage): LanguageConfig {
  switch (language) {
    case ScriptLanguage.Python:
      return {
        commentKeyword: "#",
        printStatement: (arg: string) => `print(${arg})`,
        fileExtension: "py",
        runCommand: "python3",
        allowedImports: [
          "json", "math", "datetime", "random", "re", "collections", 
          "itertools", "functools", "operator", "string", "uuid",
          "hashlib", "base64", "urllib.parse", "statistics", "requests",
          "urllib", "http", "urllib.request", "urllib.error", "http.client"
        ],
        restrictedKeywords: [
           "import os","from os", "import sys", "import subprocess", "import socket",
           "from sys", "from subprocess", "exec", "eval", "open(", "file(","dir(",
          "__import__", "importlib", "globals(", "locals(", "vars(", 
          "getattr(", "setattr(", "hasattr(", "delattr(", "compile("
        ],
        getDataParser: (input: Record<string, any>, config: Record<string, any>) => {
          const inputJsonString = JSON.stringify(input)
          const configJsonString = JSON.stringify(config)
          return {
            inputCode: `import json
inputRaw = ${inputJsonString}
inputData = json.loads(inputRaw)
`,
            configCode: `configRaw = '${configJsonString}'
config = json.loads(configRaw)
`,
            inputComment: `to access values you can access as -> inputData['name']`,
            configComment: `to access values you can access as -> config['theme']`
          }
        },
        getFunctionDefinition: (inputVar1: string = "inputData", inputVar2: string = "config") => ({
          start: `def execute(${inputVar1}={}, ${inputVar2}={}):`,
          end: ``,
          call: `script_result_ = execute(${inputVar1}, ${inputVar2})`
        })
      }
    
    case ScriptLanguage.JavaScript:
      return {
        commentKeyword: "//",
        printStatement: (arg: string) => `console.log(${arg})`,
        fileExtension: "js",
        runCommand: "node",
        allowedImports: [
          "Math", "Date", "JSON", "Array", "Object", "String",
          "Number", "Boolean", "RegExp", "Set", "Map", "Promise",
          "fetch", "axios", "https", "http"
        ],
        restrictedKeywords: [
          "require(", "import(", "eval(", "Function(", "process.",
          "global.", "Buffer.", "fs.", "child_process", "net.",
          "import ", "import{", "import*", "import.", "import\n",
          "export ", "module.", "window.", "globalThis.", "self.",
          "importScripts(", "Worker(", "SharedWorker("
        ],
        getDataParser: (input: Record<string, any>, config: Record<string, any>) => {
          const inputJsonString = JSON.stringify(input)
          const configJsonString = JSON.stringify(config)
          return {
            inputCode: `const inputRaw = ${inputJsonString};
const inputData = JSON.parse(inputRaw);
`,
            configCode: `const configRaw = '${configJsonString}';
const config = JSON.parse(configRaw);
`,
            inputComment: `to access values you can access as -> inputData.name`,
            configComment: `to access values you can access as -> config.theme`
          }
        },
        getFunctionDefinition: (inputVar1: string = "inputData", inputVar2: string = "config") => ({
          start: `function execute(${inputVar1} = {}, ${inputVar2} = {}) {`,
          end: `}`,
          call: `const script_result_ = execute(${inputVar1}, ${inputVar2});`
        })
      }
    
    case ScriptLanguage.R:
      return {
        commentKeyword: "#",
        printStatement: (arg: string) => `print(toJSON(${arg}))`,
        fileExtension: "R",
        runCommand: "Rscript",
        allowedImports: [
          "jsonlite", "base", "stats", "utils", "graphics", "grDevices",
          "methods", "datasets", "stringr", "lubridate", "dplyr", 
          "httr", "RCurl", "curl"
        ],
        restrictedKeywords: [
          "system(", "system2(", "shell(", "Sys.setenv", "source(",
          "load(", "save(", "file.create", "file.remove", "unlink(",
          "attach(", "detach(", "require(", "loadNamespace(",
          "eval(", "parse(", "do.call(", "assign(", "exists("
        ],
        getDataParser: (input: Record<string, any>, config?: Record<string, any>) => {
          const inputJsonString = JSON.stringify(input)
          const configJsonString = config? JSON.stringify(config):""
          return {
            inputCode: `inputRaw <- ${inputJsonString}
library(jsonlite)
inputData <- fromJSON(inputRaw)
`,
            configCode: config?`configRaw <- '${configJsonString}'
config <- fromJSON(configRaw)
`:"",
            inputComment: `to access values you can access as -> inputData$name`,
            configComment: `to access values you can access as -> config$theme`
          }
        },
        getFunctionDefinition: (inputVar1: string = "inputData", inputVar2: string = "config") => ({
          start: `execute <- function(${inputVar1} = list(), ${inputVar2} = list()) {`,
          end: `}`,
          call: `script_result_ <- execute(${inputVar1}, ${inputVar2})`
        })
      }
    
    default:
      return {
        commentKeyword: "",
        printStatement: () => "",
        fileExtension: "txt",
        runCommand: "",
        allowedImports: [],
        restrictedKeywords: [],
        getDataParser: () => ({ inputCode: "", configCode: "", inputComment: "", configComment: "" }),
        getFunctionDefinition: () => ({ start: "", end: "", call: "" })
      }
  }
}

function validateScriptSecurity(script: string, language: ScriptLanguage): { isValid: boolean, violations: string[] } {
  const config = getLanguageConfig(language)
  const violations: string[] = []
  
  // Check for restricted keywords
  for (const keyword of config.restrictedKeywords) {
    if (script.includes(keyword)) {
      violations.push(`Restricted keyword detected: ${keyword}`)
    }
  }
  
  // Language-specific import validation
  switch (language) {
    case ScriptLanguage.Python:
      // Check standard Python imports
      const pythonImportRegex = /^[ \t]*(?:import|from)\s+([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)/gm
      let pythonMatch
      while ((pythonMatch = pythonImportRegex.exec(script)) !== null) {
        const importName = pythonMatch[1].split('.')[0]
        if (!config.allowedImports.includes(importName)) {
          violations.push(`Unauthorized import: ${pythonMatch[1]}`)
        }
      }

      // Check for __import__ usage
      const importFuncRegex = /__import__\s*\(\s*['""]([^'""]+)['""][^)]*\)/g
      let importFuncMatch
      while ((importFuncMatch = importFuncRegex.exec(script)) !== null) {
        const moduleName = importFuncMatch[1]
        if (!config.allowedImports.includes(moduleName)) {
          violations.push(`Unauthorized __import__: ${moduleName}`)
        }
      }

      // Check for importlib usage
      const importlibRegex = /importlib\.import_module\s*\(\s*['""]([^'""]+)['""][^)]*\)/g
      let importlibMatch
      while ((importlibMatch = importlibRegex.exec(script)) !== null) {
        const moduleName = importlibMatch[1]
        if (!config.allowedImports.includes(moduleName)) {
          violations.push(`Unauthorized importlib.import_module: ${moduleName}`)
        }
      }
      break
      
    case ScriptLanguage.JavaScript:
      // Check JavaScript require statements
      const jsRequireRegex = /^[ \t]*(?:const|let|var)?\s*.*?require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/gm
      let jsMatch
      while ((jsMatch = jsRequireRegex.exec(script)) !== null) {
        const moduleName = jsMatch[1]
        if (!config.allowedImports.includes(moduleName)) {
          violations.push(`Unauthorized require: ${moduleName}`)
        }
      }

      // Check ES6 import statements
      const es6ImportRegex = /^[ \t]*import\s+(?:[^'"`\n]+\s+from\s+)?['"`]([^'"`]+)['"`]/gm
      let es6Match
      while ((es6Match = es6ImportRegex.exec(script)) !== null) {
        const moduleName = es6Match[1]
        if (!config.allowedImports.includes(moduleName)) {
          violations.push(`Unauthorized ES6 import: ${moduleName}`)
        }
      }

      // Check dynamic import()
      const dynamicImportRegex = /import\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g
      let dynamicMatch
      while ((dynamicMatch = dynamicImportRegex.exec(script)) !== null) {
        const moduleName = dynamicMatch[1]
        if (!config.allowedImports.includes(moduleName)) {
          violations.push(`Unauthorized dynamic import: ${moduleName}`)
        }
      }
      break
      
    case ScriptLanguage.R:
      // Check R library/require statements
      const rLibraryRegex = /^[ \t]*(?:library|require)\s*\(\s*([a-zA-Z][a-zA-Z0-9.]*)\s*\)/gm
      let rMatch
      while ((rMatch = rLibraryRegex.exec(script)) !== null) {
        const libraryName = rMatch[1]
        if (!config.allowedImports.includes(libraryName)) {
          violations.push(`Unauthorized library: ${libraryName}`)
        }
      }

      // Check R library with quotes
      const rLibraryQuotedRegex = /^[ \t]*(?:library|require)\s*\(\s*['"]([a-zA-Z][a-zA-Z0-9.]*)['\"]\s*\)/gm
      let rQuotedMatch
      while ((rQuotedMatch = rLibraryQuotedRegex.exec(script)) !== null) {
        const libraryName = rQuotedMatch[1]
        if (!config.allowedImports.includes(libraryName)) {
          violations.push(`Unauthorized library: ${libraryName}`)
        }
      }

      // Check loadNamespace usage
      const rLoadNamespaceRegex = /loadNamespace\s*\(\s*['"]?([a-zA-Z][a-zA-Z0-9.]*)['"]?\s*\)/g
      let rLoadMatch
      while ((rLoadMatch = rLoadNamespaceRegex.exec(script)) !== null) {
        const libraryName = rLoadMatch[1]
        if (!config.allowedImports.includes(libraryName)) {
          violations.push(`Unauthorized loadNamespace: ${libraryName}`)
        }
      }
      break
  }
  
  return {
    isValid: violations.length === 0,
    violations
  }
}


async function generateScript(script: string, language: ScriptLanguage, input: Record<string, any>, config?: Record<string, any>): Promise<{ success: boolean; filePath?: string; error?: string }> {
  const fs = require('fs').promises
  const path = require('path')
  const { randomUUID } = require('crypto')
  
  // Use empty objects as defaults and validate if input is provided
  const validatedInput = validateJson(input)
  const inputData = validatedInput || {}
  const configData = config || {}
  if (input && !validatedInput) {
    return { success: false, error: "Invalid input: must be a valid JSON object" }
  }
  
  // Validate script security
  const securityValidation = validateScriptSecurity(script, language)
  if (!securityValidation.isValid) {
    return { success: false, error: `Security validation failed: ${securityValidation.violations.join(', ')}` }
  }
  
  // Get parser code and comment
  const langConfig = getLanguageConfig(language)
  const dataParser = langConfig.getDataParser(inputData, configData)
  const functionDefinition = langConfig.getFunctionDefinition("inputData", "config")
  
  if (functionDefinition.start=="") {
    return { success: false, error: `Unsupported language: ${language}` }
  }

  // Add indentation to user script
  const indentedScript = script
    .split('\n')
    .map(line => line.trim() ? `  ${line}` : line)
    .join('\n')

  const combinedScript = `
${dataParser.inputCode}
${dataParser.configCode}
${functionDefinition.start}
${indentedScript}
${functionDefinition.end}
${functionDefinition.call}
${langConfig.printStatement("\"=== OUTPUT_STATEMENT_START ===\"")}
${langConfig.printStatement("script_result_")}
`;
  
  // Determine file extension
  const extension = langConfig.fileExtension;
  
  // Create script_executor_utils directory and file
  try {
    const tempDir = path.join(process.cwd(), "script_executor_utils")
    await fs.mkdir(tempDir, { recursive: true })
    
    const fileName = `script_${randomUUID()}.${extension}`
    const filePath = path.join(tempDir, fileName)
    
    // Write file
    await fs.writeFile(filePath, combinedScript, "utf8")
    
    return { success: true, filePath }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error creating script file' }
  }
}


function formatScriptOutput(rawOutput: string, language: ScriptLanguage): Record<string, any> {
  try {
    return JSON.parse(rawOutput)
  } catch (directParseError) {
    let languageResult: Record<string, any> | false = false
    
    switch (language) {
      case ScriptLanguage.Python:
        languageResult = formatPythonOutput(rawOutput)
        break
      
      case ScriptLanguage.JavaScript:
        languageResult = formatJavaScriptOutput(rawOutput)
        break
      
      case ScriptLanguage.R:
        languageResult = formatROutput(rawOutput)
        break
      
      default:
        languageResult = false
    }
    
    return languageResult !== false ? languageResult : { message: "not able to parse as json returning raw output", value: rawOutput }
  }
}

function formatPythonOutput(rawOutput: string): Record<string, any> | false {
  try {
    let cleaned = rawOutput.trim()
    
    // Handle Python dict/list format
    if ((cleaned.startsWith('{') && cleaned.endsWith('}')) || 
        (cleaned.startsWith('[') && cleaned.endsWith(']'))) {
      
      // Convert Python syntax to JSON
      cleaned = cleaned
        .replace(/'/g, '"')           // Single quotes to double quotes
        .replace(/\bTrue\b/g, 'true') // Python True to JSON true
        .replace(/\bFalse\b/g, 'false') // Python False to JSON false
        .replace(/\bNone\b/g, 'null')   // Python None to JSON null
      
      return JSON.parse(cleaned)
    }
    
    // If not a dict/list, return false to indicate unable to parse
    return false
  } catch (error) {
    return false
  }
}

function formatJavaScriptOutput(rawOutput: string): Record<string, any> | false {
  try {
    let cleaned = rawOutput.trim()
    
    // Handle JavaScript object literal format
    if ((cleaned.startsWith('{') && cleaned.endsWith('}')) || 
        (cleaned.startsWith('[') && cleaned.endsWith(']'))) {
      
      // Fix JavaScript object literal to valid JSON
      cleaned = cleaned
        // Handle unquoted property names (but not when inside strings)
        .replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":')
        // Convert single quotes to double quotes (but handle escaped quotes)
        .replace(/'/g, '"')
        // Remove trailing commas before closing braces/brackets
        .replace(/,(\s*[}\]])/g, '$1')
        // Handle undefined values
        .replace(/:\s*undefined/g, ': null')
      
      return JSON.parse(cleaned)
    }
    
    return false
  } catch (error) {
    // If the above cleaning didn't work, try a more aggressive approach
    try {
      let aggressiveCleaned = rawOutput.trim()
      
      if ((aggressiveCleaned.startsWith('{') && aggressiveCleaned.endsWith('}')) || 
          (aggressiveCleaned.startsWith('[') && aggressiveCleaned.endsWith(']'))) {
        
        // More comprehensive cleaning for complex nested objects
        aggressiveCleaned = aggressiveCleaned
          // Replace unquoted keys with quoted keys (more precise regex)
          .replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":')
          // Convert single quotes to double quotes
          .replace(/'/g, '"')
          // Handle trailing commas
          .replace(/,(\s*[}\]])/g, '$1')
          // Handle undefined
          .replace(/:\s*undefined/g, ': null')
          // Clean up any remaining issues with spacing
          .replace(/"\s*:\s*"/g, '":"')
        
        return JSON.parse(aggressiveCleaned)
      }
      
      return false
    } catch (secondError) {
      return false
    }
  }
}

function formatROutput(rawOutput: string): Record<string, any> | false {
  try {
    let cleaned = rawOutput.trim()
    
    // Handle R toJSON output - look for JSON object in the output
    const jsonMatch = cleaned.match(/\{.*\}/)
    if (jsonMatch) {
      const jsonPart = jsonMatch[0]
      const parsed = JSON.parse(jsonPart)
      
      // R toJSON wraps single values in arrays, so unwrap them
      const unwrapped: Record<string, any> = {}
      for (const [key, value] of Object.entries(parsed)) {
        if (Array.isArray(value) && value.length === 1) {
          unwrapped[key] = value[0]
        } else {
          unwrapped[key] = value
        }
      }
      
      return unwrapped
    }
    
    // Handle R list() output format like "$key\n[1] value"
    if (cleaned.includes('$') && cleaned.includes('[1]')) {
      const result: Record<string, any> = {}
      const sections = cleaned.split(/\n\n|\n(?=\$)/)
      
      for (const section of sections) {
        const lines = section.trim().split('\n')
        if (lines.length >= 2) {
          const keyMatch = lines[0].match(/^\$(\w+)/)
          if (keyMatch) {
            const key = keyMatch[1]
            const valueLine = lines[1]
            
            // Extract value from R format like '[1] "value"' or '[1] 123'
            const stringMatch = valueLine.match(/\[1\]\s*"([^"]*)"/)
            const numberMatch = valueLine.match(/\[1\]\s*(\d+\.?\d*)/)
            
            if (stringMatch) {
              result[key] = stringMatch[1]
            } else if (numberMatch) {
              const numValue = numberMatch[1]
              result[key] = numValue.includes('.') ? parseFloat(numValue) : parseInt(numValue)
            }
          }
        }
      }
      
      return Object.keys(result).length > 0 ? result : false
    }
    
    return false
  } catch (error) {
    return false
  }
}

function createBubblewrapArgs(scriptPath: string): string[] {
  const path = require('path')

  // Minimal bubblewrap arguments for containers
  const baseArgs = [
    // Basic mounts without namespaces
    '--dev-bind', '/', '/',

    // Set working directory
    '--chdir', path.dirname(scriptPath),

    // Die with parent
    '--die-with-parent'
  ]

  return baseArgs
}

export async function executeScript(
  executionInput: ScriptExecutionInput
): Promise<ScriptExecutionOutput> {
  const { spawn } = require('child_process')
  const fs = require('fs').promises
  
  let scriptPath = ''
  
  try {
    // Generate the script file
    const scriptGenResult = await generateScript(
      executionInput.script,
      executionInput.language,
      executionInput.input || {},
      executionInput.config || {}
    )
    
    if (!scriptGenResult.success) {
      return {
        success: false,
        output: {},
        error: scriptGenResult.error || 'Script generation failed',
        exitCode: -1
      }
    }
    
    scriptPath = scriptGenResult.filePath!
    
    // Get the run command
    const langConfig = getLanguageConfig(executionInput.language)
    const runCommand = `${langConfig.runCommand} ${scriptPath}`.trim()

    if (!runCommand) {
      return {
        success: false,
        output: {},
        error: `Unsupported language: ${executionInput.language}`,
        exitCode: -1
      }
    }
    
    // Parse command and arguments
    let [command, ...args] = runCommand.split(' ')

    // Apply bubblewrap sandbox if enabled
    if (USE_BUBBLEWRAP) {
      const bubblewrapArgs = createBubblewrapArgs(scriptPath)
      const originalCommand = command
      const originalArgs = args
      command = 'bwrap'
      args = [...bubblewrapArgs, originalCommand, ...originalArgs]
    } else {
      Logger.info(`Running without sandbox: ${command} ${args.join(' ')}`)
    }

    return new Promise((resolve) => {
      const child = spawn(command, args, {
        timeout: timeout_value * 60 * 1000, // 1 minute timeout
        killSignal: 'SIGKILL'
      })
      
      let stdout = ''
      let stderr = ''
      
      child.stdout.on('data', (data: any) => {
        stdout += data.toString()
      })
      
      child.stderr.on('data', (data: any) => {
        stderr += data.toString()
      })
      
      child.on('close', async (code: any, signal: any) => {
        // Delete the script file after execution
        try {
          await fs.unlink(scriptPath)
        } catch (deleteError) {
          console.warn(`Failed to delete script file: ${scriptPath}`)
        }
        
        if (signal === 'SIGKILL') {
          resolve({
            success: false,
            output: { value: stdout },
            error: `Script execution timed out after ${timeout_value} minute`,
            exitCode: -1
          })
        } else if (code === 0) {
          // Split output by OUTPUT_STATEMENT_START marker
          const outputMarker = "=== OUTPUT_STATEMENT_START ==="
          const outputParts = stdout.split(outputMarker)
          
          let consoleLogs = ""
          let result: Record<string, any> = {}
          
          if (outputParts.length > 1) {
            // Everything before the marker is console logs
            consoleLogs = outputParts[0].trim()
            // Everything after the marker is the result
            const resultOutput = outputParts[1].trim()
            result = formatScriptOutput(resultOutput, executionInput.language)
            
          } else {
            // No marker found, treat entire output as console logs
            consoleLogs = stdout.trim()
          }
          
          resolve({
            success: true,
            output: result,
            consoleLogs: consoleLogs,
            error: null,
            exitCode: code
          })
        } else {
          resolve({
            success: false,
            output: { value: stdout },
            error: stderr,
            exitCode: code
          })
        }
      })
      
      child.on('error', async (error: any) => {
        // Delete the script file on error
        try {
          await fs.unlink(scriptPath)
        } catch (deleteError) {
          console.warn(`Failed to delete script file: ${scriptPath}`)
        }
        
        resolve({
          success: false,
          output: { value: stdout },
          error: error.message,
          exitCode: -1
        })
      })
      
    })
  } catch (error) {
    // Delete the script file if it was created but execution failed
    if (scriptPath) {
      try {
        await fs.unlink(scriptPath)
      } catch (deleteError) {
        Logger.warn(`Failed to delete script file: ${scriptPath}`)
      }
    }
    
    return {
      success: false,
      output: {},
      error: error instanceof Error ? error.message : 'Unknown error',
      exitCode: -1
    }
  }
}

export { ScriptLanguage }

export function getCodeWritingBlock(language: ScriptLanguage, input?: Record<string, any>, config?: Record<string, any>): string {
  const langConfig = getLanguageConfig(language)
  const dataParser = langConfig.getDataParser(input || {}, config || {})
  
  return `${langConfig.commentKeyword} ${dataParser.inputComment}
${langConfig.commentKeyword} ${dataParser.configComment}
${langConfig.commentKeyword} Allowed external packages list -> [${langConfig.allowedImports}]
${langConfig.commentKeyword} Write your code below this line and return the output as a JSON object`
}