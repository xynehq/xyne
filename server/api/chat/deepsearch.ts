import { nanoid } from "nanoid"
import { getLogger } from "@/logger"
import { Apps, ChatSSEvents, WebSearchEntity } from "@/shared/types"
import type { Citation } from "./types"
import { Subsystem } from "@/types"
import type { ConverseResponse, WebSearchSource } from "@/ai/types"
import type { SSEStreamingApi } from "hono/streaming"
import type { GroundingSupport } from "@google/genai"
import { findOptimalCitationInsertionPoint } from "./utils"

export interface DeepSearchIteratorParams {
  iterator: AsyncIterable<ConverseResponse>
  stream: SSEStreamingApi
  email: string
  answer: string
  deepResearchSteps: any[]
  finalText: string
  finalAnnotations: any[]
  costArr: any[]
  tokenArr: any[]
  wasStreamClosedPrematurely: boolean
}

export interface DeepSearchIteratorResult {
  answer: string
  finalText: string
  finalAnnotations: any[]
  deepResearchSteps: any[]
  costArr: any[]
  tokenArr: any[]
  wasStreamClosedPrematurely: boolean
}

export async function processDeepSearchIterator(
  params: DeepSearchIteratorParams,
): Promise<DeepSearchIteratorResult> {
  const { iterator, stream, email, costArr, tokenArr, deepResearchSteps } =
    params

  let { answer, finalText, finalAnnotations, wasStreamClosedPrematurely } =
    params

  const logger = getLogger(Subsystem.AI)
  const loggerWithChild = (childData: any) => logger.child(childData)

  for await (const chunk of iterator) {
    if (stream.closed) {
      loggerWithChild({ email: email }).info(
        "[MessageApi] Stream closed during deep research loop. Breaking.",
      )
      wasStreamClosedPrematurely = true
      break
    }

    if (chunk.text) {
      answer += chunk.text
      stream.writeSSE({
        event: ChatSSEvents.ResponseUpdate,
        data: chunk.text,
      })
    }

    if (chunk.metadata && typeof chunk.metadata === "object") {
      const metadata = chunk.metadata as any

      if (
        metadata.type === "response.output_item.done" &&
        metadata.item?.type === "message" &&
        metadata.item?.content
      ) {
        // Extract the final text and annotations from the completed message
        for (const content of metadata.item.content) {
          if (content.type === "output_text") {
            finalText = content.text || ""
            finalAnnotations = content.annotations || []
          }
        }
      }

      // Handle reasoning summary text deltas - the actual reasoning content
      if (
        metadata.type === "response.reasoning_summary_text.delta" &&
        metadata.delta &&
        metadata.item_id
      ) {
        // Find existing reasoning step for this item_id or create one
        let existingStep = deepResearchSteps.find(
          (step) => step.id === metadata.item_id && step.type === "reasoning",
        )

        if (existingStep) {
          // Accumulate content in the existing step
          existingStep.content = (existingStep.content || "") + metadata.delta
          existingStep.timestamp = Date.now()
          existingStep.status = "active"
        } else {
          // Create new reasoning step
          const step = {
            id: metadata.item_id,
            type: "reasoning",
            title: "Reasoning",
            content: metadata.delta,
            focus: "Analyzing and thinking through the problem",
            timestamp: Date.now(),
            status: "active",
            isReasoningDelta: true,
          }
          deepResearchSteps.push(step)
          existingStep = step
        }

        // Send the updated step (not a new one each time)
        stream.writeSSE({
          event: ChatSSEvents.DeepResearchReasoning,
          data: JSON.stringify(existingStep),
        })
      }

      // Handle reasoning summary completion - final reasoning content
      if (
        metadata.type === "response.reasoning_summary_text.done" &&
        metadata.reasoningContent &&
        metadata.item_id
      ) {
        // Find and update the existing reasoning step to mark it as completed
        let existingStep = deepResearchSteps.find(
          (step) => step.id === metadata.item_id && step.type === "reasoning",
        )

        if (existingStep) {
          // Update existing step to completed status
          existingStep.status = "completed"
          existingStep.title = `Reasoning Complete (${metadata.reasoningContent.length} chars)`
          existingStep.fullReasoningContent = metadata.reasoningContent
          existingStep.timestamp = Date.now()

          stream.writeSSE({
            event: ChatSSEvents.DeepResearchReasoning,
            data: JSON.stringify(existingStep),
          })
        } else {
          // Fallback: create completion step if no existing step found
          const step = {
            id: metadata.item_id + "_complete",
            type: "reasoning",
            title: `Reasoning Complete (${metadata.reasoningContent.length} chars)`,
            content: metadata.reasoningContent,
            focus: "Completed reasoning analysis",
            timestamp: Date.now(),
            status: "completed",
            fullReasoningContent: metadata.reasoningContent,
          }
          deepResearchSteps.push(step)
          stream.writeSSE({
            event: ChatSSEvents.DeepResearchReasoning,
            data: JSON.stringify(step),
          })
        }
      }

      // Handle legacy reasoning text deltas (keeping for backward compatibility)
      if (metadata.type === "response.reasoning_text.delta" && metadata.delta) {
        const step = {
          id: nanoid(),
          type: "reasoning",
          title: "Reasoning",
          content: metadata.delta,
          focus: metadata.context || "Analyzing information",
          timestamp: Date.now(),
          status: "active",
        }
        deepResearchSteps.push(step)
        stream.writeSSE({
          event: ChatSSEvents.DeepResearchReasoning,
          data: JSON.stringify(step),
        })
      }

      if (
        metadata.type === "response.output_item.done" &&
        metadata.item?.type === "web_search_call"
      ) {
        const step = {
          id: nanoid(),
          type: "web_search",
          title: metadata.searchDetails?.query
            ? `Searched: ${metadata.searchDetails.query}`
            : "Web search completed",
          content: metadata.searchDetails?.url || "",
          query: metadata.searchDetails?.query,
          sourceUrl: metadata.searchDetails?.url,
          timestamp: Date.now(),
          status: "completed",
        }
        deepResearchSteps.push(step)
        stream.writeSSE({
          event: ChatSSEvents.DeepResearchReasoning,
          data: JSON.stringify(step),
        })
      }

      if (
        metadata.displayText &&
        !metadata.type?.includes("reasoning") &&
        !metadata.type?.includes("web_search")
      ) {
        const step = {
          id: nanoid(),
          type: "analysis",
          title: metadata.displayText,
          focus: metadata.displayText,
          timestamp: Date.now(),
          status: "completed",
        }
        deepResearchSteps.push(step)
        stream.writeSSE({
          event: ChatSSEvents.DeepResearchReasoning,
          data: JSON.stringify(step),
        })
      }
    }

    if (chunk.cost) {
      costArr.push(chunk.cost)
    }
    if (chunk.metadata?.usage) {
      tokenArr.push({
        inputTokens: chunk.metadata.usage.inputTokens || 0,
        outputTokens: chunk.metadata.usage.outputTokens || 0,
      })
    }
  }

  return {
    answer,
    finalText,
    finalAnnotations,
    deepResearchSteps,
    costArr,
    tokenArr,
    wasStreamClosedPrematurely,
  }
}

export function processWebSearchCitations(
  answer: string,
  allSources: WebSearchSource[],
  finalGroundingSupports: GroundingSupport[],
  citations: Citation[],
  citationMap: Record<number, number>,
  sourceIndex: number,
): {
  updatedAnswer: string
  newCitations: Citation[]
  newCitationMap: Record<number, number>
  updatedSourceIndex: number
} | null {
  if (finalGroundingSupports.length > 0 && allSources.length > 0) {
    let answerWithCitations = answer
    let newCitations: Citation[] = []
    let newCitationMap: Record<number, number> = {}
    let urlToIndexMap: Map<string, number> = new Map()

    for (const support of finalGroundingSupports) {
      const segment = support.segment
      const groundingChunkIndices = support.groundingChunkIndices || []

      let citationText = ""
      for (const chunkIndex of groundingChunkIndices) {
        if (allSources[chunkIndex]) {
          const source = allSources[chunkIndex]

          let citationIndex: number
          if (urlToIndexMap.has(source.uri)) {
            // Reuse existing citation index
            citationIndex = urlToIndexMap.get(source.uri)!
          } else {
            citationIndex = sourceIndex
            const webSearchCitation: Citation = {
              docId: `websearch_${sourceIndex}`,
              title: source.title,
              url: source.uri,
              app: Apps.WebSearch,
              entity: WebSearchEntity.WebSearch,
            }

            newCitations.push(webSearchCitation)
            newCitationMap[sourceIndex] =
              citations.length + newCitations.length - 1
            urlToIndexMap.set(source.uri, sourceIndex)
            sourceIndex++
          }

          citationText += ` [${citationIndex}]`
        }
      }

      if (
        citationText &&
        segment?.endIndex !== undefined &&
        segment.endIndex <= answerWithCitations.length
      ) {
        // Find optimal insertion point that respects word boundaries
        const optimalIndex = findOptimalCitationInsertionPoint(
          answerWithCitations,
          segment.endIndex,
        )
        answerWithCitations =
          answerWithCitations.slice(0, optimalIndex) +
          citationText +
          answerWithCitations.slice(optimalIndex)
      }
    }

    return {
      updatedAnswer: answerWithCitations,
      newCitations,
      newCitationMap,
      updatedSourceIndex: sourceIndex,
    }
  }

  return null
}

export function processOpenAICitations(
  answer: string,
  finalText: string,
  annotations: any[],
  citations: Citation[],
  citationMap: Record<number, number>,
  sourceIndex: number,
): {
  updatedAnswer: string
  newCitations: Citation[]
  newCitationMap: Record<number, number>
  updatedSourceIndex: number
} | null {
  if (!finalText) return null
  if (!annotations || annotations.length === 0)
    return {
      updatedAnswer: finalText,
      newCitations: [],
      newCitationMap: {},
      updatedSourceIndex: sourceIndex,
    }
  if (annotations.length > 0 && finalText) {
    let answerWithCitations = finalText
    let newCitations: Citation[] = []
    let newCitationMap: Record<number, number> = {}
    let urlToIndexMap: Map<string, number> = new Map()

    const urlAnnotations = annotations.filter(
      (annotation) => annotation.type === "url_citation",
    )

    for (const annotation of urlAnnotations) {
      let citationIndex: number
      if (urlToIndexMap.has(annotation.url)) {
        // Reuse existing citation index
        citationIndex = urlToIndexMap.get(annotation.url)!
      } else {
        citationIndex = sourceIndex
        const openAICitation: Citation = {
          docId: `websearch_${sourceIndex}`,
          title: annotation.title,
          url: annotation.url,
          app: Apps.WebSearch,
          entity: WebSearchEntity.WebSearch,
        }

        newCitations.push(openAICitation)
        newCitationMap[sourceIndex] = citations.length + newCitations.length - 1
        urlToIndexMap.set(annotation.url, sourceIndex)
        sourceIndex++
      }

      // Find optimal insertion point that respects word boundaries
      const optimalIndex = findOptimalCitationInsertionPoint(
        answerWithCitations,
        annotation.end_index,
      )

      const citationText = ` [${citationIndex}]`
      answerWithCitations =
        answerWithCitations.slice(0, optimalIndex) +
        citationText +
        answerWithCitations.slice(optimalIndex)
    }

    return {
      updatedAnswer: answerWithCitations,
      newCitations,
      newCitationMap,
      updatedSourceIndex: sourceIndex,
    }
  }

  return null
}
