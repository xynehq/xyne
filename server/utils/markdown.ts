import { getLogger } from "../logger"
import { Subsystem } from "../types"

const logger = getLogger(Subsystem.Utils) // Using an existing enum value; replace with appropriate one

export interface MarkdownFile {
  content: string
  metadata: {
    source: string
    title?: string
    url: string | null
    timestamp?: string
  }
}

export function processMarkdown(file: MarkdownFile): string {
  try {
    logger.info({ file }, "Processing markdown file")
    // initially putting the whole file in vespa
    // we are not splitting it into sections now
    return file.content
  } catch (error) {
    logger.error({ error }, "Failed to process markdown file")
    throw error
  }
}
