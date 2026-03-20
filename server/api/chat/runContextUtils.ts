import { IMAGE_CONTEXT_CONFIG } from "@/config"
import type { AgentRunContext } from "./agent-schemas"
import { getAllImagesFromDocumentMemory, getFragmentsForSynthesis } from "./document-memory"

/**
 * Build a bounded, evidence-only summary of the current document memory.
 * This is injected as ephemeral USER context (not system authority).
 */
export async function getImagesFromDocumentMemory(
  context: AgentRunContext,
): Promise<string[]> {
  if (!context.documentMemory || !(context.documentMemory instanceof Map)) return []
  if (context.documentMemory.size === 0) return []

  const fragments = await getFragmentsForSynthesis(
      context.documentMemory ?? new Map(),
      {
        email: context.user.email,
        userId: context.user.numericId ?? undefined,
        workspaceId: context.user.workspaceNumericId ?? undefined,
      },
    )

  const docOrderForImages = fragments.map((f) => f.id)
    const reviewImageBudget =
      IMAGE_CONTEXT_CONFIG.maxImagesPerCall && IMAGE_CONTEXT_CONFIG.maxImagesPerCall > 0
        ? IMAGE_CONTEXT_CONFIG.maxImagesPerCall
        : 8
    const { imageFileNamesForModel: currentImages } =
      getAllImagesFromDocumentMemory(context.documentMemory ?? new Map(), {
        docOrder: docOrderForImages,
        maxImages: reviewImageBudget,
      })

  return currentImages
}
