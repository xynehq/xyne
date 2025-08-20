import { generateSearchQueryOrAnswerFromConversation, jsonParseLLMOutput } from "@/ai/provider"
import { Models, QueryType } from "@/ai/types"
import { Apps, MailEntity, DriveEntity, CalendarEntity, SlackEntity } from "@/search/types"
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

const myEmail = "vipul@rbi.in"  // Update this with a valid email
const workspaceId = "fw92sus8er24m2biq2xegwg2"     // Update this with a valid workspace ID

if (!myEmail) throw new Error("Please set the email")
if (!workspaceId) throw new Error("Please add the workspaceId")

// Types for evaluation
interface SyntheticScenario {
  id: string;
  description: string;
  category: string;
  conversation: ConversationTurn[];
  chainBreakScenario?: boolean;
  multiChainScenario?: boolean;
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
  queryRewrite: string | null;
  temporalDirection: string | null;
  isFollowUp: boolean;
  type: QueryType;
  filterQuery: string | null;
  filters: {
    app?: Apps | null;
    entity?: string | null;
    count?: number | null;
    offset?: number | null;
    startTime?: string | null;
    endTime?: string | null;
    sortDirection?: string | null;
    intent?: any;
  };
  shouldCreateChain?: boolean;
  shouldBreakChain?: boolean;
  shouldReconnectChain?: boolean;
  expectedChainId?: string;
}

interface EvaluationScores {
  isFollowUpAccuracy: number;
  typeAccuracy: number;
  filtersAccuracy: number;
  offsetAccuracy: number;
  chainManagementAccuracy: number;
  queryRewriteAccuracy: number;
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
    chainFlagsMatch: boolean;
    queryRewriteMatch: boolean;
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

type Data = SyntheticScenario;

const loadTestData = (): Data[] => {
  try {
    // Updated path to point to the correct file
    const filePath = path.join(
      __dirname,
      "..",
      "..",
      "eval-data",
      "test-queries.json",
    )
    const data = fs.readFileSync(filePath, "utf-8")
    let parsedData = JSON.parse(data)
    
    if (!Array.isArray(parsedData))
      throw new Error("Test data must be an array")
    
    // Convert string query types to enum values
    parsedData = parsedData.map((scenario: any) => ({
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
    
    return parsedData
  } catch (error) {
    console.error("Error loading test data:", error)
    throw error
  }
}

// Load data once
const data = loadTestData()
if (!data.length) throw new Error("Data is not set for the evals")

function compareArguments(
  expectedArgs: Record<string, any>,
  actualArgs: Record<string, any>,
): number {
  let matched = 0
  const expectedKeys = Object.keys(expectedArgs)
  for (const key of expectedKeys) {
    if (key in actualArgs) matched++
  }
  return expectedKeys.length === 0 ? 1 : matched / expectedKeys.length
}

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
  
  const fieldsToCheck = ['app', 'entity', 'count', 'offset', 'startTime', 'endTime', 'sortDirection'];
  
  for (const field of fieldsToCheck) {
    if (expected[field] !== undefined) {
      total++;
      if (expected[field] === actual[field]) {
        matches++;
      }
    }
  }
  
  // Check intent object separately if it exists
  if (expected.intent !== undefined) {
    total++;
    if (JSON.stringify(expected.intent || {}) === JSON.stringify(actual.intent || {})) {
      matches++;
    }
  }
  
  return total === 0 ? 1 : matches / total;
}

function evaluateOffsetCalculation(expected: number | null, actual: number | null, category: string): number {
  // Offset is critical for pagination scenarios
  if (category.includes('pagination') || category.includes('followup')) {
    return expected === actual ? 1 : 0;
  }
  // For non-pagination scenarios, offset accuracy is less critical
  return expected === actual ? 1 : 0.8;
}

function evaluateChainManagement(expected: ExpectedClassification, actual: any): number {
  let score = 0;
  let total = 0;
  
  if (expected.shouldCreateChain !== undefined) {
    total++;
    if (expected.shouldCreateChain === actual.shouldCreateChain) score++;
  }
  
  if (expected.shouldBreakChain !== undefined) {
    total++;
    if (expected.shouldBreakChain === actual.shouldBreakChain) score++;
  }
  
  if (expected.shouldReconnectChain !== undefined) {
    total++;
    if (expected.shouldReconnectChain === actual.shouldReconnectChain) score++;
  }
  
  return total > 0 ? score / total : 1;
}

function evaluateQueryRewrite(expected: string | null, actual: string | null): number {
  if (expected === null && actual === null) return 1;
  if (expected === null || actual === null) return 0;
  
  // For query rewrite, we can be more lenient - check if key concepts match
  const expectedLower = expected.toLowerCase();
  const actualLower = actual.toLowerCase();
  
  if (expectedLower === actualLower) return 1;
  
  // Check if actual contains the key concepts from expected
  const expectedWords = expectedLower.split(' ').filter(w => w.length > 2);
  const actualWords = actualLower.split(' ');
  
  const matchingWords = expectedWords.filter(word => 
    actualWords.some(actualWord => actualWord.includes(word) || word.includes(actualWord))
  );
  
  return expectedWords.length > 0 ? matchingWords.length / expectedWords.length : 1;
}

function evaluateContextRecovery(expected: ExpectedClassification, actual: any, category: string): number {
  // Context recovery is critical for chain-break scenarios
  if (category.includes('chain-break') || category.includes('reconnection')) {
    let score = 0;
    let total = 0;
    
    // Check if the system correctly identified this as a follow-up requiring context recovery
    total++;
    if (expected.isFollowUp === actual.isFollowUp) score++;
    
    // Check if query rewrite happened correctly for ambiguous queries
    if (expected.queryRewrite !== null) {
      total++;
      if (actual.queryRewrite !== null) score++;
    }
    
    return total > 0 ? score / total : 1;
  }
  
  return 1; // Not applicable for non-context-recovery scenarios
}

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
  console.log("####### EVALUATING CHAIN CLASSIFICATION ########")
  console.log("Input:", input)
  console.log("Generated classification:", JSON.stringify(output, null, 2))
  console.log("Expected classification:", JSON.stringify(expected, null, 2))

  // Calculate individual scores
  const isFollowUpAccuracy = evaluateFollowUpDetection(expected.isFollowUp, output.isFollowUp || false);
  const typeAccuracy = evaluateQueryTypeClassification(expected.type, output.type);
  const filtersAccuracy = evaluateFiltersAccuracy(expected.filters, output.filters || {});
  const offsetAccuracy = evaluateOffsetCalculation(
    expected.filters?.offset || null, 
    output.filters?.offset || null, 
    category
  );
  const chainManagementAccuracy = evaluateChainManagement(expected, output);
  const queryRewriteAccuracy = evaluateQueryRewrite(expected.queryRewrite, output.queryRewrite || null);
  const contextRecoveryAccuracy = evaluateContextRecovery(expected, output, category);
  
  // Calculate overall score with weights based on scenario category
  let weights = {
    isFollowUp: 0.2,
    type: 0.2,
    filters: 0.2,
    offset: 0.1,
    chainManagement: 0.1,
    queryRewrite: 0.1,
    contextRecovery: 0.1
  };
  
  // Adjust weights based on scenario category
  if (category.includes('pagination')) {
    weights.offset = 0.3;
    weights.filters = 0.3;
  } else if (category.includes('chain-break')) {
    weights.contextRecovery = 0.3;
    weights.queryRewrite = 0.2;
  } else if (category.includes('pronoun')) {
    weights.queryRewrite = 0.3;
    weights.contextRecovery = 0.2;
  }
  
  const overallScore = (
    isFollowUpAccuracy * weights.isFollowUp +
    typeAccuracy * weights.type +
    filtersAccuracy * weights.filters +
    offsetAccuracy * weights.offset +
    chainManagementAccuracy * weights.chainManagement +
    queryRewriteAccuracy * weights.queryRewrite +
    contextRecoveryAccuracy * weights.contextRecovery
  );

  console.log(
    `Follow-up: ${(isFollowUpAccuracy * 100).toFixed(1)}%, Type: ${(typeAccuracy * 100).toFixed(1)}%, Filters: ${(filtersAccuracy * 100).toFixed(1)}%, Offset: ${(offsetAccuracy * 100).toFixed(1)}%, Chain: ${(chainManagementAccuracy * 100).toFixed(1)}%, Query Rewrite: ${(queryRewriteAccuracy * 100).toFixed(1)}%, Context: ${(contextRecoveryAccuracy * 100).toFixed(1)}%`,
  )

  if (overallScore === 1) {
    console.log("✅ Full match")
  } else if (overallScore > 0.7) {
    console.log("⚠️ Good match")
  } else if (overallScore > 0.3) {
    console.log("⚠️ Partial match")
  } else {
    console.log("❌ Poor match")
  }

  return { 
    score: overallScore,
    scores: {
      isFollowUpAccuracy,
      typeAccuracy,
      filtersAccuracy,
      offsetAccuracy,
      chainManagementAccuracy,
      queryRewriteAccuracy,
      contextRecoveryAccuracy,
      overallScore
    }
  };
}

function saveEvalResults(
  evaluation: { averageScore: number; results: any[]; categoryResults: CategoryResults[] },
  name: string,
) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const fileName = `${name}-${timestamp}.json`
  const outputDir = path.join(process.cwd(), "eval-results", "chain-classification")
  const filePath = path.join(outputDir, fileName)

  // Ensure directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  try {
    fs.writeFileSync(filePath, JSON.stringify(evaluation, null, 2))
    Logger.info(`Chain classification evaluation results saved to: ${filePath}`)
    return fileName
  } catch (error) {
    Logger.error(`Failed to save evaluation results to ${filePath}: ${error}`)
    throw error
  }
}

async function evaluateScenario(scenario: SyntheticScenario, userCtx: string): Promise<ChainClassificationEvalResult[]> {
  const results: ChainClassificationEvalResult[] = [];
  
  for (const turn of scenario.conversation) {
    Logger.info(`Processing ${scenario.id} - Turn ${turn.turn}: "${turn.input}"`);

    try {
      // Call generateSearchQueryOrAnswerFromConversation following the same pattern as tool evaluation
      const searchQueryOutput = await generateSearchQueryOrAnswerFromConversation(
        turn.input,
        userCtx,
        { modelId, stream: true, json: true },
        undefined, // toolContext
        turn.context?.previousClassification || null,
        turn.context?.chainBreakClassifications || null
      )

      let output: any = {
        answer: null,
        isFollowUp: false,
        type: null,
        queryRewrite: null,
        filters: {},
      }
      let buffer = ""

      if (
        searchQueryOutput &&
        typeof searchQueryOutput === "object" &&
        typeof searchQueryOutput[Symbol.asyncIterator] === "function"
      ) {
        for await (const chunk of searchQueryOutput) {
          if (chunk.text) {
            buffer += chunk.text
          }
        }
      } else {
        buffer = JSON.stringify(searchQueryOutput)
      }

      Logger.info(`Raw LLM output for query "${turn.input}": ${buffer}`)

      try {
        output = jsonParseLLMOutput(buffer) || {
          answer: null,
          isFollowUp: false,
          type: null,
          queryRewrite: null,
          filters: {},
        }
        Logger.info(`Parsed output: ${JSON.stringify(output, null, 2)}`)
      } catch (err) {
        Logger.error(
          `Failed to parse LLM output for query "${turn.input}": ${buffer}`,
        )
        Logger.error(`Error: ${err}`)
      }

      const { score, scores } = evaluateResponse({
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
          chainFlagsMatch: scores.chainManagementAccuracy === 1,
          queryRewriteMatch: scores.queryRewriteAccuracy === 1,
          errors: []
        },
        rawOutput: buffer,
      }

      results.push(result)

    } catch (error) {
      Logger.error(`Error evaluating ${scenario.id} - Turn ${turn.turn}:`, error)

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
          chainManagementAccuracy: 0,
          queryRewriteAccuracy: 0,
          contextRecoveryAccuracy: 0,
          overallScore: 0
        },
        details: {
          isFollowUpMatch: false,
          typeMatch: false,
          filtersMatch: false,
          offsetMatch: false,
          chainFlagsMatch: false,
          queryRewriteMatch: false,
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
  
  // Group results by category
  for (const result of results) {
    if (!categoryMap.has(result.category)) {
      categoryMap.set(result.category, []);
    }
    categoryMap.get(result.category)!.push(result);
  }
  
  const categoryResults: CategoryResults[] = [];
  
  for (const [category, categoryResults_] of categoryMap) {
    const totalScenarios = categoryResults_.length;
    
    // Calculate average scores
    const avgScores: EvaluationScores = {
      isFollowUpAccuracy: 0,
      typeAccuracy: 0,
      filtersAccuracy: 0,
      offsetAccuracy: 0,
      chainManagementAccuracy: 0,
      queryRewriteAccuracy: 0,
      contextRecoveryAccuracy: 0,
      overallScore: 0
    };
    
    for (const result of categoryResults_) {
      avgScores.isFollowUpAccuracy += result.scores.isFollowUpAccuracy;
      avgScores.typeAccuracy += result.scores.typeAccuracy;
      avgScores.filtersAccuracy += result.scores.filtersAccuracy;
      avgScores.offsetAccuracy += result.scores.offsetAccuracy;
      avgScores.chainManagementAccuracy += result.scores.chainManagementAccuracy;
      avgScores.queryRewriteAccuracy += result.scores.queryRewriteAccuracy;
      avgScores.contextRecoveryAccuracy += result.scores.contextRecoveryAccuracy;
      avgScores.overallScore += result.scores.overallScore;
    }
    
    // Average the scores
    Object.keys(avgScores).forEach(key => {
      avgScores[key as keyof EvaluationScores] /= totalScenarios;
    });
    
    categoryResults.push({
      category,
      totalScenarios,
      averageScore: avgScores.overallScore,
      scores: avgScores,
      scenarios: categoryResults_
    });
  }
  
  return categoryResults.sort((a, b) => b.averageScore - a.averageScore);
}

async function runEvaluation(userCtx: string) {
  const results: ChainClassificationEvalResult[] = [];

  Logger.info("User context:\n" + userCtx)

  for (const scenario of data) {
    Logger.info(`Processing scenario: ${scenario.id} (${scenario.category})`)
    
    const scenarioResults = await evaluateScenario(scenario, userCtx)
    results.push(...scenarioResults)
  }

  const categoryResults = calculateCategoryResults(results)

  // Generate summary report
  console.log('\n=== CHAIN CLASSIFICATION EVALUATION RESULTS ===\n');
  
  console.log('CATEGORY SUMMARY:');
  console.log('================');
  for (const category of categoryResults) {
    console.log(`${category.category}: ${(category.averageScore * 100).toFixed(1)}% (${category.totalScenarios} scenarios)`);
    console.log(`  Follow-up Detection: ${(category.scores.isFollowUpAccuracy * 100).toFixed(1)}%`);
    console.log(`  Type Classification: ${(category.scores.typeAccuracy * 100).toFixed(1)}%`);
    console.log(`  Filters Accuracy: ${(category.scores.filtersAccuracy * 100).toFixed(1)}%`);
    console.log(`  Offset Calculation: ${(category.scores.offsetAccuracy * 100).toFixed(1)}%`);
    console.log(`  Chain Management: ${(category.scores.chainManagementAccuracy * 100).toFixed(1)}%`);
    console.log(`  Query Rewrite: ${(category.scores.queryRewriteAccuracy * 100).toFixed(1)}%`);
    console.log(`  Context Recovery: ${(category.scores.contextRecoveryAccuracy * 100).toFixed(1)}%`);
    console.log('');
  }
  
  // Overall statistics
  const overallScore = results.reduce((sum, r) => sum + r.scores.overallScore, 0) / results.length;
  console.log(`OVERALL ACCURACY: ${(overallScore * 100).toFixed(1)}%`);
  console.log(`TOTAL EVALUATIONS: ${results.length}`);

  const avgScore = results.reduce((a, c) => a + c.scores.overallScore, 0) / results.length
  console.log(`Chain Classification eval score: ${avgScore}`)

  const savedFileName = saveEvalResults(
    { averageScore: avgScore, results, categoryResults },
    "chain-classification-eval",
  )

  console.log(`Results saved to: ${savedFileName}`)

  // Identify worst performing scenarios
  const worstScenarios = results
    .filter(r => r.scores.overallScore < 0.7)
    .sort((a, b) => a.scores.overallScore - b.scores.overallScore)
    .slice(0, 10);
  
  if (worstScenarios.length > 0) {
    console.log('\nWORST PERFORMING SCENARIOS:');
    console.log('===========================');
    for (const scenario of worstScenarios) {
      console.log(`${scenario.scenarioId} (Turn ${scenario.turn}): ${(scenario.scores.overallScore * 100).toFixed(1)}%`);
      console.log(`  Input: "${scenario.input}"`);
      console.log(`  Category: ${scenario.category}`);
      if (scenario.details.errors.length > 0) {
        console.log(`  Errors: ${scenario.details.errors.join(', ')}`);
      }
      console.log('');
    }
  }

  return { avgScore, results, categoryResults }
}

const callRunEvaluation = async () => {
  try {
    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId,
      myEmail,
    )
    if (!userAndWorkspace) {
      throw new Error(`User not found for email: ${myEmail}`)
    }
    const ctx = userContext(userAndWorkspace)
    return await runEvaluation(ctx)
  } catch (error) {
    Logger.error("Failed to fetch user and workspace:", error)
    throw error
  }
}

async function main() {
  try {
    console.log('Starting chain classification evaluation...');
    console.log(`Loaded ${data.length} scenarios`);
    
    const results = await callRunEvaluation()
    console.log(`\n✅ Chain classification evaluation completed with score: ${(results.avgScore * 100).toFixed(1)}%`)
    process.exit(0)
  } catch (error) {
    console.error('❌ Chain classification evaluation failed:', error);
    process.exit(1);
  }
}

// Run the evaluation
if (require.main === module) {
  main();
}

export { evaluateScenario, calculateCategoryResults, callRunEvaluation as runChainClassificationEval };