import { getTracer } from "@/tracer"
import { getLogger, getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
import { getErrorMessage, splitGroupedCitationsWithSpaces } from "@/utils"
import {
  AttachmentEntity,
  type VespaSearchResult,
} from "@xyne/vespa-ts/types"
import type {
  Citation,
  ImageCitation,
  MinimalAgentFragment,
} from "./types"
import {
  getCitationToImage,
  mimeTypeMap,
  textToCitationIndex,
  textToImageCitationIndex,
  textToKbItemCitationIndex,
} from "./utils"

const Logger = getLogger(Subsystem.Chat)
const loggerWithChild = getLoggerWithChild(Subsystem.Chat)

export type CitationYieldEvent = {
  citation?: { index: string; item: Citation }
  imageCitation?: ImageCitation
}

/**
 * Shared citation extraction utility used by agentic chat flows.
 * Mirrors the behavior from the legacy agentic flow but lives in a reusable module.
 */
export const checkAndYieldCitationsForAgent = async function* (
  textInput: string,
  yieldedCitations: Set<string>,
  fragments: MinimalAgentFragment[],
  yieldedImageCitations?: Map<number, Set<number>>,
  email = "",
): AsyncGenerator<CitationYieldEvent, void, unknown> {
  const tracer = getTracer("chat")
  const span = tracer.startSpan("checkAndYieldCitationsForAgent")

  try {
    span.setAttribute("text_input_length", textInput.length)
    span.setAttribute("results_count", fragments.length)
    span.setAttribute("yielded_citations_size", yieldedCitations.size)
    span.setAttribute("has_image_citations", !!yieldedImageCitations)
    span.setAttribute("user_email", email)

    const text = splitGroupedCitationsWithSpaces(textInput)
    let match: RegExpExecArray | null
    let imgMatch: RegExpExecArray | null = null
    let kbMatch: RegExpExecArray | null = null
    let citationsProcessed = 0
    let imageCitationsProcessed = 0
    let citationsYielded = 0
    let imageCitationsYielded = 0
    let kbCitationsProcessed = 0

    while (
      (match = textToCitationIndex.exec(text)) !== null ||
      (imgMatch = textToImageCitationIndex.exec(text)) !== null ||
      (kbMatch = textToKbItemCitationIndex.exec(text)) !== null
    ) {
      if (match || kbMatch) {
        citationsProcessed++
        const citationKey = (() => {
          if (match) return match[1]
          if (kbMatch) return `K[${kbMatch[1]}_${kbMatch[2]}]`
          return ""
        })()

        if (!citationKey) continue
        if (!yieldedCitations.has(citationKey)) {
          const resolveChunkIndex = (frag: MinimalAgentFragment): number | null => {
            const parts = frag.id?.split(":")
            const last = parts?.[parts.length - 1]
            const parsed = last ? Number(last) : NaN
            return Number.isFinite(parsed) ? parsed : null
          }

          let fragment: MinimalAgentFragment | undefined
          if (match) {
            const citationIndex = parseInt(match[1], 10)
            fragment = fragments[citationIndex - 1]
          } else if (kbMatch) {
            const docId = kbMatch[1]
            const chunkIndex = parseInt(kbMatch[2], 10)
            fragment =
              fragments.find(
                (frag) =>
                  frag.source?.docId === docId &&
                  resolveChunkIndex(frag) === chunkIndex,
              ) || fragments.find((frag) => frag.source?.docId === docId)
          }

          if (!fragment?.source) {
            Logger.info(
              "[checkAndYieldCitationsForAgent] Fragment source missing entirely, skipping",
            )
            continue
          }
          if (!fragment.source.docId && !fragment.source.url) {
            Logger.info(
              "[checkAndYieldCitationsForAgent] No docId or url found for citation, skipping",
            )
            continue
          }

          if (
            Object.values(AttachmentEntity).includes(
              fragment.source.entity as AttachmentEntity,
            )
          ) {
            continue
          }

          yield { citation: { index: citationKey, item: fragment.source } }
          Logger.info(
            {
              citationKey,
              docId: fragment.source.docId,
              hasChunkSuffix: !!kbMatch,
              fragmentId: fragment.id,
            },
            "[checkAndYieldCitationsForAgent] Yielded citation",
          )
          yieldedCitations.add(citationKey)
          citationsYielded++
        }
        if (kbMatch) {
          kbCitationsProcessed++
        }
      } else if (imgMatch && yieldedImageCitations) {
        citationsProcessed++
        const parts = imgMatch[1].split("_")
        if (parts.length >= 2) {
          const docIndex = parseInt(parts[0], 10)
          const imageIndex = parseInt(parts[1], 10)
          imageCitationsProcessed++

          if (
            !yieldedImageCitations.has(docIndex) ||
            !yieldedImageCitations.get(docIndex)?.has(imageIndex)
          ) {
            const fragment = fragments[docIndex]
            if (fragment) {
              const imageSpan = span.startSpan("process_image_citation")
              try {
                imageSpan.setAttribute("citation_key", imgMatch[1])
                imageSpan.setAttribute("doc_index", docIndex)
                imageSpan.setAttribute("image_index", imageIndex)

                const imageData = await getCitationToImage(
                  imgMatch[1],
                  {
                    id: fragment.id,
                    relevance: fragment.confidence,
                    fields: {
                      docId: fragment.source.docId,
                    } as any,
                  } as VespaSearchResult,
                  email,
                )

                if (imageData) {
                  if (!imageData.imagePath || !imageData.imageBuffer) {
                    loggerWithChild({ email }).error(
                      {
                        citationKey: imgMatch[1],
                        imageData,
                      },
                      "Invalid imageData structure returned",
                    )
                    imageSpan.setAttribute("processing_success", false)
                    imageSpan.setAttribute(
                      "error_reason",
                      "invalid_image_data",
                    )
                    imageSpan.end()
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
                      item: fragment.source,
                    },
                  }
                  Logger.info(
                    {
                      citationKey: imgMatch[1],
                      docIndex,
                      imageIndex,
                      fragmentId: fragment.id,
                    },
                    " image citation",
                  )
                  imageCitationsYielded++
                  imageSpan.setAttribute("processing_success", true)
                  imageSpan.setAttribute(
                    "image_size",
                    imageData.imageBuffer.length,
                  )
                  imageSpan.setAttribute(
                    "image_extension",
                    imageData.extension || "unknown",
                  )

                  // Mark as successfully processed only after successful yield
                  if (!yieldedImageCitations.has(docIndex)) {
                    yieldedImageCitations.set(docIndex, new Set<number>())
                  }
                  yieldedImageCitations.get(docIndex)?.add(imageIndex)
                }
                imageSpan.end()
              } catch (error) {
                imageSpan.addEvent("image_processing_error", {
                  message: getErrorMessage(error),
                  stack: (error as Error).stack || "",
                })
                imageSpan.setAttribute("processing_success", false)
                imageSpan.end()
                loggerWithChild({ email }).error(
                  error,
                  "Error processing image citation",
                  { citationKey: imgMatch[1], error: getErrorMessage(error) },
                )
              }
            } else {
              loggerWithChild({ email }).warn(
                { imageIndex, fragmentsLength: fragments.length },
                "Found a citation index but could not find it in the search result",
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
    throw error
  }
}
