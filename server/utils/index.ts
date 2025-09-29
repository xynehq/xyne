import type { Cost } from "@/ai/types"

export function getDateForAI({
  userTimeZone,
}: { userTimeZone: string }): string {
  const today = new Date()
  const day = today.getDate()
  const year = today.getFullYear()

  const options: Intl.DateTimeFormatOptions = {
    month: "long",
    timeZone: userTimeZone || "Asia/Kolkata",
  } // or dynamically detect user's tz
  const monthName = today.toLocaleDateString("en-US", options) // "en-US" is common for full month names

  let daySuffix = "th"
  if (day === 1 || day === 21 || day === 31) {
    daySuffix = "st"
  } else if (day === 2 || day === 22) {
    daySuffix = "nd"
  } else if (day === 3 || day === 23) {
    daySuffix = "rd"
  }

  // Pad day with leading zero if it's a single digit
  const dayFormatted = day < 10 ? `0${day}` : `${day}`

  return `Current Date : ${dayFormatted}${daySuffix} ${monthName} ${year}`
}

export const calculateCost = (
  { inputTokens, outputTokens }: { inputTokens: number; outputTokens: number },
  cost: Cost,
): number => {
  const inputCost = (inputTokens / 1000) * cost.pricePerThousandInputTokens
  const outputCost = (outputTokens / 1000) * cost.pricePerThousandOutputTokens
  return inputCost + outputCost
}
