import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function fixJQLSyntax(jql) {
  let fixed = jql.trim();
  
  // 1. Fix obvious malformed JQL from previous script
  fixed = fixed.replace(/\s+or\s+/g, ' '); // Remove spurious " or " insertions
  fixed = fixed.replace(/>\s+=/g, '>='); // Fix broken >= operators
  fixed = fixed.replace(/<\s+=/g, '<='); // Fix broken <= operators  
  fixed = fixed.replace(/!\s+=/g, '!='); // Fix broken != operators
  fixed = fixed.replace(/!\s+~/g, '!~'); // Fix broken !~ operators
  
  // 2. Fix specific broken patterns from the validation output
  fixed = fixed.replace(/statusCateg\s*or\s*y/g, 'statusCategory');
  fixed = fixed.replace(/rep\s*or\s*ter/g, 'reporter');
  fixed = fixed.replace(/\w+\s*or\s*\w+/g, (match) => {
    // Only fix if it looks like a broken field name
    if (match.includes(' or ')) {
      return match.replace(/\s*or\s*/g, '');
    }
    return match;
  });
  
  // 3. Fix unquoted string values that should be quoted
  const quotingFixes = [
    // Fix unquoted string values after = operator
    { pattern: /(\b(?:status|priority|resolution|issuetype|component)\s*=\s*)([A-Za-z][A-Za-z0-9\s\-_]*[A-Za-z0-9])(\s|$|AND|OR|\))/gi, replacement: '$1"$2"$3' },
    
    // Fix project keys
    { pattern: /(\bproject\s*=\s*)([A-Z][A-Z0-9_\-]*)(\s|$|AND|OR|\))/g, replacement: '$1"$2"$3' },
    
    // Fix IN clauses with unquoted values
    { pattern: /\bIN\s*\(\s*([^)]*)\s*\)/gi, replacement: (match, values) => {
      const valueList = values.split(',').map(v => {
        const trimmed = v.trim();
        // Skip if already quoted, is a number, or is a function
        if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed;
        if (/^\d+$/.test(trimmed)) return trimmed;
        if (/^[a-zA-Z]+\(\)$/.test(trimmed)) return trimmed;
        if (/^(EMPTY|NULL|TRUE|FALSE)$/i.test(trimmed)) return trimmed;
        // Quote string values
        return `"${trimmed}"`;
      });
      return `IN (${valueList.join(', ')})`;
    }}
  ];
  
  quotingFixes.forEach(rule => {
    fixed = fixed.replace(rule.pattern, rule.replacement);
  });
  
  // 4. Remove quotes from keywords and functions that shouldn't be quoted
  fixed = fixed.replace(/"(EMPTY|NULL|TRUE|FALSE)"/gi, '$1');
  fixed = fixed.replace(/"(currentUser|membersOf|unreleasedVersions|releasedVersions|openSprints|closedSprints|futureSprints|startOfDay|startOfWeek|startOfMonth|endOfDay|endOfWeek|endOfMonth|now|met|breached|remaining)\(\)"/gi, '$1()');
  
  // 5. Fix specific malformed queries from the dataset
  
  // Fix queries that got mangled by previous processing
  fixed = fixed.replace(/issuetype = "Bug AND resolution"/g, 'issuetype = Bug AND resolution');
  fixed = fixed.replace(/issuetype = "Task AND resolved"/g, 'issuetype = Task AND resolved');
  fixed = fixed.replace(/issuetype = "Story AND sprint IN"/g, 'issuetype = Story AND sprint IN');
  fixed = fixed.replace(/issuetype = "Epic AND issueFunction NOT IN"/g, 'issuetype = Epic AND issueFunction NOT IN');
  fixed = fixed.replace(/statusCategory != "Done AND assignee"/g, 'statusCategory != Done AND assignee');
  fixed = fixed.replace(/project = "ALPHA" AND issuetype = "Bug AND priority"/g, 'project = "ALPHA" AND issuetype = Bug AND priority');
  
  // Fix broken function calls
  fixed = fixed.replace(/"currentUser"\(\)/g, 'currentUser()');
  fixed = fixed.replace(/assignee = "currentUser"\(\)/g, 'assignee = currentUser()');
  fixed = fixed.replace(/reporter = "currentUser"\(\)/g, 'reporter = currentUser()');
  
  // 6. Ensure proper spacing around operators
  fixed = fixed.replace(/\s*(=|!=|>=|<=|>|<|~|!~|IN|NOT IN|IS|IS NOT|WAS|CHANGED)\s*/gi, ' $1 ');
  fixed = fixed.replace(/\s+(AND|OR)\s+/gi, ' $1 ');
  fixed = fixed.replace(/\s+/g, ' '); // Clean up multiple spaces
  
  return fixed.trim();
}

async function fixDataset() {
  try {
    // Restore from the pre-validation backup since the previous fix created issues
    const backupPath = path.join(__dirname, '../data/dataToIngest_pre_validation.json');
    const dataPath = path.join(__dirname, '../data/dataToIngest.json');
    
    let rawData;
    if (fs.existsSync(backupPath)) {
      console.log('📋 Restoring from pre-validation backup...');
      rawData = fs.readFileSync(backupPath, 'utf8');
    } else {
      console.log('📋 Using current dataToIngest.json...');
      rawData = fs.readFileSync(dataPath, 'utf8');
    }
    
    const data = JSON.parse(rawData);
    
    console.log('🔧 Fixing JQL syntax properly...');
    console.log(`📊 Processing ${data.length} examples`);
    
    let fixedCount = 0;
    const examples = [];
    
    data.forEach((item, index) => {
      const originalJql = item.jql;
      const fixedJql = fixJQLSyntax(originalJql);
      
      if (originalJql !== fixedJql) {
        fixedCount++;
        
        if (examples.length < 10) {
          examples.push({
            id: item.id,
            nlq: item.nlq,
            before: originalJql,
            after: fixedJql
          });
        }
        
        item.jql = fixedJql;
      }
    });
    
    console.log(`\\n✅ Fixed ${fixedCount} JQL queries`);
    
    // Show examples of fixes
    console.log('\\n📝 Example fixes:');
    examples.forEach(ex => {
      console.log(`\\n${ex.id}: "${ex.nlq}"`);
      console.log(`  Before: ${ex.before}`);
      console.log(`  After:  ${ex.after}`);
    });
    
    // Save the properly fixed data
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf8');
    console.log('\\n💾 Saved properly fixed dataset to dataToIngest.json');
    
    console.log('\\n🎯 Next step: Manual validation of a sample of queries');
    
  } catch (error) {
    console.error('❌ Error fixing dataset:', error);
  }
}

fixDataset();