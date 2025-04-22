// server/api/markdown.ts
import type { Context } from "hono"
import { z } from "zod"
import { insert, insertDocument } from "@/search/vespa"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import {
  type VespaSchema,
  fileSchema,
  Apps,
  DriveEntity,
  PrivateStoreEntity,
} from "@/search/types"
import { ErrorInsertingDocument } from "@/errors"
import { Octokit } from "@octokit/rest"
import { Hono } from "hono"
import type { MarkdownFile } from "../utils/markdown"
import { processMarkdown } from "../utils/markdown"

const Logger = getLogger(Subsystem.Api)
// GitHub logo URL for markdown documents without a photoLink
const GITHUB_LOGO_URL =
  "https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png"

// Initialize Octokit with authentication if token is available
const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
  userAgent: "xyne-markdown-processor",
})

// Custom error class for markdown processing errors
class MarkdownProcessingError extends Error {
  docId: string
  sectionTitle?: string
  cause?: Error

  constructor(
    message: string,
    docId: string,
    sectionTitle?: string,
    cause?: Error,
  ) {
    super(message)
    this.name = this.constructor.name
    this.docId = docId
    this.sectionTitle = sectionTitle
    this.cause = cause
    Error.captureStackTrace(this, this.constructor)
  }
}

// Define a schema for the request body
export const markdownInsertSchema = z.object({
  content: z.string(),
  metadata: z.object({
    source: z.string(),
    title: z.string().optional(),
    url: z.string().nullable(),
    timestamp: z.string().optional(),
  }),
})

// Schema for GitHub repository request
export const githubRepoInsertSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  path: z.string().optional().default(""),
  excludedFolders: z.array(z.string()).optional().default([]),
})

// Define the markdownfile schema name - reference to the schema we created
const markdownfileSchema: VespaSchema = fileSchema

export const insertMarkdown = async (c: Context) => {
  try {
    Logger.info("Received markdown request", {
      method: c.req.method,
      url: c.req.url,
    })

    const { sub: email } = c.get("jwtPayload")
    const body = await c.req.json()
    Logger.info("Request body", { body })

    // Validate the request body using Zod
    const parsedBody = markdownInsertSchema.parse(body)
    const { content, metadata } = parsedBody

    Logger.info("Processing markdown", {
      contentLength: content.length,
    })

    // Process the markdown content
    const processedContent = processMarkdown({
      content,
      metadata,
    })

    // Create a document with the URL field
    const document = {
      docId: `markdown-${Date.now()}`,
      title: metadata.title || "Untitled Document",
      app: Apps.PrivateStore,
      entity: PrivateStoreEntity.Markdown,
      url: metadata.url || null, // Use null instead of undefined
      chunks: [processedContent],
      owner: email,
      ownerEmail: email,
      photoLink: GITHUB_LOGO_URL, // Use GitHub logo as default
      permissions: [email],
      mimeType: "text/markdown",
      metadata: JSON.stringify(metadata),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    // Insert the document into Vespa
    await insertDocument(document)

    return c.json({
      message: "Markdown file inserted into Vespa successfully",
      contentLength: content.length,
    })
  } catch (error) {
    const errMsg = getErrorMessage(error)
    Logger.error(
      error,
      `insertMarkdown Error: ${errMsg} ${(error as Error).stack}`,
    )

    // Check if this is a MarkdownProcessingSummaryError with detailed error information
    if (
      error instanceof Error &&
      error.name === "MarkdownProcessingSummaryError"
    ) {
      const summaryError = error as any
      return c.json(
        {
          message: "Failed to insert markdown file into Vespa",
          error: errMsg,
          details: {
            totalSections: summaryError.errors?.length || 0,
            failedSections:
              summaryError.errors?.map((e: MarkdownProcessingError) => ({
                docId: e.docId,
                sectionTitle: e.sectionTitle,
                error: e.message,
              })) || [],
          },
        },
        500,
      )
    }

    return c.json(
      {
        message: "Failed to insert markdown file into Vespa",
        error: errMsg,
      },
      500,
    )
  }
}

async function fetchMarkdownFilesFromRepo(
  owner: string,
  repo: string,
  path: string = "",
): Promise<MarkdownFile[]> {
  try {
    const response = await octokit.repos.getContent({
      owner,
      repo,
      path,
    })

    if (!Array.isArray(response.data)) {
      if (response.data.type === "file" && response.data.name.endsWith(".md")) {
        const content = Buffer.from(response.data.content, "base64").toString()
        return [
          {
            content,
            metadata: {
              source: `github:${owner}/${repo}`,
              title: response.data.name,
              url: response.data.html_url || null, // Use null instead of undefined
              timestamp: new Date().toISOString(),
            },
          },
        ]
      }
      return []
    }

    const files: MarkdownFile[] = []
    for (const item of response.data) {
      if (item.type === "file" && item.name.endsWith(".md")) {
        const fileResponse = await octokit.repos.getContent({
          owner,
          repo,
          path: item.path,
        })
        if ("content" in fileResponse.data) {
          const content = Buffer.from(
            fileResponse.data.content,
            "base64",
          ).toString()
          files.push({
            content,
            metadata: {
              source: `github:${owner}/${repo}`,
              title: item.name,
              url: item.html_url || null, // Use null instead of undefined
              timestamp: new Date().toISOString(),
            },
          })
        }
      } else if (item.type === "dir") {
        const subFiles = await fetchMarkdownFilesFromRepo(
          owner,
          repo,
          item.path,
        )
        files.push(...subFiles)
      }
    }
    return files
  } catch (error) {
    Logger.error(
      { error },
      "Failed to fetch markdown files from GitHub repository",
    )
    throw error
  }
}

async function getRepoAvatarUrl(
  owner: string,
  repo: string,
): Promise<string | null> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}`,
    )
    if (!response.ok) {
      Logger.warn(`Failed to fetch repo info: ${response.statusText}`)
      return null
    }
    const data = await response.json()
    return data.owner.avatar_url || null
  } catch (error) {
    Logger.warn({ error }, "Failed to fetch repository avatar")
    return null
  }
}

async function processLocalRepo(
  owner: string,
  repo: string,
  email: string,
  excludedFolders: string[] = [],
): Promise<void> {
  const repoUrl = `https://github.com/${owner}/${repo}.git`
  const repoDir = `/tmp/${owner}-${repo}-${Date.now()}`

  try {
    // Get repository avatar URL
    const avatarUrl = await getRepoAvatarUrl(owner, repo)
    Logger.info(`Repository avatar URL: ${avatarUrl || "not found"}`)

    // Clone the repository
    Logger.info(`Cloning repository ${repoUrl} to ${repoDir}`)
    await new Promise((resolve, reject) => {
      const process = Bun.spawn(["git", "clone", repoUrl, repoDir], {
        onExit(proc, exitCode, signalCode, error) {
          if (error || exitCode !== 0) {
            reject(
              new Error(
                `Failed to clone repository: ${error || `Exit code ${exitCode}`}`,
              ),
            )
          } else {
            resolve(void 0)
          }
        },
      })
    })

    // Find all markdown files recursively
    const findProcess = Bun.spawn(["find", repoDir, "-name", "*.md"], {
      stdout: "pipe",
    })
    const output = await new Response(findProcess.stdout).text()
    const allMarkdownFiles = output.trim().split("\n").filter(Boolean)

    // Filter out files from excluded folders
    const markdownFiles = allMarkdownFiles.filter((filePath) => {
      const relativePath = filePath.replace(`${repoDir}/`, "")
      // Check if the file path contains any of the excluded folder names
      return !excludedFolders.some(
        (folder) =>
          relativePath
            .split("/")
            .includes(folder) || // Exact folder name match
          relativePath.startsWith(`${folder}/`), // Folder at root level
      )
    })

    Logger.info(
      `Found ${markdownFiles.length} markdown files (excluded ${allMarkdownFiles.length - markdownFiles.length} files from specified folders)`,
    )

    // Process each markdown file
    for (const filePath of markdownFiles) {
      const relativePath = filePath.replace(`${repoDir}/`, "")
      const content = await Bun.file(filePath).text()

      // Calculate the GitHub URL for this file
      const githubUrl = `https://github.com/${owner}/${repo}/blob/main/${relativePath}`

      // Create metadata
      const metadata = {
        source: `github:${owner}/${repo}`,
        url: githubUrl,
        timestamp: new Date().toISOString(),
        path: relativePath,
      }

      // Process the markdown content
      const processedContent = processMarkdown({
        content,
        metadata,
      })

      // Create the document
      const document = {
        docId: `github-markdown-${Date.now()}-${crypto.randomUUID()}`,
        title: relativePath.split("/").pop() || "Untitled",
        app: Apps.PrivateStore,
        entity: PrivateStoreEntity.Markdown,
        url: githubUrl,
        chunks: [processedContent],
        owner: email,
        ownerEmail: email,
        photoLink: GITHUB_LOGO_URL,
        permissions: [email],
        mimeType: "text/markdown",
        metadata: JSON.stringify(metadata),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      // Insert into Vespa
      await insertDocument(document)
      Logger.info(`Processed and inserted ${relativePath}`)
    }
  } catch (error) {
    Logger.error({ error }, "Failed to process local repository")
    throw error
  } finally {
    // Cleanup: Remove the cloned repository
    await new Promise((resolve) => {
      const process = Bun.spawn(["rm", "-rf", repoDir], {
        onExit() {
          resolve(void 0)
        },
      })
    })
  }
}

export async function insertFromGithub(c: Context) {
  try {
    const body = await c.req.json()
    const validatedBody = githubRepoInsertSchema.parse(body)
    const { sub: email } = c.get("jwtPayload")

    await processLocalRepo(
      validatedBody.owner,
      validatedBody.repo,
      email,
      validatedBody.excludedFolders,
    )

    return c.json({
      success: true,
      message: "Repository processed successfully",
    })
  } catch (error) {
    Logger.error({ error }, "Failed to process GitHub repository ingestion")
    return c.json(
      {
        success: false,
        error: getErrorMessage(error),
      },
      500,
    )
  }
}

// Define the MarkdownSection interface
interface MarkdownSection {
  docId: string
  title: string
  app: Apps
  entity: DriveEntity | PrivateStoreEntity
  url: string | null
  chunks: string[]
  owner: string | null
  ownerEmail: string | null
  photoLink: string | null
  permissions: string[]
  mimeType: string
  metadata: string // Stored as a JSON string, will be parsed back to an object when sending to Vespa
  createdAt: number
  updatedAt: number
  sectionTitle?: string
  content?: string
  parentDocId?: string
  level?: number
  sectionOrder?: number
}

// Helper functions for splitting markdown into sections
function splitMarkdownIntoSections(
  markdownFile: string,
  title: string,
  docId: string,
  ownerEmail: string,
): MarkdownSection[] {
  try {
    // Use a proper regex pattern to identify markdown headings
    const headingPattern = /^(#{1,6})\s+(.+)$/gm
    const sections: MarkdownSection[] = []

    // Get all heading matches with their positions
    const headings: { level: number; title: string; index: number }[] = []
    let match

    while ((match = headingPattern.exec(markdownFile)) !== null) {
      headings.push({
        level: match[1].length, // Number of # characters
        title: match[2].trim(),
        index: match.index,
      })
    }

    const timestamp = Date.now()

    // Process each heading and its content
    for (let i = 0; i < headings.length; i++) {
      const currentHeading = headings[i]
      const nextHeading = headings[i + 1]

      // Calculate content boundaries
      const contentStart =
        currentHeading.index +
        currentHeading.title.length +
        currentHeading.level +
        1
      const contentEnd = nextHeading ? nextHeading.index : markdownFile.length
      const content = markdownFile.substring(contentStart, contentEnd).trim()

      // Create metadata with section information
      const metadataObj = {
        type: "markdown",
        section: currentHeading.title,
        level: currentHeading.level,
        sectionIndex: i + 1,
        totalSections: headings.length,
        parentDocument: {
          id: docId,
          title: title,
        },
      }

      const section: MarkdownSection = {
        docId: `${docId}-section-${i + 1}`,
        title: title ?? "Untitled Document",
        app: Apps.PrivateStore,
        entity: PrivateStoreEntity.Markdown,
        url: null,
        owner: ownerEmail,
        ownerEmail: ownerEmail,
        photoLink: null,
        chunks: [content].filter(Boolean), // Remove empty chunks
        mimeType: "text/markdown",
        metadata: JSON.stringify(metadataObj),
        permissions: [ownerEmail], // Add owner's email to permissions
        createdAt: timestamp,
        updatedAt: timestamp,
        sectionTitle: currentHeading.title ?? "Untitled Section",
        content: content,
        level: currentHeading.level,
        sectionOrder: i + 1,
        parentDocId: docId,
      }

      sections.push(section)
    }

    // If there are no headings, use the entire content as one section
    if (sections.length === 0 && markdownFile.trim()) {
      const metadataObj = {
        type: "markdown",
        section: "main",
        level: 1,
        sectionIndex: 1,
        totalSections: 1,
        parentDocument: {
          id: docId,
          title: title,
        },
      }

      sections.push({
        docId: `${docId}-section-1`,
        parentDocId: docId,
        title: title ?? "Untitled Document",
        sectionTitle: title ?? "Untitled Document",
        content: markdownFile.trim(),
        level: 1,
        createdAt: timestamp,
        sectionOrder: 1,
        app: Apps.PrivateStore,
        entity: PrivateStoreEntity.Markdown,
        url: null,
        owner: ownerEmail,
        ownerEmail: ownerEmail,
        photoLink: null,
        chunks: [markdownFile.trim()].filter(Boolean),
        updatedAt: timestamp,
        permissions: [ownerEmail], // Add owner's email to permissions
        mimeType: "text/markdown",
        metadata: JSON.stringify(metadataObj),
      })
    }

    return sections
  } catch (error) {
    Logger.error(
      error,
      `Error splitting markdown into sections: ${getErrorMessage(error)}`,
    )
    // Return a single section with the entire content if splitting fails
    const timestamp = Date.now()
    const metadataObj = {
      type: "markdown",
      section: "main",
      level: 1,
      sectionIndex: 1,
      totalSections: 1,
      error: getErrorMessage(error),
      parentDocument: {
        id: docId,
        title: title,
      },
    }

    return [
      {
        docId: `${docId}-section-1`,
        parentDocId: docId,
        title: title ?? "Untitled Document",
        sectionTitle: title ?? "Untitled Document",
        content: markdownFile.trim(),
        level: 1,
        createdAt: timestamp,
        sectionOrder: 1,
        app: Apps.PrivateStore,
        entity: PrivateStoreEntity.Markdown,
        url: null,
        owner: ownerEmail,
        ownerEmail: ownerEmail,
        photoLink: null,
        chunks: [markdownFile.trim()].filter(Boolean),
        updatedAt: timestamp,
        permissions: [ownerEmail], // Add owner's email to permissions
        mimeType: "text/markdown",
        metadata: JSON.stringify(metadataObj),
      },
    ]
  }
}

// Helper function to get error messages
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

async function insertDocumentsIntoVespa(
  sections: MarkdownSection[],
): Promise<void> {
  Logger.info(`Inserting ${sections.length} markdown sections into Vespa`)

  const errors: MarkdownProcessingError[] = []
  let successCount = 0

  for (const section of sections) {
    try {
      // Parse the metadata string into an object
      let metadataObj = {}
      try {
        metadataObj = JSON.parse(section.metadata)
      } catch (e) {
        Logger.warn(
          `Failed to parse metadata for section ${section.docId}, using empty object instead.`,
        )
      }

      // Create a copy of the section with only the fields required by VespaFileSchema
      const vespaDoc = {
        docId: section.docId,
        title: section.title ?? "Untitled Document",
        app: section.app,
        entity: section.entity,
        url: section.url,
        chunks: section.chunks.filter(Boolean), // Remove any null/empty chunks
        owner: section.owner,
        ownerEmail: section.ownerEmail,
        photoLink: section.photoLink,
        permissions: section.permissions ?? [],
        mimeType: section.mimeType ?? "text/markdown",
        metadata: JSON.stringify(metadataObj), // Use the parsed metadata object
        createdAt: section.createdAt,
        updatedAt: section.updatedAt,
      }

      // Log the document before sending it to Vespa with more details
      Logger.info(
        `Sending document to Vespa: ${JSON.stringify(vespaDoc, null, 2)}`,
      )
      Logger.info(`Document structure details:
        - docId: ${typeof vespaDoc.docId} = ${vespaDoc.docId}
        - title: ${typeof vespaDoc.title} = ${vespaDoc.title}
        - app: ${typeof vespaDoc.app} = ${vespaDoc.app}
        - entity: ${typeof vespaDoc.entity} = ${vespaDoc.entity}
        - url: ${typeof vespaDoc.url} = ${vespaDoc.url}
        - chunks: ${typeof vespaDoc.chunks} = ${JSON.stringify(vespaDoc.chunks)}
        - owner: ${typeof vespaDoc.owner} = ${vespaDoc.owner}
        - ownerEmail: ${typeof vespaDoc.ownerEmail} = ${vespaDoc.ownerEmail}
        - photoLink: ${typeof vespaDoc.photoLink} = ${vespaDoc.photoLink}
        - permissions: ${typeof vespaDoc.permissions} = ${JSON.stringify(vespaDoc.permissions)}
        - mimeType: ${typeof vespaDoc.mimeType} = ${vespaDoc.mimeType}
        - metadata: ${typeof vespaDoc.metadata} = ${JSON.stringify(vespaDoc.metadata)}
        - createdAt: ${typeof vespaDoc.createdAt} = ${vespaDoc.createdAt}
        - updatedAt: ${typeof vespaDoc.updatedAt} = ${vespaDoc.updatedAt}`)

      // Use insertDocument instead of insert
      await insertDocument(vespaDoc)
      Logger.debug(
        `Successfully inserted section: ${section.sectionTitle ?? "unnamed section"}`,
      )
      successCount++
    } catch (error) {
      const errMsg = getErrorMessage(error)
      const markdownError = new MarkdownProcessingError(
        `Error inserting document into Vespa: ${errMsg}`,
        section.docId,
        section.sectionTitle ?? "unnamed section",
        error instanceof Error ? error : undefined,
      )

      Logger.error(
        markdownError,
        `Error inserting document into Vespa: ${errMsg} for section: ${section.sectionTitle ?? "unnamed section"}`,
      )

      errors.push(markdownError)
      // Continue with other sections even if one fails
    }
  }

  // Log summary of results
  Logger.info(
    `Markdown processing complete: ${successCount} sections inserted successfully, ${errors.length} sections failed`,
  )

  // If there were any errors, throw a summary error
  if (errors.length > 0) {
    const errorSummary = new Error(
      `Failed to insert ${errors.length} out of ${sections.length} markdown sections`,
    )
    errorSummary.name = "MarkdownProcessingSummaryError"
    ;(errorSummary as any).errors = errors
    throw errorSummary
  }
}
