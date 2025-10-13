import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { searchRelevantJQLExamples, generateJQLFromUserQuery } from '../integrations/jira/jqlQueryGeneration.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Complex test queries for evaluation - updated with our 30 test queries
const testQueries = [
  "Show me my tickets that are still not done.",
  "List all high or critical bugs that haven't been resolved.",
  "Find ALPHA project issues tagged with frontend or UI labels.",
  "What issues were created in the last 7 days by the automation bot?",
  "Show me high-priority issues in unreleased versions.",
  "Which backend issues have been open and untouched for more than 14 days?",
  "List all stories under epic ALPHA-123 that aren't completed.",
  "Show issues that have 10 or more watchers but aren't low priority.",
  "Which issues moved into \"In Progress\" after this week started?",
  "Find stories in the current sprint that don't have story points.",
  "List escalation-labeled tickets created in the last 30 days.",
  "Show bugs in BETA project that mention \"timeout\" in their text.",
  "What tasks are still open and due by the end of this week?",
  "Show issues reported by QA team this month.",
  "Find tasks without attachments that were updated in the last 10 days.",
  "Which \"Get IT Help\" requests are still unresolved?",
  "Show Acme Corp's open requests.",
  "Find bugs where the description contains NullPointerException.",
  "Which ALPHA bugs were marked as duplicates in the last 60 days?",
  "Show all open sprint issues that are high or critical priority.",
  "List unassigned stories or tasks created in the last 3 days.",
  "Which issues were fixed in released versions this month?",
  "Find open bugs labeled customer or sev1.",
  "Which medium-priority issues haven't been updated in the last 20 days?",
  "Show documentation tickets currently in review.",
  "In project GAMMA, find tasks not assigned to devs and still open.",
  "List flaky bugs or test issues.",
  "Which tickets are in progress or in review, unresolved, and touched in the last 5 days?",
  "Show unfinished stories under epic BETA-456.",
  "Find API bugs created in the last 2 weeks that are not yet done."
];

interface JQLEvaluation {
  score: number;
  correctness: boolean;
  syntax_valid: boolean;
  completeness: string;
  issues: string[];
  suggested_jql?: string;
  reasoning: string;
}

interface EvaluationResult {
  query_id: number;
  user_query: string;
  relevant_examples_found: number;
  relevant_examples: Array<{
    nlq: string;
    jql: string;
    description: string;
    fields: string[];
  }>;
  generated_prompt: string;
  generated_jql: string;
  llm_evaluation: JQLEvaluation;
  timestamp: string;
}

/**
 * Generate JQL using real LLM with relevant examples
 */
async function generateJQLWithLLM(userQuery: string, examples: any[]): Promise<string> {
  const userPrompt = `You are a JQL (Jira Query Language) expert. Generate a JQL query based on the user's natural language request and the provided examples.

User Query: "${userQuery}"

Relevant JQL Examples:
${examples.map((example, index) => `
Example ${index + 1}:
- Natural Language: ${example.nlq}
- JQL: ${example.jql}
- Description: ${example.description}
- Fields used: ${example.fields.join(', ')}
- Product: ${example.product.join(', ')}
`).join('\n')}

Instructions:
1. Analyze the user query to understand what they want to search for
2. Use the provided examples as reference for proper JQL syntax and patterns
3. Generate a valid JQL query that matches the user's intent
4. Only return the JQL query, no explanation

JQL Query:`;

  try {
    // Use VertexAI Claude provider instead of OpenAI
    const { getProviderByModel } = await import('@/ai/provider');
    const { Models } = await import('@/ai/types');
    
    const provider = getProviderByModel(Models.Vertex_Claude_3_5_Sonnet);
    
    const systemPrompt = 'You are a JQL expert. Generate only valid JQL queries based on user requests and examples. Return only the JQL query without any explanation.';

    const response = await provider.converse([
      {
        role: 'user',
        content: [{ text: userPrompt }]
      }
    ], {
      modelId: Models.Vertex_Claude_3_5_Sonnet,
      systemPrompt: systemPrompt,
      stream: false,
      max_new_tokens: 200,
      temperature: 0.1
    });

    const generatedJQL = response.text?.trim() || 'ERROR: No response from LLM';
    
    console.log(`  🤖 LLM generated: ${generatedJQL}`);
    return generatedJQL;
    
  } catch (error) {
    console.error(`  ❌ LLM error: ${error}`);
    return `ERROR: LLM failed - ${error}`;
  }
}

/**
 * Evaluate generated JQL using LLM
 */
async function evaluateJQLWithLLM(
  userQuery: string, 
  generatedJQL: string, 
  examples: any[]
): Promise<JQLEvaluation> {
  const evaluationPrompt = `You are a JQL (Jira Query Language) expert evaluator. Analyze if the generated JQL correctly implements the user's natural language request.

User Query: "${userQuery}"
Generated JQL: "${generatedJQL}"

Reference Examples for Context:
${examples.map((example, index) => `
Example ${index + 1}:
- Natural Language: ${example.nlq}
- JQL: ${example.jql}
- Description: ${example.description}
`).join('\n')}

Evaluate the generated JQL on these criteria:

1. **Correctness**: Does the JQL match the user's intent?
2. **Syntax**: Is the JQL syntactically valid?
3. **Completeness**: Does it cover all aspects of the user query?
4. **Best Practices**: Does it use optimal JQL patterns?

Return your evaluation as JSON in this exact format:
{
  "score": <number 1-10>,
  "correctness": <true/false>,
  "syntax_valid": <true/false>,
  "completeness": "<complete/partial/incomplete>",
  "issues": [<array of specific issues found>],
  "suggested_jql": "<improved JQL if needed, or null>",
  "reasoning": "<detailed explanation of your evaluation>"
}`;

  try {
    // Use VertexAI Claude for evaluation
    const { getProviderByModel } = await import('@/ai/provider');
    const { Models } = await import('@/ai/types');
    
    const provider = getProviderByModel(Models.Vertex_Claude_3_5_Sonnet);
    
    const systemPrompt = 'You are a JQL expert evaluator. Analyze JQL queries and provide structured evaluations in JSON format. Be thorough and objective in your assessment.';

    const response = await provider.converse([
      {
        role: 'user',
        content: [{ text: evaluationPrompt }]
      }
    ], {
      modelId: Models.Vertex_Claude_3_5_Sonnet,
      systemPrompt: systemPrompt,
      stream: false,
      json: true,
      max_new_tokens: 400,
      temperature: 0.1
    });

    const evaluationText = response.text?.trim() || '{}';
    console.log(`  📊 Evaluation response: ${evaluationText}`);
    
    // Parse the JSON response
    let evaluation: JQLEvaluation;
    try {
      const parsed = JSON.parse(evaluationText);
      evaluation = {
        score: parsed.score || 0,
        correctness: parsed.correctness || false,
        syntax_valid: parsed.syntax_valid || false,
        completeness: parsed.completeness || 'unknown',
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
        suggested_jql: parsed.suggested_jql || undefined,
        reasoning: parsed.reasoning || 'No reasoning provided'
      };
    } catch (parseError) {
      console.warn(`  ⚠️  Failed to parse evaluation JSON: ${parseError}`);
      evaluation = {
        score: 0,
        correctness: false,
        syntax_valid: false,
        completeness: 'error',
        issues: ['Failed to parse evaluation response'],
        reasoning: `Parse error: ${parseError}`
      };
    }
    
    console.log(`  📊 Evaluation score: ${evaluation.score}/10`);
    return evaluation;
    
  } catch (error) {
    console.error(`  ❌ Evaluation error: ${error}`);
    return {
      score: 0,
      correctness: false,
      syntax_valid: false,
      completeness: 'error',
      issues: [`Evaluation failed: ${error}`],
      reasoning: `Error during evaluation: ${error}`
    };
  }
}

async function runEvaluation() {
  console.log('🧪 Starting JQL Generation Evaluation');
  console.log(`Testing ${testQueries.length} queries\n`);
  
  const results: EvaluationResult[] = [];
  
  for (let i = 0; i < testQueries.length; i++) {
    const query = testQueries[i];
    console.log(`\n[${i + 1}/${testQueries.length}] Testing: "${query}"`);
    
    try {
      // Step 1: Search Vespa for 10 relevant chunks
      console.log('  🔍 Searching Vespa for relevant chunks...');
      const relevantExamples = await searchRelevantJQLExamples(query, 10);
      
      console.log(`  ✅ Vespa returned ${relevantExamples.length} chunks`);
      
      // Step 2: Generate the prompt that would be sent to LLM
      const prompt = `You are a JQL (Jira Query Language) expert. Generate a JQL query based on the user's natural language request and the provided examples.

User Query: "${query}"

Relevant JQL Examples:
${relevantExamples.map((example, index) => `
Example ${index + 1}:
- Natural Language: ${example.nlq}
- JQL: ${example.jql}
- Description: ${example.description}
- Fields used: ${example.fields.join(', ')}
- Product: ${example.product.join(', ')}
`).join('\n')}

Instructions:
1. Analyze the user query to understand what they want to search for
2. Use the provided examples as reference for proper JQL syntax and patterns
3. Generate a valid JQL query that matches the user's intent
4. Only return the JQL query, no explanation

JQL Query:`;

      // Step 3: Generate JQL using real LLM
      console.log('  🤖 Generating JQL with LLM...');
      const generatedJQL = await generateJQLWithLLM(query, relevantExamples);
      
      console.log(`  📝 Generated: ${generatedJQL}`);
      
      // Step 4: Evaluate the generated JQL using LLM
      console.log('  📊 Evaluating JQL with LLM...');
      const evaluation = await evaluateJQLWithLLM(query, generatedJQL, relevantExamples);
      
      // Store result
      const result: EvaluationResult = {
        query_id: i + 1,
        user_query: query,
        relevant_examples_found: relevantExamples.length,
        relevant_examples: relevantExamples.map(ex => ({
          nlq: ex.nlq,
          jql: ex.jql,
          description: ex.description,
          fields: ex.fields
        })),
        generated_prompt: prompt,
        generated_jql: generatedJQL,
        llm_evaluation: evaluation,
        timestamp: new Date().toISOString()
      };
      
      results.push(result);
      
    } catch (error) {
      console.error(`  ❌ Error testing query "${query}":`, error);
      
      // Store error result
      const errorResult: EvaluationResult = {
        query_id: i + 1,
        user_query: query,
        relevant_examples_found: 0,
        relevant_examples: [],
        generated_prompt: `Error: ${error}`,
        generated_jql: `ERROR: ${error}`,
        llm_evaluation: {
          score: 0,
          correctness: false,
          syntax_valid: false,
          completeness: 'error',
          issues: [`System error: ${error}`],
          reasoning: `Failed to process query due to error: ${error}`
        },
        timestamp: new Date().toISOString()
      };
      
      results.push(errorResult);
    }
  }
  
  // Save results to file
  const outputPath = path.join(__dirname, '../data/jql_evaluation_results.json');
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  
  // Also create simple query-JQL mapping file
  const simpleResults = {
    metadata: {
      title: "Simple Query to JQL Results",
      total_queries: results.length,
      generated: new Date().toISOString(),
      description: "Clean mapping of natural language queries to generated JQL"
    },
    results: results.map(result => ({
      query: result.user_query,
      jql: result.generated_jql
    }))
  };
  
  const simpleResultsPath = path.join(__dirname, '../data/simple_query_jql_results.json');
  fs.writeFileSync(simpleResultsPath, JSON.stringify(simpleResults, null, 2));
  
  // Create CSV version too
  const csvContent = `Query,JQL,Score,Correctness,Syntax_Valid,Issues\n${results.map(r => `"${r.user_query}","${r.generated_jql}",${r.llm_evaluation.score},${r.llm_evaluation.correctness},${r.llm_evaluation.syntax_valid},"${r.llm_evaluation.issues.join('; ')}"`).join('\n')}`;
  const csvPath = path.join(__dirname, '../data/jql_evaluation_results.csv');
  fs.writeFileSync(csvPath, csvContent);
  
  // Calculate evaluation metrics
  const successfulGenerations = results.filter(r => !r.generated_jql.startsWith('ERROR'));
  const averageScore = successfulGenerations.length > 0 
    ? (successfulGenerations.reduce((sum, r) => sum + r.llm_evaluation.score, 0) / successfulGenerations.length).toFixed(2)
    : '0.00';
  
  const correctnessRate = successfulGenerations.length > 0
    ? (successfulGenerations.filter(r => r.llm_evaluation.correctness).length / successfulGenerations.length * 100).toFixed(1)
    : '0.0';
    
  const syntaxValidRate = successfulGenerations.length > 0
    ? (successfulGenerations.filter(r => r.llm_evaluation.syntax_valid).length / successfulGenerations.length * 100).toFixed(1)
    : '0.0';

  console.log(`\n✅ Evaluation completed!`);
  console.log(`📊 Results saved to: ${outputPath}`);
  console.log(`📝 Simple results saved to: ${simpleResultsPath}`);
  console.log(`📄 CSV results saved to: ${csvPath}`);
  console.log(`\n📈 Summary:`);
  console.log(`  - Total queries tested: ${results.length}`);
  console.log(`  - Successful searches: ${results.filter(r => r.relevant_examples_found > 0).length}`);
  console.log(`  - Average examples found: ${(results.reduce((sum, r) => sum + r.relevant_examples_found, 0) / results.length).toFixed(2)}`);
  console.log(`  - Successful JQL generations: ${successfulGenerations.length}/${results.length}`);
  console.log(`  - Average LLM evaluation score: ${averageScore}/10`);
  console.log(`  - Correctness rate: ${correctnessRate}%`);
  console.log(`  - Syntax validity rate: ${syntaxValidRate}%`);
  
  return results;
}

// Run the evaluation
runEvaluation().catch(console.error);