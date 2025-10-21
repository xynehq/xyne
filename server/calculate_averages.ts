import * as fs from "fs/promises"
import * as path from "path"

// Interface matching the structure in slack_both_eval_2params.json
interface EvaluationResult {
  question_type: number
  vagueness: number
  question: string
  answer: string
  source_thread_id?: string
  model_answer_non_agentic: string
  model_answer_agentic: string
  score_Non_agentic?: {
    Factuality: number
    Completeness: number
    Reason: string
    Insights: string
  }
  score_agentic?: {
    Factuality: number
    Completeness: number
    Reason: string
    Insights: string
  }
  overall_score_agentic?: number
  overall_score_non_agentic?: number
}

interface AverageResults {
  total_items: number
  average_score_Non_agentic: {
    Factuality: number
    Completeness: number
  }
  average_score_agentic: {
    Factuality: number
    Completeness: number
  }
  average_overall_score_agentic: number
  average_overall_score_non_agentic: number
}

async function calculateAverages(
  inputFilePath: string,
): Promise<AverageResults> {
  console.log(`📖 Reading file: ${inputFilePath}`)

  try {
    // Read and parse the JSON file
    const fileContent = await fs.readFile(inputFilePath, "utf-8")
    const data: EvaluationResult[] = JSON.parse(fileContent)

    console.log(`✅ Found ${data.length} evaluation results`)

    // Initialize counters and sums
    let nonAgenticFactualitySum = 0
    let nonAgenticCompletenessSum = 0
    let nonAgenticCount = 0

    let agenticFactualitySum = 0
    let agenticCompletenessSum = 0
    let agenticCount = 0

    let overallAgenticSum = 0
    let overallNonAgenticSum = 0
    let overallCount = 0

    // Process each evaluation result
    data.forEach((item, index) => {
      // Process Non-Agentic scores
      if (
        item.score_Non_agentic &&
        typeof item.score_Non_agentic.Factuality === "number" &&
        typeof item.score_Non_agentic.Completeness === "number"
      ) {
        nonAgenticFactualitySum += item.score_Non_agentic.Factuality
        nonAgenticCompletenessSum += item.score_Non_agentic.Completeness
        nonAgenticCount++
      }

      // Process Agentic scores
      if (
        item.score_agentic &&
        typeof item.score_agentic.Factuality === "number" &&
        typeof item.score_agentic.Completeness === "number"
      ) {
        agenticFactualitySum += item.score_agentic.Factuality
        agenticCompletenessSum += item.score_agentic.Completeness
        agenticCount++
      }

      // Process Overall scores
      if (
        typeof item.overall_score_agentic === "number" &&
        typeof item.overall_score_non_agentic === "number"
      ) {
        overallAgenticSum += item.overall_score_agentic
        overallNonAgenticSum += item.overall_score_non_agentic
        overallCount++
      }
    })

    // Calculate averages
    const averageResults: AverageResults = {
      total_items: data.length,
      average_score_Non_agentic: {
        Factuality:
          nonAgenticCount > 0
            ? Math.round((nonAgenticFactualitySum / nonAgenticCount) * 100) /
              100
            : 0,
        Completeness:
          nonAgenticCount > 0
            ? Math.round((nonAgenticCompletenessSum / nonAgenticCount) * 100) /
              100
            : 0,
      },
      average_score_agentic: {
        Factuality:
          agenticCount > 0
            ? Math.round((agenticFactualitySum / agenticCount) * 100) / 100
            : 0,
        Completeness:
          agenticCount > 0
            ? Math.round((agenticCompletenessSum / agenticCount) * 100) / 100
            : 0,
      },
      average_overall_score_agentic:
        overallCount > 0
          ? Math.round((overallAgenticSum / overallCount) * 10000) / 10000
          : 0,
      average_overall_score_non_agentic:
        overallCount > 0
          ? Math.round((overallNonAgenticSum / overallCount) * 10000) / 10000
          : 0,
    }

    // Log detailed statistics
    console.log(`\n📊 CALCULATION SUMMARY:`)
    console.log(`📋 Total items processed: ${data.length}`)
    console.log(`📋 Non-Agentic scores processed: ${nonAgenticCount}`)
    console.log(`📋 Agentic scores processed: ${agenticCount}`)
    console.log(`📋 Overall scores processed: ${overallCount}`)

    console.log(`\n📈 RESULTS:`)
    console.log(
      `📊 Average Non-Agentic Factuality: ${averageResults.average_score_Non_agentic.Factuality}`,
    )
    console.log(
      `📊 Average Non-Agentic Completeness: ${averageResults.average_score_Non_agentic.Completeness}`,
    )
    console.log(
      `📊 Average Agentic Factuality: ${averageResults.average_score_agentic.Factuality}`,
    )
    console.log(
      `📊 Average Agentic Completeness: ${averageResults.average_score_agentic.Completeness}`,
    )
    console.log(
      `📊 Average Overall Score Agentic: ${averageResults.average_overall_score_agentic}`,
    )
    console.log(
      `📊 Average Overall Score Non-Agentic: ${averageResults.average_overall_score_non_agentic}`,
    )

    return averageResults
  } catch (error) {
    console.error(`❌ Error calculating averages:`, error)
    throw error
  }
}

async function saveResults(
  averages: AverageResults,
  outputFilePath: string,
): Promise<void> {
  try {
    const outputContent = JSON.stringify(averages, null, 2)
    await fs.writeFile(outputFilePath, outputContent, "utf-8")
    console.log(`💾 Results saved to: ${outputFilePath}`)
  } catch (error) {
    console.error(`❌ Error saving results:`, error)
    throw error
  }
}

// Main function
async function main() {
  const args = process.argv.slice(2)

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
📊 Average Calculator for Slack Evaluation Results

Usage: bun run calculate_averages.ts [input_file.json] [output_file.json]

Parameters:
  input_file.json   - Input JSON file with evaluation results (default: slack_both_eval_2params.json)
  output_file.json  - Output file for averages (default: slack_evaluation_averages.json)

Examples:
  bun run calculate_averages.ts
  bun run calculate_averages.ts custom_input.json
  bun run calculate_averages.ts custom_input.json custom_output.json

This script calculates:
- Average Non-Agentic Factuality and Completeness scores
- Average Agentic Factuality and Completeness scores  
- Average Overall scores for both Agentic and Non-Agentic models
        `)
    process.exit(0)
  }

  // Default file paths
  const defaultInputFile = "slack_both_eval_2params.json"
  const defaultOutputFile = "slack_evaluation_averages.json"

  const inputFile = args[0] || defaultInputFile
  const outputFile = args[1] || defaultOutputFile

  console.log(`🎯 Input file: ${inputFile}`)
  console.log(`🎯 Output file: ${outputFile}`)

  try {
    const inputPath = path.resolve(path.dirname(__filename), inputFile)
    const outputPath = path.resolve(path.dirname(__filename), outputFile)

    const averages = await calculateAverages(inputPath)
    await saveResults(averages, outputPath)

    console.log(`\n🎉 Average calculation completed successfully!`)
  } catch (error) {
    console.error(`❌ Process failed:`, error)
    process.exit(1)
  }
}

// Run if called directly
if (require.main === module) {
  main()
}

export type { AverageResults }
export { calculateAverages }
