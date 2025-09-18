# Workflow Migration Fixes Needed

## Summary of Required Changes

The workflow.ts file needs extensive updates to work with the new database schema. Here are the key changes required:

## 1. Column Name Fixes
- `workflowExecutionId` → `workflowExeId` ✅ DONE
- `toolExecution` → `workflowToolExe` ✅ DONE
- `workflowExecution` → `workflowExe` ✅ DONE
- `workflowStepExecution` → `workflowStepExe` ✅ DONE

## 2. Removed Schema Fields (Need to be Removed/Replaced)
- ❌ `parentStepId` - No longer exists, remove from step creation
- ❌ `prevStepIds` - No longer exists, replace with connection table queries
- ❌ `nextStepIds` - No longer exists, replace with connection table queries
- ❌ `tool.value` - Changed to `tool.config` or use template data
- ❌ `workflowToolExe.startedAt` - Only `executedAt` exists now
- ❌ `workflowToolExe.completedAt` - Only `executedAt` exists now
- ❌ `workflowToolExe.updatedAt` - Doesn't exist in new schema

## 3. Tool Execution Schema Changes
The `workflowToolExe` table has:
- `toolTemplateId` (not `workflowToolId`) ✅ DONE
- `workflowStepExeId` (not `workflowExeId`) ✅ DONE
- Only `executedAt` and `createdAt` timestamps

## 4. Tool Insert Operations Need Updating
All `.insert(toolExecution)` operations need to:
- Use `workflowToolExe` table ❌ NOT DONE
- Use correct column names
- Remove references to missing fields

## 5. ToolType.FORM vs Enum Mismatch
- Code uses `ToolType.FORM` but schema enum doesn't include 'form'
- Enum has: 'python_script', 'slack', 'gmail', 'agent', 'delay', 'merged_node'
- Need to either add 'form' to enum or handle this differently

## 6. Missing Required Fields
- `workflowTemplate` now requires `workspaceId`
- Various other tables may have new required fields

## 7. Step Relationships (Priority Fix)
Replace all `nextStepIds`/`prevStepIds` array logic with connection table queries:
- Use `workflowStepTemplateConnection` for template relationships
- Use `workflowStepExeConnection` for execution relationships
- Implement helper functions to query connections

## 8. Workflow Creation Issues
Template creation missing required `workspaceId` field

## Migration Strategy
1. ✅ Fix table/column name references
2. ❌ Remove all parentStepId, prevStepIds, nextStepIds references
3. ❌ Implement connection table query helpers
4. ❌ Fix tool execution inserts
5. ❌ Add missing required fields
6. ❌ Fix ToolType enum issues
7. ❌ Test API endpoints

## Next Steps
The file has too many errors to fix incrementally. Recommend:
1. Create helper functions for connection table queries
2. Systematically remove old field references
3. Update all insert operations
4. Test each endpoint individually