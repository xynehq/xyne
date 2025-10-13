import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function fixJQLSyntax(jql) {
  let fixed = jql;
  
  // Fix unquoted string values for common JIRA fields
  const fieldPatterns = [
    // Status values
    { pattern: /(\bstatus\s*[=!]\s*)([A-Za-z][A-Za-z0-9\s]*[A-Za-z0-9])(\s|$|AND|OR|\))/gi, replacement: '$1"$2"$3' },
    { pattern: /(\bstatusCategory\s*[=!]\s*)([A-Za-z][A-Za-z0-9\s]*[A-Za-z0-9])(\s|$|AND|OR|\))/gi, replacement: '$1"$2"$3' },
    
    // Project values
    { pattern: /(\bproject\s*(?:=|!=|IN|NOT IN)\s*\(?\s*)([A-Z][A-Z0-9_-]*)(\s*\)?)/gi, replacement: '$1"$2"$3' },
    
    // Issue type values
    { pattern: /(\bissuetype\s*[=!]\s*)([A-Za-z][A-Za-z0-9\s]*[A-Za-z0-9])(\s|$|AND|OR|\))/gi, replacement: '$1"$2"$3' },
    
    // Priority values
    { pattern: /(\bpriority\s*[=!]\s*)([A-Za-z][A-Za-z0-9\s]*[A-Za-z0-9])(\s|$|AND|OR|\))/gi, replacement: '$1"$2"$3' },
    
    // Resolution values
    { pattern: /(\bresolution\s*[=!]\s*)([A-Za-z][A-Za-z0-9\s]*[A-Za-z0-9])(\s|$|AND|OR|\))/gi, replacement: '$1"$2"$3' },
    
    // Component values
    { pattern: /(\bcomponent\s*[=!]\s*)([A-Za-z][A-Za-z0-9\s]*[A-Za-z0-9])(\s|$|AND|OR|\))/gi, replacement: '$1"$2"$3' },
    
    // Label values
    { pattern: /(\blabels?\s*[=!]\s*)([A-Za-z][A-Za-z0-9_-]*[A-Za-z0-9])(\s|$|AND|OR|\))/gi, replacement: '$1"$2"$3' },
    
    // User values (assignee, reporter, etc.)
    { pattern: /(\b(?:assignee|reporter|creator|watcher|voter)\s*[=!]\s*)([a-z][a-z0-9._-]*[a-z0-9])(\s|$|AND|OR|\))/gi, replacement: '$1"$2"$3' },
  ];
  
  // Apply fixes
  fieldPatterns.forEach(({ pattern, replacement }) => {
    fixed = fixed.replace(pattern, replacement);
  });
  
  // Fix specific cases
  fixed = fixed.replace(/\bEMPTY\b/g, 'EMPTY'); // Ensure EMPTY is not quoted
  fixed = fixed.replace(/\b(TRUE|FALSE|NULL)\b/gi, (match) => match.toUpperCase()); // Ensure keywords are uppercase
  
  // Fix double quotes in already quoted strings
  fixed = fixed.replace(/"([^"]*)""/g, '"$1"');
  fixed = fixed.replace(/""([^"]*)"/g, '"$1"');
  
  // Remove quotes from functions and keywords
  fixed = fixed.replace(/"(currentUser|membersOf|unreleasedVersions|releasedVersions|openSprints|closedSprints|futureSprints|startOfDay|startOfWeek|startOfMonth|endOfDay|endOfWeek|endOfMonth|now)\(\)"/gi, '$1()');
  fixed = fixed.replace(/"(EMPTY|NULL|TRUE|FALSE)"/gi, '$1');
  
  return fixed;
}

async function fixDatasetSyntax() {
  try {
    const dataPath = path.join(__dirname, '../data/dataToIngest.json');
    const rawData = fs.readFileSync(dataPath, 'utf8');
    const data = JSON.parse(rawData);
    
    console.log('🔧 Fixing JQL syntax issues...');
    
    let fixedCount = 0;
    
    data.forEach((item, index) => {
      const originalJql = item.jql;
      const fixedJql = fixJQLSyntax(originalJql);
      
      if (originalJql !== fixedJql) {
        item.jql = fixedJql;
        fixedCount++;
        
        if (fixedCount <= 5) {
          console.log(`\\n✅ Fixed ${item.id}:`);
          console.log(`   Before: ${originalJql}`);
          console.log(`   After:  ${fixedJql}`);
        }
      }
    });
    
    console.log(`\\n🎯 Fixed ${fixedCount} JQL syntax issues`);
    
    // Save the fixed data
    const backupPath = path.join(__dirname, '../data/dataToIngest_backup.json');
    fs.writeFileSync(backupPath, rawData, 'utf8');
    console.log('💾 Created backup at dataToIngest_backup.json');
    
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf8');
    console.log('💾 Saved fixed data to dataToIngest.json');
    
  } catch (error) {
    console.error('❌ Error fixing syntax:', error);
  }
}

fixDatasetSyntax();