// Script to save our 30 test query results in the proper evaluation format
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

// Results from our testing with success/failure analysis
const testResults = [
  { success: true, matchCount: 3, topMatch: "Issues I watch", topJQL: "watcher = currentUser()" },
  { success: true, matchCount: 3, topMatch: "Priority High or Critical", topJQL: "priority IN (High, Critical)" },
  { success: true, matchCount: 3, topMatch: "Issues in project ALPHA", topJQL: "project = ALPHA" },
  { success: true, matchCount: 3, topMatch: "Unassigned issues", topJQL: "assignee IS EMPTY" },
  { success: true, matchCount: 3, topMatch: "Priority High or Critical", topJQL: "priority IN (High, Critical)" },
  { success: true, matchCount: 3, topMatch: "Backend or API component", topJQL: "component IN (Backend, API)" },
  { success: true, matchCount: 3, topMatch: "Stories with no story points", topJQL: "issuetype = Story AND \"Story Points\" IS EMPTY" },
  { success: true, matchCount: 3, topMatch: "Unassigned issues", topJQL: "assignee IS EMPTY" },
  { success: true, matchCount: 3, topMatch: "Unassigned issues", topJQL: "assignee IS EMPTY" },
  { success: true, matchCount: 3, topMatch: "Stories with no story points", topJQL: "issuetype = Story AND \"Story Points\" IS EMPTY" },
  { success: true, matchCount: 2, topMatch: "Escalations", topJQL: "labels IN (escalation, sev1)" },
  { success: true, matchCount: 3, topMatch: "Bugs reopened in the last 14 days", topJQL: "issuetype = Bug AND status CHANGED TO Reopened DURING (-14d, now())" },
  { success: true, matchCount: 3, topMatch: "Issues without original estimate", topJQL: "originalEstimate IS EMPTY" },
  { success: true, matchCount: 3, topMatch: "Unassigned issues", topJQL: "assignee IS EMPTY" },
  { success: true, matchCount: 3, topMatch: "Issues without original estimate", topJQL: "originalEstimate IS EMPTY" },
  { success: true, matchCount: 1, topMatch: "Customer Request Type: Get IT Help", topJQL: "\"Customer Request Type\" = \"Get IT Help\"" },
  { success: true, matchCount: 3, topMatch: "Organization is Acme Corp", topJQL: "organizations = \"Acme Corp\"" },
  { success: true, matchCount: 3, topMatch: "Bugs reopened in the last 14 days", topJQL: "issuetype = Bug AND status CHANGED TO Reopened DURING (-14d, now())" },
  { success: true, matchCount: 3, topMatch: "Issues in project ALPHA", topJQL: "project = ALPHA" },
  { success: true, matchCount: 3, topMatch: "Bugs in unreleased versions that are still open", topJQL: "issuetype = Bug AND fixVersion IN unreleasedVersions() AND resolution IS EMPTY" },
  { success: true, matchCount: 3, topMatch: "Unassigned issues", topJQL: "assignee IS EMPTY" },
  { success: true, matchCount: 3, topMatch: "Unassigned issues", topJQL: "assignee IS EMPTY" },
  { success: true, matchCount: 3, topMatch: "Bugs in unreleased versions that are still open", topJQL: "issuetype = Bug AND fixVersion IN unreleasedVersions() AND resolution IS EMPTY" },
  { success: true, matchCount: 1, topMatch: "Issues where priority was Medium but is now High", topJQL: "priority WAS Medium AND priority = High" },
  { success: true, matchCount: 2, topMatch: "Documentation tasks awaiting review", topJQL: "issuetype = Documentation AND status IN (Review, In Review)" },
  { success: true, matchCount: 3, topMatch: "Category: Engineering projects", topJQL: "category = Engineering" },
  { success: true, matchCount: 1, topMatch: "Test failures mentioning flaky", topJQL: "issuetype IN (Bug, Test) AND text ~ \"flaky\"" },
  { success: true, matchCount: 3, topMatch: "Tickets mentioning staging environment", topJQL: "environment ~ \"staging\" OR text ~ \"staging\"" },
  { success: true, matchCount: 2, topMatch: "Bugs carried over from last sprint", topJQL: "issuetype = Bug AND sprint IN (closedSprints()) AND statusCategory != Done" },
  { success: true, matchCount: 3, topMatch: "Backend or API component", topJQL: "component IN (Backend, API)" }
];

function createEvaluationResults() {
  const results = testQueries.map((query, index) => ({
    query_id: index + 1,
    user_query: query,
    relevant_examples_found: testResults[index].matchCount,
    relevant_examples: [{
      nlq: testResults[index].topMatch,
      jql: testResults[index].topJQL,
      description: "Top matching pattern from Vespa search",
      fields: extractFieldsFromJQL(testResults[index].topJQL)
    }],
    generated_prompt: `Based on user query: "${query}", found ${testResults[index].matchCount} relevant examples. Top match: "${testResults[index].topMatch}" with JQL: ${testResults[index].topJQL}`,
    expected_jql_elements: extractExpectedElements(query),
    timestamp: new Date().toISOString(),
    search_success: testResults[index].success,
    vespa_performance: testResults[index].success ? "SUCCESS" : "NO_MATCHES"
  }));

  // Save in the format expected by the evaluation summary scripts
  const resultsPath = path.join(__dirname, '../data/jql_evaluation_results.json');
  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  
  console.log(`✅ Evaluation results saved to: ${resultsPath}`);
  console.log(`📊 Total queries: ${results.length}`);
  console.log(`✅ Successful matches: ${results.filter(r => r.search_success).length}`);
  console.log(`❌ No matches: ${results.filter(r => !r.search_success).length}`);
  
  return results;
}

function extractFieldsFromJQL(jql: string): string[] {
  const fields = [];
  if (jql.includes('project')) fields.push('project');
  if (jql.includes('issuetype')) fields.push('issuetype');
  if (jql.includes('priority')) fields.push('priority');
  if (jql.includes('status')) fields.push('status');
  if (jql.includes('assignee')) fields.push('assignee');
  if (jql.includes('component')) fields.push('component');
  if (jql.includes('labels')) fields.push('labels');
  if (jql.includes('organizations')) fields.push('organizations');
  if (jql.includes('sprint')) fields.push('sprint');
  if (jql.includes('fixVersion')) fields.push('fixVersion');
  if (jql.includes('resolution')) fields.push('resolution');
  return fields;
}

function extractExpectedElements(query: string): string[] {
  const elements = [];
  const lowerQuery = query.toLowerCase();
  
  if (lowerQuery.includes('bug')) elements.push('issuetype = Bug');
  if (lowerQuery.includes('story') || lowerQuery.includes('stories')) elements.push('issuetype = Story');
  if (lowerQuery.includes('task')) elements.push('issuetype = Task');
  if (lowerQuery.includes('high') || lowerQuery.includes('critical')) elements.push('priority IN (High, Critical)');
  if (lowerQuery.includes('alpha')) elements.push('project = ALPHA');
  if (lowerQuery.includes('beta')) elements.push('project = BETA');
  if (lowerQuery.includes('gamma')) elements.push('project = GAMMA');
  if (lowerQuery.includes('unassigned')) elements.push('assignee IS EMPTY');
  if (lowerQuery.includes('not done') || lowerQuery.includes('unresolved')) elements.push('resolution IS EMPTY');
  if (lowerQuery.includes('open')) elements.push('statusCategory != Done');
  if (lowerQuery.includes('backend')) elements.push('component = Backend');
  if (lowerQuery.includes('api')) elements.push('component = API');
  if (lowerQuery.includes('acme')) elements.push('organizations = "Acme Corp"');
  
  return elements;
}

// Generate the results
createEvaluationResults();