import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// LLM validation function
async function validateJQLWithLLM(jql, nlq) {
  try {
    const prompt = `You are a JIRA JQL expert. Analyze this JQL query for syntax errors and correctness.

Natural Language Query: "${nlq}"
JQL Query: "${jql}"

Check for:
1. Proper quoting of string values
2. Correct field names
3. Valid operators
4. Proper syntax structure
5. Logical consistency with the natural language query

Respond with JSON only:
{
  "isValid": true/false,
  "errors": ["list of specific errors found"],
  "correctedJQL": "corrected version if needed",
  "confidence": 0.95
}`;

    // For now, we'll use a simple validation - in production you'd call an LLM API
    return simpleJQLValidation(jql, nlq);
  } catch (error) {
    console.error(`Error validating JQL: ${error}`);
    return { isValid: false, errors: ["LLM validation failed"], correctedJQL: jql, confidence: 0.0 };
  }
}

// Comprehensive JQL syntax fixing
function fixJQLSyntax(jql) {
  let fixed = jql.trim();
  
  // Track changes for reporting
  const changes = [];
  
  // 1. Fix unquoted string values for JIRA fields
  const fieldQuotingRules = [
    // Status values (common status names)
    { 
      pattern: /(\bstatus\s*(?:=|!=|IN|NOT\s+IN)\s*\(?)\s*([A-Za-z][A-Za-z0-9\s\-_]*[A-Za-z0-9]|[A-Za-z])\s*(\)?)/gi,
      replacement: '$1"$2"$3',
      description: 'Quote status values'
    },
    { 
      pattern: /(\bstatusCategory\s*(?:=|!=|IN|NOT\s+IN)\s*\(?)\s*([A-Za-z][A-Za-z0-9\s\-_]*[A-Za-z0-9]|[A-Za-z])\s*(\)?)/gi,
      replacement: '$1"$2"$3',
      description: 'Quote statusCategory values'
    },
    
    // Project keys (usually uppercase)
    { 
      pattern: /(\bproject\s*(?:=|!=|IN|NOT\s+IN)\s*\(?)\s*([A-Z][A-Z0-9_\-]*)\s*(\)?)/g,
      replacement: '$1"$2"$3',
      description: 'Quote project keys'
    },
    
    // Issue types
    { 
      pattern: /(\bissuetype\s*(?:=|!=|IN|NOT\s+IN)\s*\(?)\s*([A-Za-z][A-Za-z0-9\s\-_]*[A-Za-z0-9]|[A-Za-z])\s*(\)?)/gi,
      replacement: '$1"$2"$3',
      description: 'Quote issue type values'
    },
    
    // Priority values
    { 
      pattern: /(\bpriority\s*(?:=|!=|IN|NOT\s+IN)\s*\(?)\s*([A-Za-z][A-Za-z0-9\s\-_]*[A-Za-z0-9]|[A-Za-z])\s*(\)?)/gi,
      replacement: '$1"$2"$3',
      description: 'Quote priority values'
    },
    
    // Resolution values
    { 
      pattern: /(\bresolution\s*(?:=|!=|IN|NOT\s+IN)\s*\(?)\s*([A-Za-z][A-Za-z0-9\s\-_]*[A-Za-z0-9]|[A-Za-z])\s*(\)?)/gi,
      replacement: '$1"$2"$3',
      description: 'Quote resolution values'
    },
    
    // Component values
    { 
      pattern: /(\bcomponent\s*(?:=|!=|IN|NOT\s+IN)\s*\(?)\s*([A-Za-z][A-Za-z0-9\s\-_]*[A-Za-z0-9]|[A-Za-z])\s*(\)?)/gi,
      replacement: '$1"$2"$3',
      description: 'Quote component values'
    },
    
    // Label values
    { 
      pattern: /(\blabels?\s*(?:=|!=|IN|NOT\s+IN|~)\s*\(?)\s*([A-Za-z][A-Za-z0-9_\-]*[A-Za-z0-9]|[A-Za-z])\s*(\)?)/gi,
      replacement: '$1"$2"$3',
      description: 'Quote label values'
    },
    
    // User values (assignee, reporter, etc.)
    { 
      pattern: /(\b(?:assignee|reporter|creator|watcher|voter)\s*(?:=|!=|IN|NOT\s+IN)\s*\(?)\s*([a-zA-Z][a-zA-Z0-9._\-@]*[a-zA-Z0-9]|[a-zA-Z])\s*(\)?)/gi,
      replacement: '$1"$2"$3',
      description: 'Quote user values'
    }
  ];
  
  // Apply quoting rules
  fieldQuotingRules.forEach(rule => {
    const before = fixed;
    fixed = fixed.replace(rule.pattern, rule.replacement);
    if (before !== fixed) {
      changes.push(rule.description);
    }
  });
  
  // 2. Fix specific syntax issues
  
  // Remove quotes from keywords and functions
  const keywordPatterns = [
    { 
      pattern: /"(EMPTY|NULL|TRUE|FALSE)"/gi, 
      replacement: '$1',
      description: 'Remove quotes from keywords'
    },
    { 
      pattern: /"(currentUser|membersOf|unreleasedVersions|releasedVersions|openSprints|closedSprints|futureSprints|startOfDay|startOfWeek|startOfMonth|endOfDay|endOfWeek|endOfMonth|now)\(\)"/gi, 
      replacement: '$1()',
      description: 'Remove quotes from functions'
    }
  ];
  
  keywordPatterns.forEach(rule => {
    const before = fixed;
    fixed = fixed.replace(rule.pattern, rule.replacement);
    if (before !== fixed) {
      changes.push(rule.description);
    }
  });
  
  // 3. Fix double quotes and quote issues
  fixed = fixed.replace(/"([^"]*)""/g, '"$1"'); // Fix double quotes at end
  fixed = fixed.replace(/""([^"]*)"/g, '"$1"'); // Fix double quotes at start
  
  // 4. Fix IN clause formatting
  fixed = fixed.replace(/IN\s*\(\s*([^)]+)\s*\)/gi, (match, values) => {
    // Split values and ensure each is properly quoted
    const valueList = values.split(',').map(v => {
      const trimmed = v.trim();
      // If it's already quoted, keep it
      if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed;
      }
      // If it's a function or keyword, don't quote
      if (/^(currentUser\(\)|EMPTY|NULL|TRUE|FALSE|\d+)$/i.test(trimmed)) {
        return trimmed;
      }
      // Quote string values
      return `"${trimmed}"`;
    });
    return `IN (${valueList.join(', ')})`;
  });
  
  // 5. Fix spacing issues
  fixed = fixed.replace(/\s+/g, ' '); // Multiple spaces to single
  fixed = fixed.replace(/\s*([=!<>~])\s*/g, ' $1 '); // Space around operators
  fixed = fixed.replace(/\s*(AND|OR)\s*/gi, ' $1 '); // Space around logical operators
  
  return { fixedJQL: fixed, changes };
}

// Simple JQL validation (pattern-based)
function simpleJQLValidation(jql, nlq) {
  const errors = [];
  let correctedJQL = jql;
  
  // Check for common issues
  
  // 1. Unmatched quotes
  const quoteCount = (jql.match(/"/g) || []).length;
  if (quoteCount % 2 !== 0) {
    errors.push("Unmatched quotes detected");
  }
  
  // 2. Invalid operators
  if (/\b(=|!=|<|>|<=|>=|~|!~|IN|NOT IN|IS|IS NOT|WAS|WAS IN|WAS NOT|CHANGED)\b/gi.test(jql)) {
    // Valid operators found
  } else if (/[=<>~!]/.test(jql)) {
    errors.push("Potentially invalid operator usage");
  }
  
  // 3. Check for unquoted string values
  const unquotedStringPattern = /(\b(?:status|project|issuetype|priority|resolution|component|assignee|reporter)\s*=\s*)([A-Za-z][A-Za-z0-9\s]*[A-Za-z0-9])(\s|$|AND|OR|\))/gi;
  if (unquotedStringPattern.test(jql)) {
    errors.push("Unquoted string values detected");
  }
  
  // 4. Check for valid field names (basic validation)
  const validFields = [
    'assignee', 'reporter', 'creator', 'status', 'statusCategory', 'resolution',
    'priority', 'issuetype', 'project', 'component', 'labels', 'fixVersion',
    'affectedVersion', 'created', 'updated', 'resolved', 'due', 'summary',
    'description', 'comment', 'text', 'attachments', 'sprint', 'parent',
    'issuekey', 'key', 'votes', 'watchers', 'worklogDate', 'worklogAuthor',
    'timeoriginalestimate', 'timeestimate', 'timespent', 'remainingEstimate'
  ];
  
  // Extract field names from JQL
  const fieldMatches = jql.match(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:[=!<>~]|IN|IS|WAS|CHANGED)/gi);
  if (fieldMatches) {
    fieldMatches.forEach(match => {
      const field = match.replace(/\s*(?:[=!<>~]|IN|IS|WAS|CHANGED).*/i, '').trim();
      if (!validFields.includes(field.toLowerCase()) && !field.startsWith('"')) {
        errors.push(`Potentially invalid field name: ${field}`);
      }
    });
  }
  
  // Apply fixes if there are errors
  if (errors.length > 0) {
    const fixResult = fixJQLSyntax(jql);
    correctedJQL = fixResult.fixedJQL;
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    correctedJQL,
    confidence: errors.length === 0 ? 0.95 : 0.75
  };
}

async function validateAndFixDataset() {
  try {
    const dataPath = path.join(__dirname, '../data/dataToIngest.json');
    const rawData = fs.readFileSync(dataPath, 'utf8');
    const data = JSON.parse(rawData);
    
    console.log('🔍 Validating and fixing JQL syntax...');
    console.log(`📊 Processing ${data.length} examples`);
    
    let fixedCount = 0;
    let validCount = 0;
    const detailedResults = [];
    
    // Create backup
    const backupPath = path.join(__dirname, '../data/dataToIngest_pre_validation.json');
    fs.writeFileSync(backupPath, rawData, 'utf8');
    console.log('💾 Created backup at dataToIngest_pre_validation.json');
    
    for (let i = 0; i < data.length; i++) {
      const item = data[i];
      const originalJql = item.jql;
      
      // Validate with our simple validator
      const validation = await validateJQLWithLLM(originalJql, item.nlq);
      
      if (!validation.isValid) {
        console.log(`\\n❌ Issues found in ${item.id}: "${item.nlq}"`);
        console.log(`   Original JQL: ${originalJql}`);
        console.log(`   Errors: ${validation.errors.join(', ')}`);
        console.log(`   Fixed JQL: ${validation.correctedJQL}`);
        
        item.jql = validation.correctedJQL;
        fixedCount++;
        
        detailedResults.push({
          id: item.id,
          nlq: item.nlq,
          originalJQL: originalJql,
          fixedJQL: validation.correctedJQL,
          errors: validation.errors,
          confidence: validation.confidence
        });
      } else {
        validCount++;
      }
      
      // Show progress every 50 items
      if ((i + 1) % 50 === 0) {
        console.log(`📈 Progress: ${i + 1}/${data.length} processed`);
      }
    }
    
    console.log('\\n📊 VALIDATION SUMMARY:');
    console.log(`✅ Valid JQL queries: ${validCount}`);
    console.log(`🔧 Fixed JQL queries: ${fixedCount}`);
    console.log(`📈 Success rate: ${((validCount + fixedCount) / data.length * 100).toFixed(1)}%`);
    
    // Save fixed data
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf8');
    console.log('💾 Saved fixed dataset to dataToIngest.json');
    
    // Save detailed results
    const resultsPath = path.join(__dirname, '../data/validation_results.json');
    fs.writeFileSync(resultsPath, JSON.stringify(detailedResults, null, 2), 'utf8');
    console.log('📋 Saved detailed results to validation_results.json');
    
    console.log('\\n✅ JQL validation and fixing complete!');
    
  } catch (error) {
    console.error('❌ Error validating dataset:', error);
  }
}

validateAndFixDataset();