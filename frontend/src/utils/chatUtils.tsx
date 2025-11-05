import { splitGroupedCitationsWithSpaces } from "@/lib/utils"

// Helper function to generate UUID
export const generateUUID = () => crypto.randomUUID()

export const textToCitationIndex = /\[(\d+)\]/g
export const textToImageCitationIndex = /(?<!K)\[(\d+_\d+)\]/g
export const textToKbItemCitationIndex = /K\[(\d+_\d+)\]/g

// Function to clean citation numbers from response text
export const cleanCitationsFromResponse = (text: string): string => {
  // Clean both types of citations and trim any extra whitespace
  return text
    .replace(textToCitationIndex, "")
    .replace(textToImageCitationIndex, "")
    .replace(textToKbItemCitationIndex, "")
    .replace(/[ \t]+/g, " ")
    .trim()
}

export const processMessage = (
  text: string,
  citationMap: Record<number, number> | undefined,
  citationUrls: string[],
) => {
  text = splitGroupedCitationsWithSpaces(text)
  text = text.replace(
    textToImageCitationIndex,
    (match, citationKey, offset, string) => {
      // Check if this image citation appears earlier in the string
      const firstIndex = string.indexOf(match)
      if (firstIndex < offset) {
        // remove duplicate image citations
        return ""
      }
      return `![image-citation:${citationKey}](image-citation:${citationKey})`
    },
  )

  if (citationMap) {
    text = text.replace(textToKbItemCitationIndex, (_, citationKey) => {
      const index = citationMap[parseInt(citationKey.split("_")[0], 10)]
      const chunkIndex = parseInt(citationKey.split("_")[1], 10)
      const url = citationUrls[index]
      return typeof index === "number" && typeof chunkIndex === "number" && url
      ? `[${index + 1}_${chunkIndex}](${url})`
      : ""
    })
  } else {
    let localCitationMap: Record<number, number> = {}
    let localIndex = 0
    text = text.replace(textToKbItemCitationIndex, (_, citationKey) => {
      const citationindex = parseInt(citationKey.split("_")[0], 10)
      if (localCitationMap[citationindex] === undefined) {
        localCitationMap[citationindex] = localIndex
        localIndex++
      }
      const chunkIndex = parseInt(citationKey.split("_")[1], 10)
      const url = citationUrls[localCitationMap[citationindex]]
      return typeof localCitationMap[citationindex] === "number" && typeof chunkIndex === "number" && url
      ? `[${localCitationMap[citationindex] + 1}_${chunkIndex}](${url})`
      : ""
    })
  }

  if (citationMap) {
    return text.replace(textToCitationIndex, (match, num) => {
      const index = citationMap[num]
      const url = citationUrls[index]
      return typeof index === "number" && url ? `[${index + 1}](${url})` : ""
    })
  } else {
    let localCitationMap: Record<number, number> = {}
    let localIndex = 0
    return text.replace(textToCitationIndex, (match, num) => {
      const citationindex = parseInt(num, 10)
      if (localCitationMap[citationindex] === undefined) {
        localCitationMap[citationindex] = localIndex
        localIndex++
      }
      const url = citationUrls[localCitationMap[citationindex]]
      return typeof localCitationMap[citationindex] === "number" && url
      ? `[${localCitationMap[citationindex] + 1}](${url})`
      : ""
    })
  }
}

export class PersistentMap {
  private map: Map<string, string>
  private storageKey: string

  constructor(storageKey: string) {
    this.map = new Map()
    this.storageKey = storageKey
    this.loadFromStorage()
  }

  private loadFromStorage() {
    try {
      const stored = sessionStorage.getItem(this.storageKey)
      if (stored) {
        const data = JSON.parse(stored)
        this.map = new Map(Object.entries(data))
      }
    } catch (error) {
      console.error("Failed to load document chat map from storage:", error)
      this.map = new Map()
    }
  }

  private saveToStorage() {
    try {
      const data = Object.fromEntries(this.map)
      sessionStorage.setItem(this.storageKey, JSON.stringify(data))
    } catch (error) {
      console.error("Failed to save document chat map to storage:", error)
    }
  }

  set(key: string, value: string) {
    this.map.set(key, value)
    this.saveToStorage()
  }

  get(key: string): string | undefined {
    return this.map.get(key)
  }

  has(key: string): boolean {
    return this.map.has(key)
  }

  delete(key: string): boolean {
    const result = this.map.delete(key)
    this.saveToStorage()
    return result
  }

  clear() {
    this.map.clear()
    this.saveToStorage()
  }

  size(): number {
    return this.map.size
  }

  entries(): IterableIterator<[string, string]> {
    return this.map.entries()
  }
}

// Shared table components for consistent rendering across chat interfaces
export const createTableComponents = () => ({
  table: ({ node, ...props }: any) => (
    <div className="overflow-x-auto max-w-full my-2">
      <table
        style={{
          borderCollapse: "collapse",
          borderStyle: "hidden",
          tableLayout: "auto",
          minWidth: "100%",
          maxWidth: "none",
        }}
        className="w-auto dark:bg-slate-800"
        {...props}
      />
    </div>
  ),
  th: ({ node, ...props }: any) => (
    <th
      style={{
        border: "none",
        padding: "8px 12px",
        textAlign: "left",
        overflowWrap: "break-word",
        wordBreak: "break-word",
        maxWidth: "300px",
        minWidth: "100px",
        whiteSpace: "normal",
      }}
      className="dark:text-white font-semibold"
      {...props}
    />
  ),
  td: ({ node, ...props }: any) => (
    <td
      style={{
        border: "none",
        padding: "8px 12px",
        overflowWrap: "break-word",
        wordBreak: "break-word",
        maxWidth: "300px",
        minWidth: "100px",
        whiteSpace: "normal",
      }}
      className="border-t border-gray-100 dark:border-gray-800 dark:text-white"
      {...props}
    />
  ),
  tr: ({ node, ...props }: any) => (
    <tr
      style={{ border: "none" }}
      className="bg-white dark:bg-[#1E1E1E]"
      {...props}
    />
  ),
})
