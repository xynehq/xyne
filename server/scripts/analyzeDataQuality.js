import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function analyzeDataQuality() {
  try {
    const dataPath = path.join(__dirname, '../data/dataToIngest.json');
    const rawData = fs.readFileSync(dataPath, 'utf8');
    const data = JSON.parse(rawData);
    
    console.log('=== DATASET QUALITY ANALYSIS ===\n');
    
    // Basic stats
    console.log(`📊 Total examples: ${data.length}`);
    
    // Check for duplicates by JQL
    const jqlMap = new Map();
    const nlqMap = new Map();
    const duplicateJQLs = [];
    const duplicateNLQs = [];
    
    data.forEach((item, index) => {
      // Check JQL duplicates
      if (jqlMap.has(item.jql)) {
        duplicateJQLs.push({
          jql: item.jql,
          ids: [jqlMap.get(item.jql), item.id],
          indices: [data.findIndex(d => d.id === jqlMap.get(item.jql)), index]
        });
      } else {
        jqlMap.set(item.jql, item.id);
      }
      
      // Check NLQ duplicates
      if (nlqMap.has(item.nlq)) {
        duplicateNLQs.push({
          nlq: item.nlq,
          ids: [nlqMap.get(item.nlq), item.id],
          indices: [data.findIndex(d => d.id === nlqMap.get(item.nlq)), index]
        });
      } else {
        nlqMap.set(item.nlq, item.id);
      }
    });
    
    console.log(`🔄 JQL duplicates found: ${duplicateJQLs.length}`);
    console.log(`🔄 NLQ duplicates found: ${duplicateNLQs.length}`);
    
    // Check for missing required fields
    const requiredFields = ['id', 'nlq', 'jql', 'entities'];
    let missingFieldsCount = 0;
    
    data.forEach((item, index) => {
      const missing = requiredFields.filter(field => !item.hasOwnProperty(field));
      if (missing.length > 0) {
        missingFieldsCount++;
        console.log(`❌ Item ${index} (${item.id}) missing: ${missing.join(', ')}`);
      }
    });
    
    console.log(`📋 Items with missing required fields: ${missingFieldsCount}`);
    
    // Check JQL syntax issues
    const syntaxIssues = [];
    data.forEach((item, index) => {
      const jql = item.jql;
      
      // Check for common syntax issues
      if (jql.includes('\\\"') && !jql.includes('\\"')) {
        syntaxIssues.push({id: item.id, issue: 'Escaped quotes without proper escaping', jql});
      }
      
      if (jql.match(/[^=!<>~]\s*=\s*[A-Za-z]+\s*[^"'\s]/)) {
        syntaxIssues.push({id: item.id, issue: 'Unquoted string value', jql});
      }
      
      if (jql.includes('\\n') || jql.includes('\\t')) {
        syntaxIssues.push({id: item.id, issue: 'Contains literal newlines/tabs', jql});
      }
    });
    
    console.log(`⚠️  JQL syntax issues found: ${syntaxIssues.length}`);
    syntaxIssues.slice(0, 5).forEach(issue => {
      console.log(`   ${issue.id}: ${issue.issue} - ${issue.jql.substring(0, 60)}...`);
    });
    
    // Check section distribution
    const sectionCounts = {};
    data.forEach(item => {
      const section = item.section || 'Unknown';
      sectionCounts[section] = (sectionCounts[section] || 0) + 1;
    });
    
    console.log('\\n📚 Section distribution:');
    Object.entries(sectionCounts)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 10)
      .forEach(([section, count]) => {
        console.log(`   ${count.toString().padStart(3)} - ${section}`);
      });
    
    // Check for potential conflicts (same NLQ, different JQL)
    const nlqToJql = new Map();
    const conflicts = [];
    
    data.forEach(item => {
      if (nlqToJql.has(item.nlq)) {
        const existingJql = nlqToJql.get(item.nlq);
        if (existingJql !== item.jql) {
          conflicts.push({
            nlq: item.nlq,
            jql1: existingJql,
            jql2: item.jql,
            id: item.id
          });
        }
      } else {
        nlqToJql.set(item.nlq, item.jql);
      }
    });
    
    console.log(`\\n⚡ Conflicts (same NLQ, different JQL): ${conflicts.length}`);
    conflicts.slice(0, 3).forEach(conflict => {
      console.log(`   NLQ: "${conflict.nlq}"`);
      console.log(`   JQL1: ${conflict.jql1}`);
      console.log(`   JQL2: ${conflict.jql2}\\n`);
    });
    
    // Check coverage gaps
    const basicJiraFields = [
      'status', 'assignee', 'reporter', 'priority', 'issuetype', 
      'project', 'created', 'updated', 'resolved', 'due',
      'fixVersion', 'affectedVersion', 'component', 'labels',
      'resolution', 'summary', 'description', 'comment'
    ];
    
    const fieldUsage = {};
    basicJiraFields.forEach(field => fieldUsage[field] = 0);
    
    data.forEach(item => {
      basicJiraFields.forEach(field => {
        if (item.jql.includes(field)) {
          fieldUsage[field]++;
        }
      });
    });
    
    console.log('\\n🎯 Field coverage:');
    Object.entries(fieldUsage)
      .sort(([,a], [,b]) => b - a)
      .forEach(([field, count]) => {
        const percentage = ((count / data.length) * 100).toFixed(1);
        console.log(`   ${field.padEnd(15)}: ${count.toString().padStart(3)} examples (${percentage}%)`);
      });
    
    // Generate recommendations
    console.log('\\n💡 RECOMMENDATIONS:');
    console.log('1. Remove duplicate JQL queries');
    console.log('2. Fix syntax issues in JQL queries');
    console.log('3. Resolve conflicts where same NLQ maps to different JQL');
    console.log('4. Add more examples for underrepresented fields');
    console.log('5. Balance section distribution');
    console.log('6. Expand to 500 high-quality examples');
    console.log('7. Validate all JQL queries against JIRA API');
    
  } catch (error) {
    console.error('❌ Error analyzing data:', error);
  }
}

analyzeDataQuality();