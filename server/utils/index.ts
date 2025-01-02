import type { Cost } from "@/ai/types"

export function getDateForAI() {
  const today = new Date()
  const options: Intl.DateTimeFormatOptions = {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }
  return today.toLocaleDateString("en-GB", options)
}

export const calculateCost = (
  { inputTokens, outputTokens }: { inputTokens: number; outputTokens: number },
  cost: Cost,
): number => {
  const inputCost = (inputTokens / 1000) * cost.pricePerThousandInputTokens
  const outputCost = (outputTokens / 1000) * cost.pricePerThousandOutputTokens
  return inputCost + outputCost
}
