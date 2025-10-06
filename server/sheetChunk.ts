import * as XLSX from "xlsx"

// Type checking utilities for spreadsheet data
function isTimestamp(value: any): boolean {
  if (typeof value === 'string') {
    // Check for ISO timestamp format (YYYY-MM-DDTHH:mm:ss.sssZ)
    const timestampRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}:\d{2})?$/
    if (timestampRegex.test(value)) {
      return !isNaN(Date.parse(value))
    }
    
    // Check for Unix timestamp (seconds or milliseconds since epoch)
    const numValue = Number(value)
    if (!isNaN(numValue)) {
      // Unix timestamp should be reasonable (between 1970 and 2100)
      const minTimestamp = 0 // 1970-01-01 in milliseconds (Unix epoch)
      const maxTimestamp = 4102444800000 // 2100-01-01 in milliseconds
      return numValue >= minTimestamp && numValue <= maxTimestamp
    }
  }
  
  // Check if it's a Date object
  if (value instanceof Date) {
    return !isNaN(value.getTime())
  }
  
  return false
}

function isDate(value: any): boolean {
  if (typeof value === 'string') {
    // Check for date-only format (YYYY-MM-DD, MM/DD/YYYY, DD/MM/YYYY, etc.)
    const dateRegex = /^\d{4}-\d{2}-\d{2}$|^\d{1,2}\/\d{1,2}\/\d{4}$|^\d{1,2}-\d{1,2}-\d{4}$/
    if (dateRegex.test(value)) {
      return !isNaN(Date.parse(value))
    }
  }
  
  if (value instanceof Date) {
    return !isNaN(value.getTime())
  }
  
  return false
}

function isTime(value: any): boolean {
  if (typeof value === 'string') {
    // Check for time-only format (HH:mm:ss, HH:mm, etc.)
    const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/
    return timeRegex.test(value)
  }
  
  return false
}

function isBoolean(value: any): boolean {
  if (typeof value === 'boolean') {
    return true
  }
  
  if (typeof value === 'string') {
    const lowerValue = value.toLowerCase().trim()
    return ['true', 'false', 'yes', 'no', 'y', 'n'].includes(lowerValue)
  }
  
  return false
}

interface ChunkConfig {
  maxChunkSize?: number
  maxRowsPerChunk?: number
  headerRows?: number
}

interface ChunkingState {
  headerRow: string
  maxRowsPerChunk: number
  maxChunkSize: number
  columnCount: number
}

interface ProcessedSheetData {
  headerRow: string[]
  dataRows: string[][]
}

// XLSX Processing Functions

function unmerge(sheet: XLSX.WorkSheet): void {
  (sheet['!merges'] ?? []).forEach((rng) => {
    const v = sheet[XLSX.utils.encode_cell({ r: rng.s.r, c: rng.s.c })]?.v
    for (let R = rng.s.r; R <= rng.e.r; R++) {
      for (let C = rng.s.c; C <= rng.e.c; C++) {
        sheet[XLSX.utils.encode_cell({ r: R, c: C })] = { t: "s", v }
      }
    }
  })
}

function buildHeaders(rows: any[][], headerRows = 1): { header: string[], dataRows: any[][] } {
  if (rows.length === 0) {
    return { header: [], dataRows: [] }
  }

  const header = rows.slice(0, headerRows)
    .reduce((acc, row) =>
      acc.map((prev, i) => `${prev}_${(row[i] ?? "").toString().trim()}`), 
      new Array(rows[0].length).fill("")
    )
    .map(h => h.replace(/_{2,}/g, "_").replace(/^_+|_+$/g, ""))

  return { 
    header, 
    dataRows: rows.slice(headerRows) 
  }
}

function guessHeaderRowsByDataTypes(rows: any[][], maxSearchRows = 3): number {
  const isHeterogeneousRow = (row: any[]) => {
    const types = row
      .filter(cell => cell !== null && cell !== undefined && cell.toString().trim() !== '')
      .map(cell => {
        if (typeof cell === 'number' || !isNaN(Number(cell)))
          return 'number'
        if (isDate(cell))
          return 'date'
        if (isTimestamp(cell))
          return 'timestamp'
        if (isTime(cell))
          return 'time'
        if (isBoolean(cell))
          return 'boolean'
        return 'string'
      })

    const uniqueTypes = new Set(types)
    return uniqueTypes.size >= 2 // Consider it heterogeneous if at least 2 types
  }

  for (let i = 0; i < Math.min(maxSearchRows, rows.length); i++) {
    if (isHeterogeneousRow(rows[i])) {
      return i // rows before this are likely headers
    }
  }

  return 1
}


function guessHeaderRowsByKeywords(rows: any[][], maxSearchRows = 3): number {
  const headerKeywords = ['name', 'id', 'date', 'type', 'category', 'description', 'amount', 'total', 'value', 'region', 'country', 'state', 'city', 'zip', 'address', 'phone', 'email', 'website', 'url', 'link', 'title', 'subtitle', 'summary', 'description', 'notes', 'comments', 'remarks', 'details', 'information', 'data', 'statistics', 'metrics', 'measures']
  const lowerKeywords = headerKeywords.map(k => k.toLowerCase())
  
  for (let i = 0; i < Math.min(maxSearchRows, rows.length); i++) {
    const row = rows[i]
    if (!row) continue
    
    const rowText = row.map(cell => (cell ?? '').toString().toLowerCase())
    
    // Count how many cells contain header keywords
    const keywordMatches = rowText.filter(cell => 
      lowerKeywords.some(kw => cell.includes(kw))
    ).length
    
    // Only consider it a header row if MOST cells contain keywords (not just one)
    const totalCells = rowText.filter(cell => cell.trim().length > 0).length
    if (totalCells > 0 && keywordMatches >= Math.ceil(totalCells * 0.6)) {
      return i + 1
    }
  }
  return 1
}

function inferHeaderRows(input: XLSX.WorkSheet, rows: any[][], isDummyHeader = false): number {
  let mergedHeaderRows = 1
    
  // Check actual merged cells in XLSX
  const merges = input['!merges'] ?? []
  let maxHeaderMergeRow = -1
  
  merges.forEach(rng => {
    // Only consider merges that START in the header area
    if (rng.s.r < 4 && rng.s.r > maxHeaderMergeRow) {
      maxHeaderMergeRow = rng.s.r
    }
  })
  mergedHeaderRows = maxHeaderMergeRow >= 0 ? maxHeaderMergeRow + 2 : 1
  mergedHeaderRows += isDummyHeader ? 1 : 0
  
  if (rows.length === 0) return 1

  const MAX_HEADER_ROWS = isDummyHeader ? 4 : 3

  // Heuristic 2: Analyze data type patterns
  const dataTypeHeaderRows = guessHeaderRowsByDataTypes(rows, MAX_HEADER_ROWS)

  // Heuristic 3: Look for header keywords
  const keywordHeaderRows = guessHeaderRowsByKeywords(rows, MAX_HEADER_ROWS)

  // Choose the maximum of these heuristics, but cap at reasonable limit
  const inferredRows = Math.max(mergedHeaderRows, dataTypeHeaderRows, keywordHeaderRows, 1)
  return Math.min(inferredRows, MAX_HEADER_ROWS)
}

function processSheetData(input: XLSX.WorkSheet, headerRowsParam?: number): ProcessedSheetData {
  let rows: any[][] = []
  try {
    // Use sheet_to_json with proper options to preserve empty cells and formatting
    rows = XLSX.utils.sheet_to_json<any[]>(input, { 
      header: 1,        // Generate array of arrays
      raw: false,       // Use formatted strings (not raw values)
      defval: "",       // Use empty string for null/undefined values
    })
  } catch (error) {
    console.error("Error converting sheet to JSON:", error)
    return { headerRow: [], dataRows: [] }
  }
  
  let headerRows = headerRowsParam ?? inferHeaderRows(input, rows)
  
  if (rows.length === 0) {
    return { headerRow: [], dataRows: [] }
  }

  const isHeaderValid = rows.slice(0, headerRows).every(row => isHeaderRowValid(row))
  if (!isHeaderValid) {
    const maxColumns = Math.max(...rows.map(row => row.length))
    const header = Array.from({ length: maxColumns }, (_, i) => `C${i + 1}`)
    rows = [header, ...rows]
    headerRows = inferHeaderRows(input, rows, true)
  }

  // Build composite headers and extract data normally
  const result = buildHeaders(rows, headerRows)
  const header = result.header
  const dataRows = result.dataRows
  
  // Filter out completely empty rows BEFORE adding row IDs
  const validDataRows = dataRows.filter(isRowValid)
  
  // Add row_id as first column and normalize data
  const fullHeader = ["row_id", ...header]
  const rowsWithId = validDataRows.map((row, index) => [
    (index + 1).toString(),
    ...row.map(cell => (cell ?? "").toString())
  ])
  
  // Clear references to help garbage collection
  rows = []
  
  return {
    headerRow: fullHeader,
    dataRows: rowsWithId
  }
}

// Helper Functions

/**
 * Calculates byte length of a string using UTF-8 encoding
 */
const getByteLength = (str: string): number => Buffer.byteLength(str, "utf8")

/**
 * Cleans illegal UTF-8 characters and normalizes line endings
 */
const cleanText = (str: string): string => {
  const normalized = str.replace(/\r\n|\r/g, "\n")
  return normalized.replace(
    /[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u009F\uFDD0-\uFDEF\uFFFE\uFFFF]/g,
    "",
  )
}

/**
 * Normalizes a row to ensure consistent column count and clean data
 */
function normalizeRow(row: string[], columnCount: number): string {
  const normalizedCells: string[] = []
  
  for (let i = 0; i < columnCount; i++) {
    const cell = row[i]
    if (cell === undefined || cell === null) {
      normalizedCells.push("")
    } else {
      const cellStr = cell.toString()
      const cleanedCell = cleanText(cellStr)
      normalizedCells.push(cleanedCell)
    }
  }
  
  return normalizedCells.join("\t")
}

/**
 * Validates if a row contains meaningful content
 */
function isRowValid(row: string[]): boolean {
  if (!Array.isArray(row) || row.length === 0) return false
  
  return row.some(cell => {
    if (cell === undefined || cell === null || cell === "") return false
    const cellStr = cell.toString().trim()
    return cellStr.length > 0
  })
}

/**
 * Validates if a header row has all cells filled (no empty, undefined, or null cells)
 */
function isHeaderRowValid(row: any[]): boolean {
  if (!Array.isArray(row) || row.length === 0) return false
  
  return row.every(cell => {
    if (cell === undefined || cell === null) return false
    const cellStr = cell.toString().trim()
    return cellStr.length > 0
  })
}

/**
 * Truncates string to specified byte length while preserving character boundaries
 */
function truncateToByteLength(str: string, limit: number): string {
  let bytes = 0
  let result = ''
  
  for (const char of str) {
    const charBytes = getByteLength(char)
    if (bytes + charBytes > limit) break
    result += char
    bytes += charBytes
  }
  
  return result
}

/**
 * Creates chunks from data rows with size and row limits
 */
function createChunks(dataRows: string[][], state: ChunkingState): string[] {
  const chunks: string[] = []
  let currentBatch: string[] = []

  for (const row of dataRows) {
    const normalizedRow = normalizeRow(row, state.columnCount)
    
    const potentialChunk = createChunkFromBatch(
      [...currentBatch, normalizedRow],
      state.headerRow
    )

    const wouldExceedRowLimit = currentBatch.length >= state.maxRowsPerChunk
    const wouldExceedSizeLimit = getByteLength(potentialChunk) > state.maxChunkSize

    if ((wouldExceedRowLimit || wouldExceedSizeLimit) && currentBatch.length > 0) {
      chunks.push(createChunkFromBatch(currentBatch, state.headerRow))
      
      // Handle rows that exceed size limit
      if (getByteLength(normalizedRow) > state.maxChunkSize) {
        const truncatedRow = truncateToByteLength(
          normalizedRow, 
          state.maxChunkSize - getByteLength(state.headerRow) - 1
        )
        chunks.push(createChunkFromBatch([truncatedRow], state.headerRow))
        currentBatch = []
      } else {
        currentBatch = [normalizedRow]
      }
    } else {
      currentBatch.push(normalizedRow)
    }
  }

  if (currentBatch.length > 0) {
    chunks.push(createChunkFromBatch(currentBatch, state.headerRow))
  }

  return chunks
}

/**
 * Creates a single chunk from batch of rows and header
 */
function createChunkFromBatch(batch: string[], headerRow: string): string {
  if (batch.length === 0) return headerRow
  return [headerRow, ...batch].join("\n")
}

function normalizeToWorksheet(input: string[][] | XLSX.WorkSheet): XLSX.WorkSheet {
  if (Array.isArray(input)) {
    return XLSX.utils.aoa_to_sheet(input)
  }
  return input
}

// Main Export Functions

/**
 * Chunks spreadsheet data with intelligent header preservation
 * Applies smart processing to both XLSX WorkSheet objects and string[][] arrays
 * - Smart header detection with multiple heuristics
 * - Multi-row header flattening
 * - Row ID addition for traceability
 * - Merged cell handling (XLSX only)
 * - Adaptive chunking for wide spreadsheets
 */
export function chunkSheetWithHeaders(
  input: string[][] | XLSX.WorkSheet,
  config?: ChunkConfig,
): string[] {
  let worksheet: XLSX.WorkSheet | null = null
  let processedData: ProcessedSheetData | null = null
  
  try {
    // Process input with unified smart logic
    worksheet = normalizeToWorksheet(input)
    unmerge(worksheet)
    processedData = processSheetData(worksheet, config?.headerRows)
    const { headerRow, dataRows } = processedData

    if (headerRow.length === 0) {
      return []
    }

    // Configuration with sensible defaults
    const maxChunkSize = config?.maxChunkSize ?? 1024
    const maxRowsPerChunk = config?.maxRowsPerChunk ?? 10

    const columnCount = headerRow.length
    
    // Adaptive chunking for wide spreadsheets
    const adaptiveMaxRowsPerChunk = columnCount > 15 
      ? Math.max(3, Math.floor(maxRowsPerChunk * 0.6)) 
      : maxRowsPerChunk

    const state: ChunkingState = {
      headerRow: normalizeRow(headerRow, columnCount),
      maxRowsPerChunk: adaptiveMaxRowsPerChunk,
      maxChunkSize,
      columnCount,
    }

    if (dataRows.length === 0) {
      return [state.headerRow]
    }

    const chunks = createChunks(dataRows, state)
    
    // Clear references to help garbage collection
    processedData = null
    
    return chunks
  } finally {
    // Clean up worksheet reference if it was created from array
    if (Array.isArray(input) && worksheet) {
      // Clear the worksheet to help garbage collection
      const keys = Object.keys(worksheet)
      for (const key of keys) {
        delete worksheet[key]
      }
      worksheet = null
    }
  }
}
