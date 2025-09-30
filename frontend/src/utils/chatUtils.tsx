import { splitGroupedCitationsWithSpaces } from "@/lib/utils"

// Helper function to generate UUID
export const generateUUID = () => crypto.randomUUID()

export const textToCitationIndex = /\[(\d+)\]/g
export const textToImageCitationIndex = /\[(\d+_\d+)\]/g

// Function to clean citation numbers from response text
export const cleanCitationsFromResponse = (text: string): string => {
  // Clean both types of citations and trim any extra whitespace
  return text
    .replace(textToCitationIndex, "")
    .replace(textToImageCitationIndex, "")
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
    /(\[\d+_\d+\])/g,
    (fullMatch, capturedCitation, offset, string) => {
      // Check if this image citation appears earlier in the string
      const firstIndex = string.indexOf(fullMatch)
      if (firstIndex < offset) {
        // remove duplicate image citations
        return ""
      }
      return capturedCitation
    },
  )
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
    return text.replace(textToCitationIndex, (match, num) => {
      const index = citationMap[num]
      const url = citationUrls[index]
      return typeof index === "number" && url ? `[${index + 1}](${url})` : ""
    })
  } else {
    return text.replace(textToCitationIndex, (match, num) => {
      const url = citationUrls[num - 1]
      return url ? `[${num}](${url})` : ""
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
