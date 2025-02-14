import { VespaSearchResultsSchema } from "@/search/types"
import { generateQuestion } from "@/ai/provider"
import fs from "fs"
import path from "node:path"
import { searchVespa } from "@/search/vespa"
import { answerContextMap, cleanContext } from "@/ai/context"
import type { z } from "zod"
import config from "@/config"
import type { Models } from "@/ai/types"

interface GeneratedQuestion {
  input: string
  expected: string
}

interface SearchResults {
  questions: GeneratedQuestion[]
  cost: number
}

interface SearchConfig {
  limit?: number
  user: string
  modelId?: Models
  outputPath?: string
}

const user = "junaid.s@xynehq.com"
async function generateRandomSearchContext(
  index: number,
  user: string,
  size = 3,
  resultsLimit = 100,
): Promise<string> {
  const result = await searchVespa(`${index}`, user, null, null, resultsLimit)

  const randomResults = result?.root?.children
    .sort(() => 0.5 - Math.random())
    .slice(0, size)

  return cleanContext(
    randomResults
      ?.map(
        (item, i) =>
          `Index ${i}\n${answerContextMap(item as z.infer<typeof VespaSearchResultsSchema>, 5)}`,
      )
      ?.join("\n"),
  )
}

async function generateRagQuestions({
  limit = 50,
  user,
  modelId = config.defaultFastModel as Models,
  outputPath = "results.json",
}: SearchConfig): Promise<SearchResults> {
  const questions: GeneratedQuestion[] = []
  let totalCost = 0

  try {
    for (let i = 0; i <= limit; i++) {
      const context = await generateRandomSearchContext(i, user)

      const { question, expected, cost } = await generateQuestion(context, {
        modelId,
        stream: false,
      })

      totalCost += cost

      if (question && expected) {
        console.log({ question, expected, cost }, "Generated question")
        questions.push({ input: question, expected })
      }
    }

    const results = { questions, cost: totalCost }
    const output = path.resolve(import.meta.dirname, outputPath)
    await fs.promises.writeFile(
      output,
      JSON.stringify(results, null, 2),
      "utf-8",
    )

    return results
  } catch (error) {
    console.error("Error generating questions:", error)
    throw error
  }
}

async function main() {
  try {
    const results = await generateRagQuestions({
      user,
    })
    console.log("Generation completed:", results)
  } catch (error) {
    console.error("Failed to generate questions:", error)
    process.exit(1)
  }
}

main()
