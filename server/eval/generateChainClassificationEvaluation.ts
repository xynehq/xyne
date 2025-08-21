import { generateSearchQueryOrAnswerFromConversation, jsonParseLLMOutput } from "@/ai/provider"
import { Models, QueryType } from "@/ai/types"
import { Apps } from "@/search/types"
import * as fs from "fs"
import * as path from "path"
import { userContext } from "@/ai/context"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import config from "@/config"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { db } from "@/db/client"

const Logger = getLogger(Subsystem.Eval)
const { defaultBestModel } = config
const modelId = defaultBestModel || Models.Claude_3_5_Sonnet

const myEmail = ""
const workspaceExternalId = ""

if (!myEmail) throw new Error("Please set the email")
if (!workspaceExternalId) throw new Error("Please add the workspaceExternalId")

// Core interfaces
interface SyntheticScenario {
  id: string;
  description: string;
  category: string;
  conversation: ConversationTurn[];
}

interface ConversationTurn {
  turn: number;
  input: string;
  context?: {
    previousClassification?: any;
    chainBreakClassifications?: any;
  };
  expected: ExpectedClassification;
}

interface ExpectedClassification {
  answer: string | null;
  temporalDirection?: string | null;
  isFollowUp: boolean;
  type: QueryType;
  filters: {
    app?: Apps | null;
    entity?: string | null;
    count?: number | null;
    offset?: number | null;
    sortDirection?: string | null;
    intent?: any;
  };
}

interface EvaluationScores {
  isFollowUpAccuracy: number;
  typeAccuracy: number;
  filtersAccuracy: number;
  offsetAccuracy: number;
  temporalDirectionAccuracy: number;
  contextRecoveryAccuracy: number;
  overallScore: number;
}

interface ChainClassificationEvalResult {
  scenarioId: string;
  category: string;
  turn: number;
  input: string;
  expected: ExpectedClassification;
  actual: any;
  scores: EvaluationScores;
  details: {
    isFollowUpMatch: boolean;
    typeMatch: boolean;
    filtersMatch: boolean;
    offsetMatch: boolean;
    temporalDirectionMatch: boolean;
    errors: string[];
  };
  rawOutput?: string;
}

interface CategoryResults {
  category: string;
  totalScenarios: number;
  averageScore: number;
  scores: EvaluationScores;
  scenarios: ChainClassificationEvalResult[];
}

// Data loading
const loadTestData = (): SyntheticScenario[] => {
  try {
    const filePath = path.join(__dirname, "..", "..", "eval-data", "test-queries.json")
    const data = fs.readFileSync(filePath, "utf-8")
    let parsedData = JSON.parse(data)
    
    if (!Array.isArray(parsedData)) {
      throw new Error("Test data must be an array")
    }
    
    // Convert string query types to enum values
    return parsedData.map((scenario: any) => ({
      ...scenario,
      conversation: scenario.conversation.map((turn: any) => ({
        ...turn,
        expected: {
          ...turn.expected,
          type: turn.expected.type === "GetItems" ? QueryType.GetItems :
                turn.expected.type === "SearchWithFilters" ? QueryType.SearchWithFilters :
                turn.expected.type === "SearchWithoutFilters" ? QueryType.SearchWithoutFilters :
                turn.expected.type
        }
      }))
    }))
  } catch (error) {
    console.error("Error loading test data:", error)
    throw error
  }
}

const data = loadTestData()
if (!data.length) throw new Error("Data is not set for the evals")

// Evaluation functions
function evaluateFollowUpDetection(expected: boolean, actual: boolean): number {
  return expected === actual ? 1 : 0;
}

function evaluateQueryTypeClassification(expected: QueryType, actual: QueryType): number {
  return expected === actual ? 1 : 0;
}

function evaluateFiltersAccuracy(expected: any, actual: any): number {
  if (!expected && !actual) return 1;
  if (!expected || !actual) return 0;
  
  let matches = 0;
  let total = 0;
  
  // Focus only on fields that matter for chain classification
  const fieldsToCheck = ['app', 'entity', 'count', 'offset', 'sortDirection'];
  
  for (const field of fieldsToCheck) {
    if (expected[field] !== undefined) {
      total++;
      if (expected[field] === actual[field]) {
        matches++;
      }
    }
  }
  
  // Check intent object separately (important for chain context)
  if (expected.intent !== undefined) {
    total++;
    if (JSON.stringify(expected.intent || {}) === JSON.stringify(actual.intent || {})) {
      matches++;
    }
  }
  
  return total === 0 ? 1 : matches / total;
}

function evaluateOffsetCalculation(expected: number | null, actual: number | null, category: string): number {
  // Critical for follow-up and pagination scenarios
  if (category.includes('followup') || category.includes('pagination')) {
    return expected === actual ? 1 : 0;
  }
  return expected === actual ? 1 : 0; 
}

function evaluateTemporalDirection(expected: string | null, actual: string | null): number {
  return expected === actual ? 1 : 0;
}

function evaluateContextRecovery(expected: ExpectedClassification, actual: any, category: string): number {
  // Only applicable for chain-break scenarios
  if (!category.includes('chain-break') && !category.includes('reconnection')) {
    return 1; // Not applicable
  }
  
  // For chain-break scenarios, successful context recovery means:
  // 1. Correctly identifying as follow-up when it should reconnect
  // 2. Getting the right app/entity from the broken chain
  let score = 0;
  let total = 2;
  
  if (expected.isFollowUp === actual.isFollowUp) score++;
  
  // Check if app context was recovered correctly
  if (expected.filters?.app === actual.filters?.app) score++;
  
  return score / total;
}

// Main evaluation logic - simplified to focus on chain classification
function evaluateResponse({
  output,
  expected,
  input,
  category,
}: {
  output: any;
  expected: ExpectedClassification;
  input: string;
  category: string;
}) {
  console.log(`\n####### EVALUATING: "${input}" #######`)
  console.log("Expected:", JSON.stringify(expected, null, 2))
  console.log("Actual:", JSON.stringify(output, null, 2))

  // Core chain classification metrics
  const isFollowUpAccuracy = evaluateFollowUpDetection(expected.isFollowUp, output.isFollowUp || false);
  const typeAccuracy = evaluateQueryTypeClassification(expected.type, output.type);
  const filtersAccuracy = evaluateFiltersAccuracy(expected.filters, output.filters || {});
  const offsetAccuracy = evaluateOffsetCalculation(
    expected.filters?.offset || null, 
    output.filters?.offset || null, 
    category
  );
  const temporalDirectionAccuracy = evaluateTemporalDirection(
    expected.temporalDirection || null,
    output.temporalDirection || null
  );
  const contextRecoveryAccuracy = evaluateContextRecovery(expected, output, category);
  
  // Weights focused on chain logic - FIXED to add up to 1.0
  let weights = {
    isFollowUp: 0.4,           // Most critical - determines if chain logic is used
    type: 0.25,                // Important for query execution
    filters: 0.15,             // Context preservation
    offset: 0.05,              // Pagination logic
    temporalDirection: 0.1,    // Temporal context preservation
    contextRecovery: 0.05      // Chain reconnection
  };
  // Total: 0.4 + 0.25 + 0.15 + 0.05 + 0.1 + 0.05 = 1.0 ✅
  
  // Adjust for specific scenarios
  if (category.includes('followup')) {
    weights = { isFollowUp: 0.3, type: 0.25, filters: 0.2, offset: 0.15, temporalDirection: 0.1, contextRecovery: 0 };
    // Total: 0.3 + 0.25 + 0.2 + 0.15 + 0.1 + 0 = 1.0 ✅
  } else if (category.includes('chain-break')) {
    weights = { isFollowUp: 0.25, type: 0.2, filters: 0.2, offset: 0.05, temporalDirection: 0.1, contextRecovery: 0.2 };
    // Total: 0.25 + 0.2 + 0.2 + 0.05 + 0.1 + 0.2 = 1.0 ✅
  }
  
  const overallScore = (
    isFollowUpAccuracy * weights.isFollowUp +
    typeAccuracy * weights.type +
    filtersAccuracy * weights.filters +
    offsetAccuracy * weights.offset +
    temporalDirectionAccuracy * weights.temporalDirection +
    contextRecoveryAccuracy * weights.contextRecovery
  );

  const status = overallScore === 1 ? "✅ Perfect" :
                overallScore > 0.8 ? "🟢 Good" :
                overallScore > 0.5 ? "🟡 Fair" : "🔴 Poor";

  // Enhanced logging with weights
  console.log(
    `Chain Scores: Follow-up: ${(isFollowUpAccuracy * 100).toFixed(0)}% (${(weights.isFollowUp * 100).toFixed(0)}%), Type: ${(typeAccuracy * 100).toFixed(0)}% (${(weights.type * 100).toFixed(0)}%), Filters: ${(filtersAccuracy * 100).toFixed(0)}% (${(weights.filters * 100).toFixed(0)}%), Offset: ${(offsetAccuracy * 100).toFixed(0)}% (${(weights.offset * 100).toFixed(0)}%), Temporal: ${(temporalDirectionAccuracy * 100).toFixed(0)}% (${(weights.temporalDirection * 100).toFixed(0)}%) → ${(overallScore * 100).toFixed(1)}% ${status}`,
  )

  // Add detailed calculation breakdown
  console.log(
    `Calculation: ${(isFollowUpAccuracy * 100).toFixed(0)}%×${(weights.isFollowUp * 100).toFixed(0)}% + ${(typeAccuracy * 100).toFixed(0)}%×${(weights.type * 100).toFixed(0)}% + ${(filtersAccuracy * 100).toFixed(0)}%×${(weights.filters * 100).toFixed(0)}% + ${(offsetAccuracy * 100).toFixed(0)}%×${(weights.offset * 100).toFixed(0)}% + ${(temporalDirectionAccuracy * 100).toFixed(0)}%×${(weights.temporalDirection * 100).toFixed(0)}% = ${(overallScore * 100).toFixed(1)}%`
  )

  return {
    scores: {
      isFollowUpAccuracy,
      typeAccuracy,
      filtersAccuracy,
      offsetAccuracy,
      temporalDirectionAccuracy,
      contextRecoveryAccuracy,
      overallScore
    }
  };
}

// File operations
function saveResults(results: ChainClassificationEvalResult[], categoryResults: CategoryResults[], avgScore: number) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const outputDir = path.join(process.cwd(), "eval-results", "chain-classification")
  
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  // Save JSON results
  const jsonFile = `chain-classification-eval-${timestamp}.json`
  const jsonPath = path.join(outputDir, jsonFile)
  fs.writeFileSync(jsonPath, JSON.stringify({ averageScore: avgScore, results, categoryResults }, null, 2))
  
  // Save summary log
  const txtFile = `chain-classification-eval-summary-${timestamp}.txt`
  const txtPath = path.join(outputDir, txtFile)
  const logContent = generateSummaryLog(results, categoryResults, avgScore)
  fs.writeFileSync(txtPath, logContent)
  
  Logger.info(`Results saved to: ${jsonFile}`)
  Logger.info(`Summary saved to: ${txtFile}`)
  
  return { jsonFile, txtFile }
}

function generateSummaryLog(results: ChainClassificationEvalResult[], categoryResults: CategoryResults[], overallScore: number): string {
  let log = `=== CHAIN CLASSIFICATION EVALUATION RESULTS ===\n\n`;
  log += `Date: ${new Date().toISOString()}\n`;
  log += `Model: ${modelId}\n`;
  log += `Total Evaluations: ${results.length}\n`;
  log += `Overall Score: ${(overallScore * 100).toFixed(1)}%\n\n`;
  
  // Category breakdown
  log += `CATEGORY BREAKDOWN:\n${'='.repeat(50)}\n`;
  for (const cat of categoryResults) {
    log += `${cat.category}: ${(cat.averageScore * 100).toFixed(1)}% (${cat.totalScenarios} scenarios)\n`;
    log += `  Follow-up Detection: ${(cat.scores.isFollowUpAccuracy * 100).toFixed(1)}%\n`;
    log += `  Type Classification: ${(cat.scores.typeAccuracy * 100).toFixed(1)}%\n`;
    log += `  Filters Accuracy: ${(cat.scores.filtersAccuracy * 100).toFixed(1)}%\n`;
    log += `  Offset Calculation: ${(cat.scores.offsetAccuracy * 100).toFixed(1)}%\n`;
    log += `  Temporal Direction: ${(cat.scores.temporalDirectionAccuracy * 100).toFixed(1)}%\n`;
    log += `  Context Recovery: ${(cat.scores.contextRecoveryAccuracy * 100).toFixed(1)}%\n`;
    log += '\n';
  }
  
  // Worst performers
  return log;
}

// Main scenario evaluation - REMOVE the JSON logging here
async function evaluateScenario(scenario: SyntheticScenario, userCtx: string): Promise<ChainClassificationEvalResult[]> {
  const results: ChainClassificationEvalResult[] = [];
  
  for (const turn of scenario.conversation) {
    Logger.info(`Processing Scenario ${scenario.id} - Turn ${turn.turn}: "${turn.input}"`);

    try {
      const searchQueryOutput = await generateSearchQueryOrAnswerFromConversation(
        turn.input,
        userCtx,
        { modelId, stream: true, json: true },
        undefined,
        turn.context?.previousClassification || null,
        turn.context?.chainBreakClassifications || null
      )

      let output: any = {
        answer: null,
        isFollowUp: false,
        type: null,
        filters: {},
      }
      let buffer = ""

      // Handle streaming response
      if (searchQueryOutput && typeof searchQueryOutput === "object" && typeof searchQueryOutput[Symbol.asyncIterator] === "function") {
        for await (const chunk of searchQueryOutput) {
          if (chunk.text) {
            buffer += chunk.text
          }
        }
      } else {
        buffer = JSON.stringify(searchQueryOutput)
      }

      try {
        output = jsonParseLLMOutput(buffer) || output
      } catch (err) {
        Logger.error(`Failed to parse LLM output for query "${turn.input}": ${err}`)
      }

      const { scores } = evaluateResponse({
        output,
        expected: turn.expected,
        input: turn.input,
        category: scenario.category,
      })

      const result: ChainClassificationEvalResult = {
        scenarioId: scenario.id,
        category: scenario.category,
        turn: turn.turn,
        input: turn.input,
        expected: turn.expected,
        actual: output,
        scores: scores,
        details: {
          isFollowUpMatch: scores.isFollowUpAccuracy === 1,
          typeMatch: scores.typeAccuracy === 1,
          filtersMatch: scores.filtersAccuracy === 1,
          offsetMatch: scores.offsetAccuracy === 1,
          temporalDirectionMatch: scores.temporalDirectionAccuracy === 1,
          errors: []
        },
        rawOutput: buffer,
      }

      results.push(result)

    } catch (error) {
      Logger.error(`Error evaluating Scenario ${scenario.id} - Turn ${turn.turn}:`, error)

      const errorResult: ChainClassificationEvalResult = {
        scenarioId: scenario.id,
        category: scenario.category,
        turn: turn.turn,
        input: turn.input,
        expected: turn.expected,
        actual: null,
        scores: {
          isFollowUpAccuracy: 0,
          typeAccuracy: 0,
          filtersAccuracy: 0,
          offsetAccuracy: 0,
          temporalDirectionAccuracy: 0,
          contextRecoveryAccuracy: 0,
          overallScore: 0
        },
        details: {
          isFollowUpMatch: false,
          typeMatch: false,
          filtersMatch: false,
          offsetMatch: false,
          temporalDirectionMatch: false,
          errors: [error instanceof Error ? error.message : String(error)]
        }
      }

      results.push(errorResult)
    }
  }

  return results
}

function calculateCategoryResults(results: ChainClassificationEvalResult[]): CategoryResults[] {
  const categoryMap = new Map<string, ChainClassificationEvalResult[]>();
  
  for (const result of results) {
    if (!categoryMap.has(result.category)) {
      categoryMap.set(result.category, []);
    }
    categoryMap.get(result.category)!.push(result);
  }
  
  return Array.from(categoryMap.entries()).map(([category, categoryResults]) => {
    const totalScenarios = categoryResults.length;
    
    // Calculate averages for all metrics with proper typing
    const avgScores: EvaluationScores = {
      isFollowUpAccuracy: 0,
      typeAccuracy: 0,
      filtersAccuracy: 0,
      offsetAccuracy: 0,
      temporalDirectionAccuracy: 0,
      contextRecoveryAccuracy: 0,
      overallScore: 0
    };
    
    // Sum all scores
    for (const result of categoryResults) {
      avgScores.isFollowUpAccuracy += result.scores.isFollowUpAccuracy;
      avgScores.typeAccuracy += result.scores.typeAccuracy;
      avgScores.filtersAccuracy += result.scores.filtersAccuracy;
      avgScores.offsetAccuracy += result.scores.offsetAccuracy;
      avgScores.temporalDirectionAccuracy += result.scores.temporalDirectionAccuracy;
      avgScores.contextRecoveryAccuracy += result.scores.contextRecoveryAccuracy;
      avgScores.overallScore += result.scores.overallScore;
    }
    
    // Calculate averages
    avgScores.isFollowUpAccuracy /= totalScenarios;
    avgScores.typeAccuracy /= totalScenarios;
    avgScores.filtersAccuracy /= totalScenarios;
    avgScores.offsetAccuracy /= totalScenarios;
    avgScores.temporalDirectionAccuracy /= totalScenarios;
    avgScores.contextRecoveryAccuracy /= totalScenarios;
    avgScores.overallScore /= totalScenarios;
    
    return {
      category,
      totalScenarios,
      averageScore: avgScores.overallScore,
      scores: avgScores,
      scenarios: categoryResults
    };
  }).sort((a, b) => b.averageScore - a.averageScore);
}

// Main execution
async function runEvaluation(userCtx: string) {
  const results: ChainClassificationEvalResult[] = [];
  Logger.info("Starting chain classification evaluation...");

  for (const scenario of data) {
    Logger.info(`Processing scenario: ${scenario.id} (${scenario.category})`);
    const scenarioResults = await evaluateScenario(scenario, userCtx);
    results.push(...scenarioResults);
  }

  const categoryResults = calculateCategoryResults(results);
  const avgScore = results.reduce((sum, r) => sum + r.scores.overallScore, 0) / results.length;

  // Console output
  console.log('\n=== CHAIN CLASSIFICATION EVALUATION RESULTS ===');
  console.log(`Overall Score: ${(avgScore * 100).toFixed(1)}%`);
  console.log(`Total Evaluations: ${results.length}`);
  console.log('\nCategory Breakdown:');
  for (const cat of categoryResults) {
    console.log(`  ${cat.category}: ${(cat.averageScore * 100).toFixed(1)}% (${cat.totalScenarios} scenarios)`);
  }

  saveResults(results, categoryResults, avgScore);
  return { avgScore, results, categoryResults };
}

const callRunEvaluation = async () => {
  try {
    const userAndWorkspace = await getUserAndWorkspaceByEmail(db, workspaceExternalId, myEmail);
    if (!userAndWorkspace) {
      throw new Error(`User not found for email: ${myEmail}`);
    }
    const ctx = userContext(userAndWorkspace);
    return await runEvaluation(ctx);
  } catch (error) {
    Logger.error("Failed to fetch user and workspace:", error);
    throw error;
  }
};

async function main() {
  try {
    console.log('Starting chain classification evaluation...');
    console.log(`Loaded ${data.length} scenarios`);
    
    const results = await callRunEvaluation();
    console.log(`\nEvaluation completed with score: ${(results.avgScore * 100).toFixed(1)}%`);
    process.exit(0);
  } catch (error) {
    console.error('Evaluation failed:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export { evaluateScenario, calculateCategoryResults, callRunEvaluation as runChainClassificationEval };