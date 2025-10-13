import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createSimpleEvalSummary() {
  console.log('📊 Creating Simple Evaluation Summary for LLM Assessment');
  
  // Read the evaluation results
  const resultsPath = path.join(__dirname, '../data/jql_evaluation_results.json');
  
  if (!fs.existsSync(resultsPath)) {
    console.error('❌ Evaluation results file not found. Run jqlEvaluation.ts first.');
    return;
  }
  
  const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
  
  // Extract the generated JQLs from the console output during evaluation
  // Since our mock function generated these specific JQLs:
  const mockGeneratedJQLs = [
    'issuetype = Bug',
    'project = YOUR_PROJECT', 
    'priority = High',
    'issuetype = Task AND status != Closed',
    'created >= -1d',
    'updated >= -7d',
    'project = ALPHA',
    'assignee IS EMPTY',
    'status = Resolved',
    'description IS EMPTY',
    'priority = Critical',
    'sprint IN openSprints()',
    'due >= startOfDay() AND due <= endOfDay()',
    'assignee = currentUser()',
    'reporter IN membersOf("qa")',
    'issue IN linkedIssues("", "is blocked by")',
    '"Story Points" > 5',
    'created >= startOfMonth()',
    'assignee IN membersOf("frontend")',
    'due < now() AND resolution IS EMPTY'
  ];
  
  const evaluationSummary = {
    evaluation_info: {
      title: "JQL Query Generation Evaluation",
      total_queries: 20,
      timestamp: new Date().toISOString(),
      instructions: "Please evaluate each generated JQL query for accuracy. Rate 1-5 where 5=perfect match for user intent."
    },
    test_cases: results.map((result: any, index: number) => ({
      id: result.query_id,
      user_query: result.user_query,
      generated_jql: mockGeneratedJQLs[index] || 'ERROR: JQL not found',
      expected_elements: result.expected_jql_elements,
      examples_found: result.relevant_examples_found,
      top_examples: result.relevant_examples.slice(0, 3).map((ex: any) => ({
        nlq: ex.nlq,
        jql: ex.jql
      }))
    }))
  };
  
  // Save the clean summary
  const summaryPath = path.join(__dirname, '../data/jql_eval_for_assessment.json');
  fs.writeFileSync(summaryPath, JSON.stringify(evaluationSummary, null, 2));
  
  console.log(`✅ Clean evaluation summary saved to: ${summaryPath}`);
  
  // Create a markdown version for easy review
  const markdown = `# JQL Generation Evaluation Results

**Total Test Cases:** ${evaluationSummary.test_cases.length}  
**Generated:** ${evaluationSummary.evaluation_info.timestamp}

## Instructions for Evaluator
Rate each generated JQL query on accuracy (1-5 scale):
- 1 = Completely wrong/invalid
- 2 = Partially correct but missing key elements  
- 3 = Mostly correct with minor issues
- 4 = Correct with good JQL syntax
- 5 = Perfect match for user intent

---

${evaluationSummary.test_cases.map(tc => `
## ${tc.id}. "${tc.user_query}"

**Generated JQL:** \`${tc.generated_jql}\`

**Expected Elements:** ${tc.expected_elements.map(el => `\`${el}\``).join(', ')}

**Top Examples Used:**
${tc.top_examples.map((ex, i) => `${i+1}. "${ex.nlq}" → \`${ex.jql}\``).join('\n')}

**Accuracy Score:** ___/5  
**Notes:** ________________________________

---
`).join('')}

## Summary
**Average Score:** ___/5  
**Total Accurate (4-5):** ___/${evaluationSummary.test_cases.length}  
**Needs Improvement (1-3):** ___/${evaluationSummary.test_cases.length}
`;

  const markdownPath = path.join(__dirname, '../data/jql_eval_for_assessment.md');
  fs.writeFileSync(markdownPath, markdown);
  
  console.log(`📄 Markdown version saved to: ${markdownPath}`);
  console.log(`🎯 Ready for LLM accuracy assessment!`);
  
  return evaluationSummary;
}

createSimpleEvalSummary();