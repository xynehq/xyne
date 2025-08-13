import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import { CURRENCY } from "./constants"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// this helps prevent typescript from
// being bothered by the error in the catch
export const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Matches URLs starting with 'http://' or 'https://'.
 */
const URL_REGEX: RegExp = /\bhttps?:\/\/[^\s/$.?#].[^\s]*\b/gi
/**
 * Replaces URLs in the given text with placeholders in the format '[link: domain.tld]'.
 *
 * @param text - The text in which to replace URLs.
 * @returns The text with URLs replaced by placeholders.
 */
export const replaceLinks = (text: string): string => {
  return text.replace(URL_REGEX, (match: string): string => {
    try {
      const parsedUrl: URL = new URL(match)
      const domain: string = parsedUrl.hostname
      return `${domain}`
    } catch (e) {
      // If URL parsing fails, return the original match
      return match
    }
  })
}

export const humanizeNumbers = (num: number): string => {
  if (num < 1000) return num.toString()

  const units = ["k", "M", "B", "T"]
  const exponent = Math.floor(Math.log10(num) / 3)
  const unit = units[exponent - 1]
  const scaledNum = num / Math.pow(1000, exponent)

  // Use Intl.NumberFormat to format the number
  const formatter = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: scaledNum < 10 ? 1 : 0,
  })

  return `${formatter.format(scaledNum)}${unit}`
}

// [1,2,3] -> [1] [2] [3]
export const splitGroupedCitationsWithSpaces = (text: string): string => {
  if (!text || typeof text !== "string") {
    throw new Error("Invalid input text")
  }

  // Only match groups containing numbers, commas and spaces
  return text.replace(
    /\[(\d+(?:\s*,\s*\d+)*)\]/g,
    (match: string, group: string) => {
      // Split by comma and clean each number
      const numbers = group
        .split(",")
        .map((n: string) => n.trim())
        .filter((n: string) => n.length > 0)

      // If no valid numbers found, return original match
      if (numbers.length === 0) {
        return match
      }

      return numbers.map((num: string) => `[${num}]`).join(" ")
    },
  )
}

// Utility function to safely convert cost values (which may be strings from numeric type) to numbers
export const safeNumberConversion = (value: any): number => {
  if (typeof value === "number") return value
  if (typeof value === "string") return parseFloat(value) || 0
  return 0
}

// Utility function to convert USD to INR and format as currency
export const formatCostInINR = (usdAmount: any): string => {
  const usdValue = safeNumberConversion(usdAmount)
  const inrValue = usdValue * CURRENCY.USD_TO_INR_RATE
  return `${CURRENCY.INR_SYMBOL}${inrValue.toFixed(2)}`
}

// Utility function for cost per message in INR
export const formatCostPerMessageInINR = (
  totalCost: any,
  messageCount: number,
): string => {
  if (messageCount === 0) return `${CURRENCY.INR_SYMBOL}0.00`
  const usdValue = safeNumberConversion(totalCost)
  const inrValue = (usdValue * CURRENCY.USD_TO_INR_RATE) / messageCount
  return `${CURRENCY.INR_SYMBOL}${inrValue.toFixed(4)}`
}
