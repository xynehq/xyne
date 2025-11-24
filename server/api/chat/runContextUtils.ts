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
  combined.sort((a, b) => {
    if (a.isUserAttachment && !b.isUserAttachment) return -1
    if (!a.isUserAttachment && b.isUserAttachment) return 1
    return (b.addedAtTurn ?? 0) - (a.addedAtTurn ?? 0)
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
