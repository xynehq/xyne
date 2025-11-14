# Implementation Plan: Smart Image Context in message-agents.ts

**Date**: November 13, 2025  
**Context**: Bridge the image-handling feature gap between `agents.ts` and `message-agents.ts`

## Executive Summary

`message-agents.ts` currently only passes user attachment images to the LLM, while `agents.ts` passes both user attachments AND images from search results/storage. This document outlines a plan to implement smart image selection in `message-agents.ts` that:

1. Passes task-relevant images during agent reasoning (efficient)
2. Passes all accumulated images during final answer generation (accurate)
3. Avoids wasting tokens on irrelevant images from previous tool calls

## Current State Analysis

### What Works in agents.ts (MessageWithToolsApi)

**Location**: `server/api/chat/agents.ts` (lines ~520-600)

```typescript
// After search results are obtained
const { imageFileNames } = extractImageFileNames(
  context,
  results.root.children as VespaSearchResult[]
);

// Images passed to LLM
const params: ModelParams = {
  modelId: defaultBestModel,
  imageFileNames: imageFileNames, // Both attachments + search results
  // ... other params
};
```

**Key Function**: `extractImageFileNames` in `server/api/chat/utils.ts`
- Extracts image references from document content
- Builds file names like: `${docIndex}_${docId}_${imageNumber}`
- Returns array of image file names to load from disk

### What's Missing in message-agents.ts

**Location**: `server/api/chat/message-agents.ts`

Current state:
- ✅ User attachment images are passed via `message.attachments`
- ❌ Images from search results are NOT extracted or passed
- ❌ No image accumulation across tool calls
- ❌ No image metadata tracking

## Design Decision: Recency-Based Selection (Not Final Synthesis Tool)

### Why Not "Final Synthesis Tool"?

After analyzing JAF's engine.ts (lines 500-600), we discovered:
- When a tool returns, JAF automatically starts another turn
- A "final synthesis" tool would trigger an additional LLM call
- The agent would need explicit instructions to "sign off" after synthesis
- This adds complexity and an extra turn for minimal benefit

### Chosen Approach: Smart Recency-Based Selection

**During Reasoning** (Turns 1-N):
- Pass only images from the last 2 turns
- Include all user-provided attachment images (always relevant)
- Keeps context lean and cost-effective

**During Final Output** (When JAF emits `final_output`):
- The LLM already has all necessary images from recent turns
- If final answer cites an older image, it's likely an error
- User can ask follow-up if more context needed

## Implementation Plan

### Phase 1: Update AgentRunContext Schema

**File**: `server/api/chat/agent-schemas.ts`

**Changes**:
```typescript
export interface AgentRunContext {
  // ... existing fields ...
  
  // NEW: Image tracking fields
  imageFileNames: string[];  // All discovered image file names
  imageMetadata: Map<string, {
    addedAtTurn: number;      // Which turn this image was found
    sourceFragmentId: string; // Which fragment contains this image
    sourceToolName: string;   // Which tool returned this image
    isUserAttachment: boolean; // True for user-provided images
  }>;
  
  // NEW: Current turn counter (for recency calculation)
  turnCount: number;
}
```

**Rationale**: Centralized storage for all image information enables smart selection later.

### Phase 2: Initialize New Fields

**File**: `server/api/chat/message-agents.ts`

**Function**: `initializeAgentContext` (around line 800)

**Changes**:
```typescript
function initializeAgentContext(
  user: { email: string; workspaceId: string; id: string; numericId?: number; workspaceNumericId?: number },
  chat: { externalId: string; metadata: Record<string, unknown> },
  message: { text: string; attachments: Array<{ fileId: string; isImage: boolean }>; timestamp: string }
): AgentRunContext {
  return {
    user,
    chat,
    message,
    plan: null,
    currentSubTask: null,
    userContext: "", // Will be set later
    
    // ... existing initializations ...
    
    // NEW: Initialize image tracking
    imageFileNames: [],
    imageMetadata: new Map(),
    turnCount: 0, // Start at 0, incremented on each turn_start event
  };
}
```

### Phase 3: Handle Initial User Attachments

**File**: `server/api/chat/message-agents.ts`

**Location**: Before JAF runStream starts (around line 1100)

**Changes**:
```typescript
// After initializing baseCtx
const baseCtx: AgentRunContext = {
  // ... existing initialization ...
  imageFileNames: [],
  imageMetadata: new Map(),
  turnCount: 0,
};

// NEW: Add user attachment images to metadata
if (imageAttachmentFileIds && imageAttachmentFileIds.length > 0) {
  imageAttachmentFileIds.forEach((fileId, index) => {
    const imgName = `${index}_${fileId}_0`; // Format: index_fileId_imageNumber
    baseCtx.imageFileNames.push(imgName);
    baseCtx.imageMetadata.set(imgName, {
      addedAtTurn: 0, // User attachments are turn 0
      sourceFragmentId: 'user_attachment',
      sourceToolName: 'user_input',
      isUserAttachment: true,
    });
  });
  
  loggerWithChild({ email: sub }).info(
    `Initialized with ${imageAttachmentFileIds.length} user attachment images`
  );
}
```

### Phase 4: Extract Images After Tool Execution

**File**: `server/api/chat/message-agents.ts`

**Location**: Inside the `onAfterToolExecution` callback (around line 1200)

**Current Code**:
```typescript
onAfterToolExecution: async (toolName, result, context) => {
  const contexts = result?.metadata?.contexts;
  
  if (Array.isArray(contexts) && contexts.length) {
    // ... existing logic to filter and select best documents ...
    const selectedDocs: MinimalAgentFragment[] = [];
    // ... populate selectedDocs ...
    
    return selectedDocs.map(doc => doc.content).join("\n");
  }
  return null;
}
```

**New Code** (add after selectedDocs population):
```typescript
onAfterToolExecution: async (toolName, result, context) => {
  const contexts = result?.metadata?.contexts;
  
  if (Array.isArray(contexts) && contexts.length) {
    const filteredContexts = contexts.filter(v => !gatheredFragmentskeys.has(v.id));
    
    // ... existing best document selection logic ...
    
    if (bestDocIndexes.length) {
      const selectedDocs: MinimalAgentFragment[] = [];
      bestDocIndexes.forEach((idx) => {
        if (idx >= 1 && idx <= filteredContexts.length) {
          const doc = filteredContexts[idx - 1];
          const key = doc.id;
          if (!gatheredFragmentskeys.has(key)) {
            gatheredFragments.push(doc);
            gatheredFragmentskeys.add(key);
          }
          selectedDocs.push(doc);
        }
      });
      
      // NEW: Extract images from selected documents
      if (selectedDocs.length > 0) {
        const contextContent = selectedDocs.map(doc => doc.content).join("\n");
        
        // Build VespaSearchResult-like objects for extractImageFileNames
        const vespaLikeResults = selectedDocs.map(doc => ({
          fields: { docId: doc.source.docId }
        })) as VespaSearchResult[];
        
        const { imageFileNames: newImages } = extractImageFileNames(
          contextContent,
          vespaLikeResults
        );
        
        if (newImages.length > 0) {
          const currentTurn = context.state.turnCount;
          
          newImages.forEach(imgName => {
            // Only add if not already present
            if (!context.state.context.imageMetadata.has(imgName)) {
              context.state.context.imageFileNames.push(imgName);
              context.state.context.imageMetadata.set(imgName, {
                addedAtTurn: currentTurn,
                sourceFragmentId: selectedDocs[0]?.id || '',
                sourceToolName: toolName,
                isUserAttachment: false,
              });
            }
          });
          
          loggerWithChild({ email: sub }).info(
            `Extracted ${newImages.length} new images from ${toolName} at turn ${currentTurn}`
          );
        }
      }
      
      return selectedDocs.map(doc => doc.content).join("\n");
    }
  }
  return null;
}
```

**Key Points**:
- Uses existing `extractImageFileNames` utility function
- Tracks which turn each image was discovered
- Associates images with their source tool and fragment
- Maintains uniqueness (no duplicates)

### Phase 5: Update JAF Provider for Smart Selection

**File**: `server/api/chat/jaf-provider.ts`

**Current Code**:
```typescript
export const makeXyneJAFProvider = <Ctx>(): JAFModelProvider<Ctx> => {
  return {
    async getCompletion(state, agent, runCfg) {
      const model = runCfg.modelOverride ?? agent.modelConfig?.name;
      // ... existing setup ...
      
      const callOptions: LanguageModelV2CallOptions = {
        prompt,
        maxOutputTokens: agent.modelConfig?.maxTokens,
        temperature: agent.modelConfig?.temperature,
        // No imageFileNames currently passed
      };
      
      const result = await languageModel.doGenerate(callOptions);
      return { message: convertResultToJAFMessage(result.content) };
    }
  };
};
```

**New Code**:
```typescript
export const makeXyneJAFProvider = <Ctx extends AgentRunContext>(): JAFModelProvider<Ctx> => {
  return {
    async getCompletion(state, agent, runCfg) {
      const model = runCfg.modelOverride ?? agent.modelConfig?.name;
      const provider = getAISDKProviderByModel(model as Models);
      const modelConfig = MODEL_CONFIGURATIONS[model as Models];
      const actualModelId = modelConfig?.actualName ?? model;
      const languageModel = provider.languageModel(actualModelId);

      const prompt = buildPromptFromMessages(
        state.messages,
        agent.instructions(state),
      );
      
      const tools = buildFunctionTools(agent);
      
      // NEW: Smart image selection based on recency
      let imagesToPass: string[] = [];
      
      if (state.context.imageFileNames && state.context.imageFileNames.length > 0) {
        const currentTurn = state.context.turnCount || 0;
        const RECENCY_WINDOW = 2; // Only last 2 turns
        
        imagesToPass = state.context.imageFileNames.filter(imgName => {
          const meta = state.context.imageMetadata.get(imgName);
          if (!meta) return false;
          
          // Always include user attachments
          if (meta.isUserAttachment) return true;
          
          // Include images from recent turns only
          const age = currentTurn - meta.addedAtTurn;
          return age <= RECENCY_WINDOW;
        });
        
        console.log(
          `[JAF Provider] Turn ${currentTurn}: Passing ${imagesToPass.length}/${state.context.imageFileNames.length} images ` +
          `(${state.context.imageFileNames.filter(i => state.context.imageMetadata.get(i)?.isUserAttachment).length} attachments, ` +
          `${imagesToPass.length - state.context.imageFileNames.filter(i => state.context.imageMetadata.get(i)?.isUserAttachment).length} recent)`
        );
      }

      const callOptions: LanguageModelV2CallOptions = {
        prompt,
        maxOutputTokens: agent.modelConfig?.maxTokens,
        temperature: agent.modelConfig?.temperature,
        ...(tools.length ? { tools } : {}),
        // NEW: Pass selected images to the underlying provider
        ...(imagesToPass.length > 0 ? { imageFileNames: imagesToPass } : {}),
      };

      // ... rest of existing code
    }
  };
};
```

**Key Points**:
- Recency window of 2 turns balances relevance and completeness
- User attachments always included (high priority)
- Logs image selection for debugging
- No changes needed to underlying provider (already supports imageFileNames)

### Phase 6: Update Turn Counter

**File**: `server/api/chat/message-agents.ts`

**Location**: In the JAF event loop (around line 1300)

**Changes**:
```typescript
for await (const evt of runStream<AgentRunContext, string>(runState, runCfg, ...)) {
  switch (evt.type) {
    case "turn_start": {
      // NEW: Increment turn counter
      runState.context.turnCount = evt.data.turn;
      
      currentTurn = evt.data.turn;
      // ... existing logging ...
      break;
    }
    
    // ... other cases ...
  }
}
```

### Phase 7: Pass Images to Underlying Provider

**File**: `server/ai/provider/vertex_ai.ts` (and other providers)

**Note**: Most providers already support `imageFileNames` parameter. Verify implementation:

```typescript
// Existing code in vertex_ai.ts (around line 200)
export async function conversewithBedrockAndVertexV2(params: ModelParams) {
  // ... existing code ...
  
  const { imageFileNames } = params; // Already extracted
  
  if (imageFileNames && imageFileNames.length > 0) {
    // Existing logic to load and encode images
    const images = await Promise.all(
      imageFileNames.map(fileName => loadImageFromDisk(fileName))
    );
    // ... add images to request ...
  }
}
```

**Action**: No changes needed - providers already handle this.

## Testing Plan

### Unit Tests

1. **Image Metadata Tracking**
   - Verify imageFileNames array updates correctly
   - Verify imageMetadata map tracks all required fields
   - Test deduplication logic

2. **Recency Filtering**
   - Mock context with images from turns 0, 1, 2, 3, 4
   - Set currentTurn = 4
   - Verify only turn 3, 4 + user attachments are selected

3. **Provider Integration**
   - Mock AgentRunContext with mixed images
   - Verify correct subset passed to underlying provider

### Integration Tests

1. **User Attachment Only**
   - Send query with 2 image attachments
   - Verify both images passed to LLM in all turns

2. **Search Results Only**
   - Send query that triggers searchGlobal
   - Verify images from search results extracted
   - Verify only recent images passed in subsequent turns

3. **Mixed Context**
   - Send query with 1 attachment + search that returns documents with images
   - Verify attachment always included
   - Verify search images subject to recency filter

4. **Multi-Turn Conversation**
   - Turn 1: Search returns 3 images
   - Turn 2: Different search returns 2 new images  
   - Turn 3: Verify only Turn 2's images + attachments passed (not Turn 1)

### Manual Testing Scenarios

1. **Citation Accuracy**
   - Upload PDF with images
   - Ask: "What does the chart on page 3 show?"
   - Verify image is passed and answer cites it correctly

2. **Recency Filter Effectiveness**
   - Ask complex query requiring 4+ tool calls
   - Verify final answer doesn't hallucinate about images from early turns

3. **Cost Efficiency**
   - Monitor token usage with/without recency filter
   - Verify significant reduction in image tokens for multi-turn conversations

## Rollout Plan

### Stage 1: Feature Flag (Week 1)
- Add `ENABLE_IMAGE_CONTEXT_TRACKING` env var
- Deploy to dev environment
- Test with synthetic data

### Stage 2: Canary (Week 2)
- Enable for 5% of traffic
- Monitor error rates, response quality
- A/B test: with/without feature

### Stage 3: Gradual Rollout (Week 3-4)
- Increase to 25%, 50%, 75%, 100%
- Monitor metrics at each stage
- Rollback if issues detected

### Stage 4: Cleanup (Week 5)
- Remove feature flag
- Update documentation
- Share learnings with team

## Success Metrics

### Correctness
- **Image Citation Accuracy**: % of responses that correctly cite images
- **Target**: 95%+ (currently ~70% due to missing images)

### Efficiency  
- **Token Reduction**: Average tokens saved per multi-turn conversation
- **Target**: 20-30% reduction in image tokens

### Performance
- **Latency Impact**: Additional ms per request
- **Target**: <50ms overhead for metadata tracking

### User Experience
- **Image-Related Query Success Rate**: % of queries about images answered correctly
- **Target**: Increase from 70% to 90%

## Rollback Plan

If issues arise:

1. **Immediate**: Set `ENABLE_IMAGE_CONTEXT_TRACKING=false`
2. **Investigation**: Review logs for error patterns
3. **Fix**: Address root cause in isolated branch
4. **Re-deploy**: Test fix thoroughly before re-enabling

## Future Enhancements

### Short-term (Next Quarter)
1. **Adaptive Recency Window**: Adjust based on conversation length
2. **Relevance Scoring**: Use embedding similarity instead of just recency
3. **Image Compression**: Reduce image sizes before passing to LLM

### Long-term (6+ months)
1. **Image Caching**: Cache frequently-accessed images in memory
2. **Lazy Loading**: Only load images when LLM is likely to cite them
3. **Multi-modal Embeddings**: Generate and search image embeddings

## References

- Original discussion: See conversation history above
- Related code: `server/api/chat/agents.ts` (MessageWithToolsApi)
- JAF documentation: `../projects/jaf/docs/JAFunderstanding1.md`
- Image utilities: `server/api/chat/utils.ts` (extractImageFileNames)

## Appendix A: Key Code Locations

| Component | File | Line Range |
|-----------|------|------------|
| AgentRunContext | agent-schemas.ts | 70-110 |
| JAF Provider | jaf-provider.ts | 30-150 |
| Image Extraction | utils.ts | 800-850 |
| Tool Execution Hook | message-agents.ts | 1180-1250 |
| JAF Event Loop | message-agents.ts | 1280-1450 |

## Appendix B: Configuration Options

```typescript
// server/config.ts
export const IMAGE_CONTEXT_CONFIG = {
  // Enable/disable feature
  enabled: process.env.ENABLE_IMAGE_CONTEXT_TRACKING === 'true',
  
  // Recency window (turns)
  recencyWindow: parseInt(process.env.IMAGE_RECENCY_WINDOW || '2'),
  
  // Maximum images per LLM call
  maxImagesPerCall: parseInt(process.env.MAX_IMAGES_PER_CALL || '10'),
  
  // Always include user attachments
  alwaysIncludeAttachments: true,
};
```

---

**Prepared by**: AI Assistant  
**Reviewed by**: [To be filled]  
**Approved by**: [To be filled]  
**Last Updated**: November 13, 2025
