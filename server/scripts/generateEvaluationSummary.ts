import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  expected_jql_elements: string[];
  timestamp: string;
}

function generateEvaluationSummary() {
  console.log('📊 Generating Evaluation Summary for LLM Assessment');
  
  // Read the evaluation results
  const resultsPath = path.join(__dirname, '../data/jql_evaluation_results.json');
  
  if (!fs.existsSync(resultsPath)) {
    console.error('❌ Evaluation results file not found. Run jqlEvaluation.ts first.');
    return;
  }
  
  const results: EvaluationResult[] = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
  
  // Create a simplified summary for LLM evaluation
  const summary = {
    metadata: {
      total_queries: results.length,
      evaluation_timestamp: new Date().toISOString(),
      purpose: "Evaluate accuracy of JQL query generation from natural language",
      instructions_for_evaluator: `
Please evaluate each generated JQL query for accuracy based on the user's natural language request.
Rate each query on a scale of 1-5:
1 = Completely incorrect/invalid JQL
2 = Partially correct but missing key elements
3 = Mostly correct with minor issues
4 = Correct with good JQL syntax
5 = Perfect match for the user's intent

Consider:
- Does the JQL match the user's intent?
- Is the JQL syntax valid?
- Are the appropriate fields/operators used?
- Would this query return the expected results?
`
    },
    queries_to_evaluate: results.map(result => ({
      id: result.query_id,
      user_request: result.user_query,
      generated_jql: extractGeneratedJQL(result.generated_prompt),
      expected_elements: result.expected_jql_elements,
      relevant_examples_used: result.relevant_examples.slice(0, 3).map(ex => ({
        example_nlq: ex.nlq,
        example_jql: ex.jql
      })),
      evaluation_notes: "",
      accuracy_score: null
    }))
  };
  
  // Save the summary
  const summaryPath = path.join(__dirname, '../data/jql_evaluation_summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  
  console.log(`✅ Evaluation summary saved to: ${summaryPath}`);
  console.log(`📝 Ready for LLM accuracy assessment`);
  
  // Also create a markdown format for easy reading
  const markdownContent = generateMarkdownSummary(summary);
  const markdownPath = path.join(__dirname, '../data/jql_evaluation_summary.md');
  fs.writeFileSync(markdownPath, markdownContent);
  
  console.log(`📄 Markdown summary saved to: ${markdownPath}`);
  
  return summary;
}

function extractGeneratedJQL(prompt: string): string {
  // Extract the mock-generated JQL from our evaluation
  const lines = prompt.split('\n');
  const jqlLine = lines.find(line => line.includes('Generated: '));
  if (jqlLine) {
    return jqlLine.replace('Generated: ', '').trim();
  }
  
  // If not found in that format, look for common patterns
  if (prompt.includes('issuetype = Bug')) return 'issuetype = Bug';
  if (prompt.includes('priority = High')) return 'priority = High';
  
  return 'JQL not found in prompt';
}

function generateMarkdownSummary(summary: any): string {
  return `# JQL Generation Evaluation Summary

**Generated:** ${summary.metadata.evaluation_timestamp}
**Total Queries:** ${summary.metadata.total_queries}

## Purpose
${summary.metadata.instructions_for_evaluator}

## Query Evaluations

${summary.queries_to_evaluate.map((query: any, index: number) => `
### ${index + 1}. ${query.user_request}

**Generated JQL:** \`${query.generated_jql}\`

**Expected Elements:** ${query.expected_elements.map((el: string) => `\`${el}\``).join(', ')}

**Top Relevant Examples Used:**
${query.relevant_examples_used.map((ex: any, i: number) => `
${i + 1}. "${ex.example_nlq}" → \`${ex.example_jql}\`
`).join('')}

**Evaluation:**
- Accuracy Score: ___/5
- Notes: ________________________________________________

---
`).join('')}

## Overall Assessment

**Average Accuracy Score:** ___/5

**Common Issues Found:**
- [ ] Issue 1: _______________________
- [ ] Issue 2: _______________________
- [ ] Issue 3: _______________________

**Recommendations:**
- [ ] Recommendation 1: _______________________
- [ ] Recommendation 2: _______________________
- [ ] Recommendation 3: _______________________
`;
}

// Generate the summary
generateEvaluationSummary();