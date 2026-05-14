import type {
  Citation,
  ImageCitation,
  MinimalAgentFragment,
} from "@/api/chat/types"
import config from "@/config"
import { getLoggerWithChild, Subsystem } from "@/logger"
import { getTracer } from "@/tracer"
import { getErrorMessage, splitGroupedCitationsWithSpaces } from "@/utils"
import { getCitationToImage, mimeTypeMap } from "../../utils"
import type { VespaSearchResult } from "@xyne/vespa-ts"

export function formatFragmentsForLLM(
  fragments: MinimalAgentFragment[],
  startIndex: number,
  maxFragments: number = config.maxDefaultSummary,
): string {
  if (fragments.length === 0) return "No results found."

  // TODO: citation format should take from config based on the document
  return fragments
    .slice(0, maxFragments)
    .map((fragment, index) => {
      const citationIndex = startIndex + index
      return `citationDocId: ${citationIndex} — cite as K[${citationIndex}_N] where N is the chunk number\n${fragment.content}`
    })
    .join("\n\n")
}

export const textToCitationIndex = /\[(\d+)\]/g
// Image citations from `[N_M]` are now treated as KB chunks (see utils.ts).
export const textToImageCitationIndex = /(?!)/g
// Matches K[N_M], [KN_M], [N_M], K(N_M), (KN_M), (N_M) — numeric body only.
export const textToChunkCitationIndex = /[K\[\(]+(\d+_\d+)[\]\)]/g

export const checkAndYieldCitationsForAgent = async function* (
  textInput: string,
  yieldedCitations: Set<number>,
  results: MinimalAgentFragment[],
  yieldedImageCitations?: Map<number, Set<number>>,
  email: string = "",
  citationDocIdMapping?: Map<number, string>, // Maps citationDocId -> fragment.id
): AsyncGenerator<
  {
    citation?: { index: number; item: Citation; chunkIndex?: number }
    imageCitation?: ImageCitation
  },
  void,
  unknown
> {
  const tracer = getTracer("chat")
  const span = tracer.startSpan("checkAndYieldCitationsForAgent")
  const loggerWithChild = getLoggerWithChild(Subsystem.Chat)
  try {
    span.setAttribute("text_input_length", textInput.length)
    span.setAttribute("results_count", results.length)
    span.setAttribute("yielded_citations_size", yieldedCitations.size)
    span.setAttribute("has_image_citations", !!yieldedImageCitations)
    span.setAttribute("user_email", email)
    span.setAttribute("has_citation_mapping", !!citationDocIdMapping)

    const fragmentById = new Map<string, MinimalAgentFragment>()
    for (const fragment of results) {
      fragmentById.set(fragment.id, fragment)
    }

    let text = splitGroupedCitationsWithSpaces(textInput)
    let match
    let imgMatch
    let chunkMatch
    let citationsProcessed = 0
    let imageCitationsProcessed = 0
    let citationsYielded = 0
    let imageCitationsYielded = 0

    // Track which (citationDocId, chunkIndex) pairs have been yielded to prevent inline duplicates
    const yieldedChunkCitations = new Set<string>()

    while (
      (match = textToCitationIndex.exec(text)) !== null ||
      (imgMatch = textToImageCitationIndex.exec(text)) !== null ||
      (chunkMatch = textToChunkCitationIndex.exec(text)) !== null
    ) {
      if (match || chunkMatch) {
        citationsProcessed++
        let citationDocId = 0
        let chunkIndex: number | undefined

        if (match) {
          citationDocId = parseInt(match[1], 10)
        } else if (chunkMatch) {
          const parts = chunkMatch[1].split("_")
          citationDocId = parseInt(parts[0], 10)
          chunkIndex = parseInt(parts[1], 10)
        }

        // Create compound key for chunk-level deduplication
        const citationKey =
          chunkIndex !== undefined
            ? `${citationDocId}_${chunkIndex}`
            : String(citationDocId)

        if (!yieldedChunkCitations.has(citationKey)) {
          let item: MinimalAgentFragment | undefined

          if (citationDocIdMapping && citationDocIdMapping.size > 0) {
            // Use citation mapping for reliable lookup
            const fragmentId = citationDocIdMapping.get(citationDocId)
            if (fragmentId) {
              item = fragmentById.get(fragmentId)
            }
          } else {
            item = results[citationDocId - 1]
          }

          if (!item) {
            loggerWithChild({ email: email }).warn(
              `[checkAndYieldCitationsForAgent] Found a citation but could not map it to a search result: citationDocId=${citationDocId}, hasMapping=${!!citationDocIdMapping}, resultsCount=${results.length}`,
            )
            continue
          }

          if (!item?.source?.docId && !item?.source?.url) {
            loggerWithChild({ email: email }).info(
              "[checkAndYieldCitationsForAgent] No docId or url found for citation, skipping",
            )
            continue
          }

          // Yield citation with chunk info if available
          // Only add to yieldedCitations (for sources dedup) on first occurrence of this doc
          const isFirstDocOccurrence = !yieldedCitations.has(citationDocId)

          yield {
            citation: {
              index: citationDocId,
              item: item.source,
              chunkIndex,
            },
          }

          yieldedChunkCitations.add(citationKey)
          if (isFirstDocOccurrence) {
            yieldedCitations.add(citationDocId)
          }
          citationsYielded++
        }
      } else if (imgMatch && yieldedImageCitations) {
        imageCitationsProcessed++
        const parts = imgMatch[1].split("_")
        if (parts.length >= 2) {
          const docIndex = parseInt(parts[0], 10)
          const imageIndex = parseInt(parts[1], 10)
          if (
            !yieldedImageCitations.has(docIndex) ||
            !yieldedImageCitations.get(docIndex)?.has(imageIndex)
          ) {
            const item = results[docIndex]
            if (item) {
              const imageProcessingSpan = span.startSpan(
                "process_image_citation",
              )
              try {
                imageProcessingSpan.setAttribute("citation_key", imgMatch[1])
                imageProcessingSpan.setAttribute("doc_index", docIndex)
                imageProcessingSpan.setAttribute("image_index", imageIndex)

                const imageData = await getCitationToImage(
                  imgMatch[1],
                  {
                    id: item.id,
                    relevance: item.confidence,
                    fields: {
                      docId: item.source.docId,
                    } as any,
                  } as VespaSearchResult,
                  email,
                )
                if (imageData) {
                  if (!imageData.imagePath || !imageData.imageBuffer) {
                    loggerWithChild({ email: email }).error(
                      "Invalid imageData structure returned",
                      { citationKey: imgMatch[1], imageData },
                    )
                    imageProcessingSpan.setAttribute(
                      "processing_success",
                      false,
                    )
                    imageProcessingSpan.setAttribute(
                      "error_reason",
                      "invalid_image_data",
                    )
                    imageProcessingSpan.end()
                    continue
                  }
                  yield {
                    imageCitation: {
                      citationKey: imgMatch[1],
                      imagePath: imageData.imagePath,
                      imageData: imageData.imageBuffer.toString("base64"),
                      ...(imageData.extension
                        ? { mimeType: mimeTypeMap[imageData.extension] }
                        : {}),
                      item: item.source,
                    },
                  }
                  imageCitationsYielded++
                  imageProcessingSpan.setAttribute("processing_success", true)
                  imageProcessingSpan.setAttribute(
                    "image_size",
                    imageData.imageBuffer.length,
                  )
                  imageProcessingSpan.setAttribute(
                    "image_extension",
                    imageData.extension || "unknown",
                  )
                }
                imageProcessingSpan.end()
              } catch (error) {
                imageProcessingSpan.addEvent("image_processing_error", {
                  message: getErrorMessage(error),
                  stack: (error as Error).stack || "",
                })
                imageProcessingSpan.setAttribute("processing_success", false)
                imageProcessingSpan.end()

                loggerWithChild({ email: email }).error(
                  error,
                  "Error processing image citation",
                  { citationKey: imgMatch[1], error: getErrorMessage(error) },
                )
              }
              if (!yieldedImageCitations.has(docIndex)) {
                yieldedImageCitations.set(docIndex, new Set<number>())
              }
              yieldedImageCitations.get(docIndex)?.add(imageIndex)
            } else {
              loggerWithChild({ email: email }).warn(
                "Found a citation index but could not find it in the search result ",
                imageIndex,
                results.length,
              )
              continue
            }
          }
        }
      }
    }

    span.setAttribute("citations_processed", citationsProcessed)
    span.setAttribute("image_citations_processed", imageCitationsProcessed)
    span.setAttribute("citations_yielded", citationsYielded)
    span.setAttribute("image_citations_yielded", imageCitationsYielded)
    span.end()
  } catch (error) {
    span.addEvent("error", {
      message: getErrorMessage(error),
      stack: (error as Error).stack || "",
    })
    span.end()
    loggerWithChild({ email: email }).error(
      error,
      "Error in checkAndYieldCitationsForAgent",
      { textInputLength: textInput.length, resultsCount: results.length },
    )
  }
}
