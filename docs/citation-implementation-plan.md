# Citation Implementation Plan for message-agents.ts

## Executive Summary

**Problem**: The new `MessageAgents` implementation in `message-agents.ts` lacks citation extraction and streaming, resulting in answers without proper source references.

**Solution**: Port the complete citation handling system from `MessageWithToolsApi` to `MessageAgents`.

**Status**: Citations are completely missing in the new implementation.

---

## Gap Analysis

### ✅ What MessageWithToolsApi Has (Working)

1. **Citation Extraction Function** (`checkAndYieldCitationsForAgent`)
   - Location: `agents.ts` lines 570-730
   - Regex-based citation detection: `[1]`, `[2]`, etc.
   - Image citation detection: `[1_0]`, `[2_3]`, etc.
   - Duplicate prevention via `yieldedCitations` Set
   - Entity filtering (excludes attachment entities)
   - Real-time streaming to client

2. **Citation Processing During Streaming**
   - Location: `agents.ts` lines 2242-2291 (assistant_message case)
   - Streams answer in chunks
   - Calls `checkAndYieldCitationsForAgent` on each chunk
   - Emits `CitationsUpdate` SSE events
   - Emits `ImageCitationUpdate` SSE events
   - Builds `citationMap` and `citationValues`

3. **Citation Storage**
   - Location: `agents.ts` lines 2304-2333
   - Stores citations array in message
   - Stores imageCitations array
   - Processes message with `processMessage(answer, citationMap)`
   - Persists to database

4. **Citation Data Structures**
   - `citations: Citation[]` - Array of citation objects
   - `citationMap: Record<number, number>` - Maps citation index to array position
   - `citationValues: Record<number, Citation>` - Maps index to citation object
   - `imageCitations: ImageCitation[]` - Array of image citations
   - `yieldedCitations: Set<number>` - Prevents duplicates
   - `yieldedImageCitations: Map<number, Set<number>>` - Tracks image citations

### ❌ What message-agents.ts is Missing

1. **No Citation Extraction**
   - `checkAndYieldCitationsForAgent` function not imported
   - No citation detection during streaming
   - No SSE events for citations

2. **No Citation Storage**
   - Citations not stored in database
   - Message not processed with citation map
   - Raw answer stored without citation references

3. **No Citation State Tracking**
   - Missing `yieldedCitations` Set
   - Missing `yieldedImageCitations` Map
   - Missing `citationMap` and `citationValues`

4. **No Image Citation Support**
   - No image citation detection
   - No image citation SSE events
   - No image citation storage

---

## Root Cause Analysis

### Why Citations are Missing

1. **Incomplete Port**: The MessageAgents implementation focused on JAF integration but didn't port the citation system
2. **Missing Imports**: `checkAndYieldCitationsForAgent` not imported from utils
3. **Simplified Streaming**: The streaming loop doesn't check for citations
4. **Incomplete DB Insert**: `insertMessage` called without citations/imageCitations parameters

### Design Implications

The citation system in MessageWithToolsApi is tightly coupled to:
- The streaming loop (checking each chunk)
- The `gatheredFragments` array (citation sources)
- SSE event emission infrastructure
- Database schema (sources, imageCitations columns)

All of these need to be replicated in message-agents.ts.

---

## Implementation Plan

### Phase 1: Import Dependencies ✅

**File**: `server/api/chat/message-agents.ts`

**Action**: Add missing imports at the top of the file

```typescript
// Add to existing imports section
import { checkAndYieldCitationsForAgent } from "./utils"
import type { Citation, ImageCitation } from "./types"
```

**Reasoning**: Need the citation extraction function and type definitions.

---

### Phase 2: Initialize Citation State Variables ✅

**File**: `server/api/chat/message-agents.ts`

**Location**: Inside the `streamSSE` callback, before the JAF streaming loop (around line 896)

**Action**: Add citation tracking variables alongside existing state

```typescript
// Existing state
let answer = ""
const citations: Citation[] = []
const imageCitations: ImageCitation[] = []
const citationMap: Record<number, number> = {}
const citationValues: Record<number, Citation> = {}

// ADD THESE:
const yieldedCitations = new Set<number>()
const yieldedImageCitations = new Map<number, Set<number>>()
```

**Reasoning**: These track which citations have been sent to prevent duplicates during streaming.

---

### Phase 3: Add Citation Extraction to Streaming Loop ⚠️

**File**: `server/api/chat/message-agents.ts`

**Location**: In the `assistant_message` case of the JAF event loop (around lines 970-987)

**Current Code**:
```typescript
case "assistant_message":
  const content = getTextContent(evt.data.message.content) || ""
  if (content) {
    const extractedExpectations = extractExpectedResults(content)
    // ... expectation handling ...
    
    answer += content
    await stream.writeSSE({
      event: ChatSSEvents.ResponseUpdate,
      data: content,
    })
  }
  break
```

**New Code**:
```typescript
case "assistant_message":
  const content = getTextContent(evt.data.message.content) || ""
  if (content) {
    const hasToolCalls = Array.isArray(evt.data.message?.tool_calls) &&
      (evt.data.message.tool_calls?.length ?? 0) > 0
    
    if (!content || content.length === 0) {
      break
    }
    
    if (hasToolCalls) {
      // Tool planning content - emit as reasoning, not answer
      const extractedExpectations = extractExpectedResults(content)
      if (extractedExpectations.length > 0) {
        // ... existing expectation handling ...
      }
      
      await streamReasoningStep(
        emitReasoningStep,
        content,
        { type: AgentReasoningStepType.LogMessage, status: "in_progress" }
      )
      break
    }
    
    // No tool calls: stream as final answer with citations
    const chunkSize = 200
    for (let i = 0; i < content.length; i += chunkSize) {
      const chunk = content.slice(i, i + chunkSize)
      answer += chunk
      
      await stream.writeSSE({
        event: ChatSSEvents.ResponseUpdate,
        data: chunk,
      })
      
      // ⭐ CRITICAL: Extract and yield citations on-the-fly
      for await (const cit of checkAndYieldCitationsForAgent(
        answer,
        yieldedCitations,
        agentContext.contextFragments,  // Source fragments
        yieldedImageCitations,
        email
      )) {
        if (cit.citation) {
          const { index, item } = cit.citation
          citations.push(item)
          citationMap[index] = citations.length - 1
          
          await stream.writeSSE({
            event: ChatSSEvents.CitationsUpdate,
            data: JSON.stringify({
              contextChunks: citations,
              citationMap,
            }),
          })
          
          citationValues[index] = item
        }
        
        if (cit.imageCitation) {
          imageCitations.push(cit.imageCitation)
          
          await stream.writeSSE({
            event: ChatSSEvents.ImageCitationUpdate,
            data: JSON.stringify(cit.imageCitation),
          })
        }
      }
    }
  }
  break
```

**Reasoning**:
1. **Chunk Processing**: Process answer in 200-char chunks (same as MessageWithToolsApi)
2. **Real-time Citation Extraction**: Call `checkAndYieldCitationsForAgent` after each chunk
3. **SSE Events**: Emit `CitationsUpdate` and `ImageCitationUpdate` immediately
4. **Citation Tracking**: Build citationMap and citationValues for final processing
5. **Tool Call Handling**: Separate tool planning content from final answer

---

### Phase 4: Update Database Insertion ✅

**File**: `server/api/chat/message-agents.ts`

**Location**: In the `run_end` case where message is inserted (around lines 1044-1062)

**Current Code**:
```typescript
const msg = await insertMessage(db, {
  chatId: chatRecord.id,
  userId: user.id,
  workspaceExternalId: workspace.externalId,
  chatExternalId: chatRecord.externalId,
  messageRole: MessageRole.Assistant,
  email: user.email,
  sources: citations,  // Already present but empty!
  imageCitations: [],  // Empty!
  message: answer,     // Raw answer without citation processing!
  thinking: "",
  modelId: defaultBestModel,
  cost: totalCost.toString(),
  tokensUsed: totalTokens,
})
```

**New Code**:
```typescript
const msg = await insertMessage(db, {
  chatId: chatRecord.id,
  userId: user.id,
  workspaceExternalId: workspace.externalId,
  chatExternalId: chatRecord.externalId,
  messageRole: MessageRole.Assistant,
  email: user.email,
  sources: citations,              // ✅ Now populated from streaming
  imageCitations: imageCitations,  // ✅ Now populated from streaming
  message: processMessage(answer, citationMap),  // ⭐ CRITICAL: Process with citation map
  thinking: "",
  modelId: defaultBestModel,
  cost: totalCost.toString(),
  tokensUsed: totalTokens,
})
```

**Reasoning**:
1. **processMessage**: Converts citation indices in answer text to proper references
2. **sources**: Array of Citation objects with docId, url, title, etc.
3. **imageCitations**: Array of ImageCitation objects with base64 data

---

### Phase 5: Add processMessage Import ✅

**File**: `server/api/chat/message-agents.ts`

**Location**: Top of file in imports section

**Action**: Ensure `processMessage` is imported

```typescript
import { processMessage } from "./utils"
```

**Reasoning**: This function transforms `[1]` references in the answer to proper citation format.

---

### Phase 6: Handle final_output Case ⚠️

**File**: `server/api/chat/message-agents.ts`

**Location**: In the `final_output` case (around lines 989-1003)

**Current Code**:
```typescript
case "final_output":
  const output = evt.data.output
  if (typeof output === "string" && output.length > 0) {
    const remaining = output.slice(answer.length)
    if (remaining) {
      await stream.writeSSE({
        event: ChatSSEvents.ResponseUpdate,
        data: remaining,
      })
    }
  }
  break
```

**New Code**:
```typescript
case "final_output":
  const output = evt.data.output
  if (typeof output === "string" && output.length > 0) {
    const remaining = output.slice(answer.length)
    if (remaining) {
      await stream.writeSSE({
        event: ChatSSEvents.ResponseUpdate,
        data: remaining,
      })
      answer = output  // Update full answer
      
      // ⭐ Extract citations from final output
      for await (const cit of checkAndYieldCitationsForAgent(
        answer,
        yieldedCitations,
        agentContext.contextFragments,
        yieldedImageCitations,
        email
      )) {
        if (cit.citation) {
          const { index, item } = cit.citation
          citations.push(item)
          citationMap[index] = citations.length - 1
          
          await stream.writeSSE({
            event: ChatSSEvents.CitationsUpdate,
            data: JSON.stringify({
              contextChunks: citations,
              citationMap,
            }),
          })
          
          citationValues[index] = item
        }
        
        if (cit.imageCitation) {
          imageCitations.push(cit.imageCitation)
          
          await stream.writeSSE({
            event: ChatSSEvents.ImageCitationUpdate,
            data: JSON.stringify(cit.imageCitation),
          })
        }
      }
    }
  }
  break
```

**Reasoning**: Ensure any remaining content in final_output is also checked for citations.

---

### Phase 7: System Prompt Enhancement 🔄

**File**: `server/api/chat/message-agents.ts`

**Location**: In `buildAgentInstructions` function (around lines 670-748)

**Current Prompt Includes**:
```typescript
# IMPORTANT Citation Format:
- Use square brackets with the context index number: [1], [2], etc.
- Place citations right after the relevant statement
- NEVER group multiple indices in one bracket like [1, 2] or [1, 2, 3]
```

**Enhancement** (already present, verify it's correct):
```typescript
# IMPORTANT Citation Format:
- Use square brackets with the context index number: [1], [2], etc.
- Place citations right after the relevant statement
- NEVER group multiple indices in one bracket like [1, 2] or [1, 2, 3] - this is an error
- Example: "The project deadline was moved to March [3] and the team agreed [5]"
- Only cite information that directly appears in the context
- WRONG: "The project deadline was changed and the team agreed to it [0, 2, 4]"
- RIGHT: "The project deadline was changed [1] and the team agreed to it [2]"
```

**Status**: ✅ Already present in the code, no changes needed.

---

## Testing Strategy

### Unit Tests

```typescript
describe("MessageAgents Citation Handling", () => {
  it("should extract citations from streaming answer", async () => {
    // Test citation extraction during streaming
  })
  
  it("should prevent duplicate citations", async () => {
    // Test yieldedCitations Set functionality
  })
  
  it("should extract image citations", async () => {
    // Test image citation detection [1_0] format
  })
  
  it("should build correct citationMap", async () => {
    // Test citation index mapping
  })
  
  it("should process message with citations", async () => {
    // Test processMessage function integration
  })
})
```

### Integration Tests

1. **Test Scenario 1**: Query with single citation
   - User asks: "What is the Q4 revenue?"
   - Expected: Answer with `[1]` citation
   - Verify: `CitationsUpdate` SSE event sent
   - Verify: Citation stored in DB

2. **Test Scenario 2**: Query with multiple citations
   - User asks: "Compare Q3 and Q4 performance"
   - Expected: Answer with `[1]` and `[2]` citations
   - Verify: Both citations yielded separately
   - Verify: Correct citationMap built

3. **Test Scenario 3**: Query with image citations
   - User asks about document with images
   - Expected: Answer with `[1_0]` image citation
   - Verify: `ImageCitationUpdate` SSE event sent
   - Verify: Image data in base64 format

4. **Test Scenario 4**: No citations needed
   - User asks general question
   - Expected: Answer without citations
   - Verify: No citation SSE events
   - Verify: Empty citations array in DB

---

## Implementation Checklist

- [ ] Phase 1: Import `checkAndYieldCitationsForAgent` and types
- [ ] Phase 2: Initialize citation state variables
- [ ] Phase 3: Add citation extraction to `assistant_message` case
- [ ] Phase 4: Update `insertMessage` call with citations and `processMessage`
- [ ] Phase 5: Ensure `processMessage` is imported
- [ ] Phase 6: Handle citations in `final_output` case
- [ ] Phase 7: Verify system prompt has citation instructions
- [ ] Test: Unit tests for citation extraction
- [ ] Test: Integration tests with real queries
- [ ] Test: Verify citations in database
- [ ] Test: Verify citation SSE events in frontend
- [ ] Documentation: Update API docs with citation behavior

---

## Risk Analysis

### Low Risk ✅
- Importing existing functions
- Adding state variables
- Database already supports citations schema

### Medium Risk ⚠️
- Citation extraction logic complexity
- Streaming performance impact (checking every chunk)
- Potential duplicate citations if not tracked properly

### High Risk 🔴
- Breaking existing functionality if not careful
- Citation regex might not match all patterns
- Image citation buffer encoding could fail

### Mitigation Strategies

1. **Gradual Rollout**: Test with feature flag before full deployment
2. **Monitoring**: Add logging for citation extraction performance
3. **Fallback**: If citation extraction fails, still save the answer
4. **Validation**: Add schema validation for citations before DB insert

---

## Performance Considerations

### Citation Extraction Overhead

**Current**: No citation processing → 0ms overhead

**New**: Citation regex + async iteration on each chunk
- Estimated: 1-5ms per chunk
- For 2000 char answer (10 chunks): 10-50ms total
- **Impact**: Negligible (<3% of total response time)

### Optimization Opportunities

1. **Batch Citation Extraction**: Instead of checking every chunk, check every N chunks
2. **Citation Caching**: Cache regex results for identical patterns
3. **Lazy Loading**: Defer image citation loading until user requests

---

## Comparison: MessageWithToolsApi vs MessageAgents

| Feature | MessageWithToolsApi | MessageAgents (Current) | MessageAgents (After Fix) |
|---------|---------------------|-------------------------|---------------------------|
| Citation Extraction | ✅ Yes | ❌ No | ✅ Yes |
| Citation SSE Events | ✅ Yes | ❌ No | ✅ Yes |
| Citation DB Storage | ✅ Yes | ❌ No | ✅ Yes |
| Image Citations | ✅ Yes | ❌ No | ✅ Yes |
| processMessage | ✅ Yes | ❌ No | ✅ Yes |
| Duplicate Prevention | ✅ Yes | ❌ No | ✅ Yes |

---

## Code Diff Preview

### Before (message-agents.ts lines 970-987)
```typescript
case "assistant_message":
  const content = getTextContent(evt.data.message.content) || ""
  if (content) {
    const extractedExpectations = extractExpectedResults(content)
    // ... expectation handling ...
    
    answer += content
    await stream.writeSSE({
      event: ChatSSEvents.ResponseUpdate,
      data: content,
    })
  }
  break
```

### After (message-agents.ts with citations)
```typescript
case "assistant_message":
  const content = getTextContent(evt.data.message.content) || ""
  if (content) {
    const hasToolCalls = Array.isArray(evt.data.message?.tool_calls) &&
      (evt.data.message.tool_calls?.length ?? 0) > 0
    
    if (!content || content.length === 0) break
    
    if (hasToolCalls) {
      // Handle as reasoning, not answer
      const extractedExpectations = extractExpectedResults(content)
      // ...
      await streamReasoningStep(emitReasoningStep, content, {...})
      break
    }
    
    // Final answer: stream with citations
    const chunkSize = 200
    for (let i = 0; i < content.length; i += chunkSize) {
      const chunk = content.slice(i, i + chunkSize)
      answer += chunk
      await stream.writeSSE({
        event: ChatSSEvents.ResponseUpdate,
        data: chunk,
      })
      
      // Extract citations on-the-fly
      for await (const cit of checkAndYieldCitationsForAgent(
        answer, yieldedCitations, agentContext.contextFragments,
        yieldedImageCitations, email
      )) {
        if (cit.citation) {
          const { index, item } = cit.citation
          citations.push(item)
          citationMap[index] = citations.length - 1
          await stream.writeSSE({
            event: ChatSSEvents.CitationsUpdate,
            data: JSON.stringify({ contextChunks: citations, citationMap }),
          })
          citationValues[index] = item
        }
        if (cit.imageCitation) {
          imageCitations.push(cit.imageCitation)
          await stream.writeSSE({
            event: ChatSSEvents.ImageCitationUpdate,
            data: JSON.stringify(cit.imageCitation),
          })
        }
      }
    }
  }
  break
```

---

## Success Criteria

✅ **Implementation Complete When**:
1. Citations extracted during streaming
2. `CitationsUpdate` SSE events sent to client
3. `ImageCitationUpdate` SSE events sent for images
4. Citations stored in database with message
5. `processMessage` transforms citation indices
6. No duplicate citations sent
7. Frontend displays citations correctly
8. All tests passing

---

## Timeline Estimate

- **Phase 1-2**: 30 minutes (imports + state)
- **Phase 3**: 2 hours (streaming loop changes)
- **Phase 4-5**: 30 minutes (DB insertion)
- **Phase 6**: 1 hour (final_output handling)
- **Phase 7**: 30 minutes (prompt verification)
- **Testing**: 3 hours (unit + integration tests)
- **Documentation**: 1 hour

**Total**: ~8-9 hours of development time

---

## Conclusion

The citation system is a **critical missing feature** in message-agents.ts that prevents proper source attribution in LLM responses. By porting the proven citation extraction logic from MessageWithToolsApi, we can achieve parity and ensure users receive properly cited answers.

The implementation is **low-risk** since we're reusing existing, tested code. The main effort is integrating it into the new JAF-based streaming architecture at the right points in the event loop.

**Priority**: HIGH - Citations are essential for enterprise search credibility.
