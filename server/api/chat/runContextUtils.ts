import config from "@/config"
import { getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
import type { AgentRunContext } from "./agent-schemas"

const { IMAGE_CONTEXT_CONFIG } = config
const loggerWithChild = getLoggerWithChild(Subsystem.Chat)

export function getRecentImagesFromContext(
  context: AgentRunContext
): string[] {
  if (!IMAGE_CONTEXT_CONFIG.enabled) {
    return []
  }
  const combined = [
    ...context.currentTurnArtifacts.images,
    ...context.recentImages,
  ]

  // Fragment id -> confidence (relevance) for secondary sort
  const confidenceByFragmentId = new Map<string, number>()
  for (const fragment of context.currentTurnArtifacts.fragments) {
    if (fragment.id != null) {
      confidenceByFragmentId.set(fragment.id, fragment.confidence ?? 0)
    }
  }
  for (const fragment of context.allFragments) {
    if (fragment.id != null && !confidenceByFragmentId.has(fragment.id)) {
      confidenceByFragmentId.set(fragment.id, fragment.confidence ?? 0)
    }
  }

  const confidence = (img: (typeof combined)[0]) =>
    confidenceByFragmentId.get(img.sourceFragmentId ?? "") ?? 0

  combined.sort((a, b) => {
    if (a.isUserAttachment && !b.isUserAttachment) return -1
    if (!a.isUserAttachment && b.isUserAttachment) return 1
    const turnA = a.addedAtTurn ?? 0
    const turnB = b.addedAtTurn ?? 0
    if (turnB !== turnA) return turnB - turnA
    return confidence(b) - confidence(a)
  })
  const seen = new Set<string>()
  const fileNames: string[] = []
  for (const image of combined) {
    if (!image?.fileName || seen.has(image.fileName)) continue
    seen.add(image.fileName)
    fileNames.push(image.fileName)
    if (
      IMAGE_CONTEXT_CONFIG.maxImagesPerCall > 0 &&
      fileNames.length >= IMAGE_CONTEXT_CONFIG.maxImagesPerCall
    ) {
      break
    }
  }
  loggerWithChild({
    email: context.user.email,
  }).info(
    {
      chatId: context.chat.externalId,
      turn: context.turnCount,
      currentTurnImages: context.currentTurnArtifacts.images.map((img) => img.fileName),
      recentWindowImages: context.recentImages.map((img) => img.fileName),
      selectedImages: fileNames,
    },
    "[RunContext] Image retrieval snapshot"
  )
  return fileNames
}
