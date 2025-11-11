# JAF Agentic Architecture: Implementation Task Breakdown

## Overview

This document provides a detailed, step-by-step breakdown of implementing the JAF-based agentic architecture for Xyne. Each sub-goal is designed to be completed independently, with clear success criteria and dependencies.

**Implementation Strategy**: Incremental, test-driven development with each sub-goal building upon the previous one.

---

## Sub-Goal 1: Foundation - Type Definitions & Schemas

**Objective**: Establish the foundational TypeScript interfaces and types that will be used throughout the system.

**Priority**: Critical (Blocks all other work)

**Estimated Time**: 2-3 days

### Tasks

#### Task 1.1: Create Core Context Types
- [ ] Create `server/api/chat/agentic/types/context.ts`
- [ ] Define `AgentRunContext` interface
- [ ] Define `PlanState` interface
- [ ] Define `SubTask` interface
- [ ] Define `Clarification` interface
- [ ] Define `Decision` interface
- [ ] Add JSDoc documentation for all interfaces

**Success Criteria**:
- All types compile without errors
- Types are exported and can be imported
- JSDoc documentation is complete

#### Task 1.2: Create Tool Execution Types
- [ ] Create `server/api/chat/agentic/types/tools.ts`
- [ ] Define `ToolExecutionRecord` interface
- [ ] Define `ToolFailureInfo` interface
- [ ] Define `ToolMetadata` interface
- [ ] Add validation schemas using Zod

**Success Criteria**:
- Types compile successfully
- Zod schemas validate correctly
- Unit tests for schema validation pass

#### Task 1.3: Create Review & Quality Types
- [ ] Create `server/api/chat/agentic/types/review.ts`
- [ ] Define `ReviewResult` interface
- [ ] Define `ReviewAction` interface
- [ ] Define `AutoReviewInput` interface
- [ ] Define quality score types (0-1 range)

**Success Criteria**:
- All review-related types are defined
- Type constraints are properly enforced (e.g., scores between 0-1)

#### Task 1.4: Create Agent Capability Types
- [ ] Create `server/api/chat/agentic/types/agents.ts`
- [ ] Define `AgentCapability` interface
- [ ] Define `ListCustomAgentsInput` interface
- [ ] Define `RunPublicAgentInput` interface

**Success Criteria**:
- Agent-related types are complete
- Types match the schema definitions in the plan

#### Task 1.5: Export All Types
- [ ] Create `server/api/chat/agentic/types/index.ts`
- [ ] Export all type definitions
- [ ] Add barrel exports for easy importing
- [ ] Verify no circular dependencies

**Success Criteria**:
- Single import point for all types
- No build errors related to circular dependencies

---

## Sub-Goal 2: Tool Descriptions Registry

**Objective**: Create a centralized registry for tool descriptions and metadata.

**Priority**: High (Needed for prompt construction)

**Estimated Time**: 2 days

**Dependencies**: Sub-Goal 1 (Type definitions)

### Tasks

#### Task 2.1: Create Tool Descriptions File
- [ ] Create `server/api/chat/agentic/tool-descriptions.md`
- [ ] Document search_gmail tool with parameters and examples
- [ ] Document search_slack tool with parameters and examples
- [ ] Document search_drive tool with parameters and examples
- [ ] Document list_custom_agents tool
- [ ] Document run_public_agent tool with prerequisites
- [ ] Document toDoWrite (JAF built-in) usage guidelines

**Success Criteria**:
- Markdown file is well-structured
- Each tool has: Purpose, Parameters, Examples, Parallelizability info
- Clear usage guidelines for when to use each tool

#### Task 2.2: Create Registry Parser
- [ ] Create `server/api/chat/agentic/utils/registry-parser.ts`
- [ ] Implement function to parse markdown sections
- [ ] Implement function to extract tool metadata
- [ ] Implement function to filter tools by name
- [ ] Add caching for parsed registry

**Success Criteria**:
- Parser correctly extracts tool sections from markdown
- Filtering works for enabled tools set
- Unit tests for parser pass

#### Task 2.3: Create Registry Loader
- [ ] Create `server/api/chat/agentic/utils/load-tool-descriptions.ts`
- [ ] Implement `loadToolDescriptionsFromRegistry()` function
- [ ] Add error handling for missing registry file
- [ ] Add validation for tool section format
- [ ] Implement caching mechanism

**Success Criteria**:
- Function loads and filters tool descriptions correctly
- Graceful error handling
- Cache reduces file system reads
- Integration tests pass

---

## Sub-Goal 3: Context Management System

**Objective**: Implement the AgentRunContext initialization, updates, and lifecycle management.

**Priority**: High (Core infrastructure)

**Estimated Time**: 3-4 days

**Dependencies**: Sub-Goal 1 (Type definitions)

### Tasks

#### Task 3.1: Create Context Initializer
- [ ] Create `server/api/chat/agentic/context/initializer.ts`
- [ ] Implement `initializeAgentRunContext()` function
- [ ] Extract user, workspace, chat metadata
- [ ] Initialize empty collections (toolCallHistory, contextFragments, etc.)
- [ ] Set up default values for metrics and retry counters

**Success Criteria**:
- Context initialized with all required fields
- All collections are properly initialized
- Unit tests verify initialization

#### Task 3.2: Create Context Update Functions
- [ ] Create `server/api/chat/agentic/context/updaters.ts`
- [ ] Implement `updatePlan()` function
- [ ] Implement `addToolExecutionRecord()` function
- [ ] Implement `addContextFragment()` function
- [ ] Implement `updateMetrics()` function
- [ ] Implement `trackFailedTool()` function

**Success Criteria**:
- Update functions are pure (immutable updates)
- Proper type safety
- Unit tests for each updater

#### Task 3.3: Create Context State Manager
- [ ] Create `server/api/chat/agentic/context/manager.ts`
- [ ] Implement state getters (getCurrentPlan, getToolHistory, etc.)
- [ ] Implement state queries (hasFailedToolExceededLimit, etc.)
- [ ] Implement helper methods (isAmbiguityResolved, etc.)

**Success Criteria**:
- State management is centralized
- All queries return correct values
- Unit tests pass

#### Task 3.4: Create Context Persistence
- [ ] Add plan state to chat trace JSON
- [ ] Add tool execution history to trace
- [ ] Add review summaries to trace
- [ ] Implement context serialization for debugging

**Success Criteria**:
- Context can be serialized and deserialized
- Trace JSON includes all relevant state
- Database updates work correctly

---

## Sub-Goal 4: Dynamic Prompt Builder

**Objective**: Build the system prompt dynamically based on context state.

**Priority**: High (Required for agent execution)

**Estimated Time**: 2-3 days

**Dependencies**: Sub-Goal 1, Sub-Goal 2, Sub-Goal 3

### Tasks

#### Task 4.1: Create Base Prompt Template
- [ ] Create `server/api/chat/agentic/prompts/base-template.ts`
- [ ] Define base system prompt with core instructions
- [ ] Add planning guidelines section
- [ ] Add execution strategy section
- [ ] Add quality guidelines section
- [ ] Add adaptation guidelines section

**Success Criteria**:
- Base template is comprehensive
- Follows the structure from the unified plan
- Clear and actionable instructions

#### Task 4.2: Implement Plan Serializer
- [ ] Create `server/api/chat/agentic/prompts/plan-serializer.ts`
- [ ] Implement `serializePlan()` function
- [ ] Format subtasks with status indicators (✓, →, ✗, ○)
- [ ] Include dependencies and tool requirements
- [ ] Add completion timestamps where applicable

**Success Criteria**:
- Plan serialization is human-readable
- Status indicators are clear
- Unit tests verify correct formatting

#### Task 4.3: Implement Context Section Builder
- [ ] Create `server/api/chat/agentic/prompts/context-builder.ts`
- [ ] Implement `buildContextSection()` function
- [ ] Include user email, workspace ID, current date
- [ ] Format context for clarity

**Success Criteria**:
- Context section is properly formatted
- All required information is included

#### Task 4.4: Implement Main Prompt Builder
- [ ] Create `server/api/chat/agentic/prompts/builder.ts`
- [ ] Implement `buildAgentInstructions()` function
- [ ] Combine base template + context + plan + tools
- [ ] Handle case when no plan exists yet
- [ ] Load tool descriptions from registry

**Success Criteria**:
- Complete prompt is generated correctly
- All sections are properly combined
- Integration tests pass
- Prompt is validated for length and format

---

## Sub-Goal 5: JAF Hook Implementation - onBeforeToolExecution

**Objective**: Implement the before-execution hook for duplicate detection and failure tracking.

**Priority**: Critical (Core execution logic)

**Estimated Time**: 3 days

**Dependencies**: Sub-Goal 1, Sub-Goal 3

### Tasks

#### Task 5.1: Create Duplicate Detection Logic
- [ ] Create `server/api/chat/agentic/hooks/duplicate-detector.ts`
- [ ] Implement `isDuplicateToolCall()` function
- [ ] Compare tool name and arguments
- [ ] Check recency (within 60 seconds)
- [ ] Check success status of previous call

**Success Criteria**:
- Duplicate calls are correctly identified
- Time window check works properly
- Unit tests cover edge cases

#### Task 5.2: Create Failure Budget Checker
- [ ] Create `server/api/chat/agentic/hooks/failure-checker.ts`
- [ ] Implement `hasExceededFailureLimit()` function
- [ ] Check if tool has failed 3+ times
- [ ] Return failure information

**Success Criteria**:
- Failure limits are enforced
- Failure count tracking is accurate
- Unit tests pass

#### Task 5.3: Create ExcludedIds Handler
- [ ] Create `server/api/chat/agentic/hooks/excluded-ids.ts`
- [ ] Implement `addExcludedIds()` function
- [ ] Merge seenDocuments with existing excludedIds
- [ ] Preserve other arguments

**Success Criteria**:
- ExcludedIds are properly merged
- No duplicate IDs in the list
- Arguments object is not mutated

#### Task 5.4: Implement onBeforeToolExecution Hook
- [ ] Create `server/api/chat/agentic/hooks/before-execution.ts`
- [ ] Integrate duplicate detection
- [ ] Integrate failure budget check
- [ ] Integrate excludedIds handling
- [ ] Emit SSE events for skipped tools
- [ ] Return null for blocked tools, modified args otherwise

**Success Criteria**:
- Hook prevents duplicate calls
- Hook blocks failing tools after 3 attempts
- ExcludedIds are properly added
- SSE events are emitted
- Integration tests pass

---

## Sub-Goal 6: JAF Hook Implementation - onAfterToolExecution

**Objective**: Implement the after-execution hook for telemetry, context filtering, and state updates.

**Priority**: Critical (Core execution logic)

**Estimated Time**: 4-5 days

**Dependencies**: Sub-Goal 1, Sub-Goal 3, Sub-Goal 5

### Tasks

#### Task 6.1: Create Tool Execution Record Builder
- [ ] Create `server/api/chat/agentic/hooks/record-builder.ts`
- [ ] Implement `buildToolExecutionRecord()` function
- [ ] Extract all metadata from result
- [ ] Calculate duration
- [ ] Format error information
- [ ] Truncate result summary to 200 chars

**Success Criteria**:
- Record contains all required fields
- Metadata is properly extracted
- Unit tests verify record structure

#### Task 6.2: Create Context Filter Integration
- [ ] Create `server/api/chat/agentic/hooks/context-filter.ts`
- [ ] Integrate with existing `extractBestDocumentIndexes()`
- [ ] Filter new contexts (not in seenDocuments)
- [ ] Handle filter failures gracefully (fallback: add all)
- [ ] Update seenDocuments set

**Success Criteria**:
- Context filtering reduces noise
- Fallback works when filtering fails
- seenDocuments is properly updated
- Integration tests pass

#### Task 6.3: Create Metrics Tracker
- [ ] Create `server/api/chat/agentic/hooks/metrics-tracker.ts`
- [ ] Implement `updateMetrics()` function
- [ ] Track latency accumulation
- [ ] Track cost accumulation
- [ ] Track token usage

**Success Criteria**:
- Metrics are accurately tracked
- No metric overflows or errors

#### Task 6.4: Create toDoWrite Plan Extractor
- [ ] Create `server/api/chat/agentic/hooks/plan-extractor.ts`
- [ ] Implement `extractPlanFromToDoWrite()` function
- [ ] Parse plan data from tool result
- [ ] Convert to PlanState schema
- [ ] Handle missing or malformed plans

**Success Criteria**:
- Plans are correctly extracted from toDoWrite results
- Schema conversion is accurate
- Graceful error handling

#### Task 6.5: Implement SSE Event Emitter for Metrics
- [ ] Create `server/api/chat/agentic/sse/tool-metrics.ts`
- [ ] Implement `emitToolMetricEvent()` function
- [ ] Include tool name, duration, cost, status
- [ ] Include fragment count

**Success Criteria**:
- SSE events are properly formatted
- Events are emitted at the right time
- Integration with existing SSE system

#### Task 6.6: Implement onAfterToolExecution Hook
- [ ] Create `server/api/chat/agentic/hooks/after-execution.ts`
- [ ] Build tool execution record
- [ ] Add record to context history
- [ ] Update metrics
- [ ] Track failures
- [ ] Extract and filter contexts
- [ ] Handle toDoWrite plan extraction
- [ ] Emit SSE metrics event
- [ ] Return processed result data

**Success Criteria**:
- All steps execute in correct order
- State is properly updated
- SSE events are emitted
- Integration tests pass
- No race conditions

---

## Sub-Goal 7: Automatic Review System

**Objective**: Implement deterministic turn-end review that evaluates execution quality.

**Priority**: Medium (Quality enhancement)

**Estimated Time**: 4-5 days

**Dependencies**: Sub-Goal 1, Sub-Goal 3

### Tasks

#### Task 7.1: Create Review Prompt Builder
- [ ] Create `server/api/chat/agentic/review/prompts.ts`
- [ ] Define review system prompt
- [ ] Include evaluation criteria (completeness, relevance, quality)
- [ ] Define output format (JSON schema)

**Success Criteria**:
- Review prompt is clear and actionable
- Output schema is well-defined

#### Task 7.2: Create Review Executor
- [ ] Create `server/api/chat/agentic/review/executor.ts`
- [ ] Implement `performAutomaticReview()` function
- [ ] Call LLM with review prompt
- [ ] Parse JSON response
- [ ] Validate review output schema
- [ ] Handle LLM errors gracefully

**Success Criteria**:
- Review calls LLM successfully
- JSON parsing is robust
- Fallback for errors

#### Task 7.3: Create Review Analyzer
- [ ] Create `server/api/chat/agentic/review/analyzer.ts`
- [ ] Implement gap detection logic
- [ ] Implement quality scoring
- [ ] Implement completeness assessment
- [ ] Generate suggested actions

**Success Criteria**:
- Analysis is thorough
- Scores are meaningful (0-1 range)
- Suggested actions are actionable

#### Task 7.4: Create Review Trigger Logic
- [ ] Create `server/api/chat/agentic/review/trigger.ts`
- [ ] Implement `shouldTriggerReview()` function
- [ ] Check review frequency setting
- [ ] Check turn number
- [ ] Check if forced review needed

**Success Criteria**:
- Review is triggered at correct times
- Deterministic behavior (always after every turn)

#### Task 7.5: Integrate Review into Execution Loop
- [ ] Update orchestrator to call review after each turn
- [ ] Store review result in context
- [ ] Update plan if review recommends replanning
- [ ] Emit SSE event for review completion

**Success Criteria**:
- Review is automatically called after every turn
- Review results influence next turn
- Integration tests verify review flow

---

## Sub-Goal 8: Custom Agent Tools (list_custom_agents, run_public_agent)

**Objective**: Implement tools for discovering and executing custom agents.

**Priority**: Medium (Feature enhancement)

**Estimated Time**: 3-4 days

**Dependencies**: Sub-Goal 1, Sub-Goal 3

### Tasks

#### Task 8.1: Create Agent Suitability Scorer
- [ ] Create `server/api/chat/agentic/tools/agent-scorer.ts`
- [ ] Implement `calculateAgentSuitability()` function
- [ ] Use LLM to score agent relevance to query
- [ ] Extract domains from agent metadata
- [ ] Estimate cost tier based on agent config

**Success Criteria**:
- Scoring is consistent
- Domain extraction works
- Cost estimation is reasonable

#### Task 8.2: Implement list_custom_agents Tool
- [ ] Create `server/api/chat/agentic/tools/list-custom-agents.ts`
- [ ] Define tool schema with Zod
- [ ] Fetch agents from database
- [ ] Score each agent
- [ ] Filter and sort by suitability
- [ ] Update context.availableAgents
- [ ] Return formatted summary

**Success Criteria**:
- Tool returns relevant agents
- Scoring works correctly
- Context is updated
- Integration tests pass

#### Task 8.3: Implement run_public_agent Tool
- [ ] Create `server/api/chat/agentic/tools/run-public-agent.ts`
- [ ] Define tool schema with Zod
- [ ] Implement ambiguity gate check
- [ ] Execute custom agent
- [ ] Extract contexts from result
- [ ] Track execution metrics
- [ ] Return formatted response

**Success Criteria**:
- Ambiguity check prevents premature execution
- Agent execution works
- Contexts are extracted
- Metrics are tracked

#### Task 8.4: Register Tools with JAF
- [ ] Add tools to JAF tool registry
- [ ] Verify tool schemas
- [ ] Test tool execution
- [ ] Document tool usage in registry

**Success Criteria**:
- Tools are available in JAF runs
- Tools execute correctly
- Documentation is complete

---

## Sub-Goal 9: Main Orchestrator Implementation

**Objective**: Build the main orchestrator that coordinates all phases of execution.

**Priority**: Critical (Main execution flow)

**Estimated Time**: 5-6 days

**Dependencies**: All previous sub-goals

### Tasks

#### Task 9.1: Create Request Initializer
- [ ] Create `server/api/chat/agentic/orchestrator/initialize.ts`
- [ ] Implement `initializeRequest()` function
- [ ] Extract and validate user credentials
- [ ] Resolve chat context
- [ ] Parse message and attachments
- [ ] Initialize AgentRunContext

**Success Criteria**:
- Request is properly validated
- Context is fully initialized
- Error handling is robust

#### Task 9.2: Create JAF Run Executor
- [ ] Create `server/api/chat/agentic/orchestrator/jaf-executor.ts`
- [ ] Implement `executeJAFRun()` function
- [ ] Configure JAF with hooks
- [ ] Set up model provider
- [ ] Execute single turn
- [ ] Return run result

**Success Criteria**:
- JAF runs execute successfully
- Hooks are properly configured
- Results are captured

#### Task 9.3: Create Synthesis Phase
- [ ] Create `server/api/chat/agentic/orchestrator/synthesis.ts`
- [ ] Implement `synthesizeFinalAnswer()` function
- [ ] Use existing synthesis logic
- [ ] Extract citations
- [ ] Format final response
- [ ] Emit SSE events

**Success Criteria**:
- Final answer is well-formatted
- Citations are included
- SSE events are emitted

#### Task 9.4: Create Persistence Layer
- [ ] Create `server/api/chat/agentic/orchestrator/persistence.ts`
- [ ] Implement `persistExecutionState()` function
- [ ] Save message to database
- [ ] Save chat trace with full context
- [ ] Save metrics
- [ ] Handle transaction errors

**Success Criteria**:
- All data is persisted correctly
- Transactions are atomic
- Error recovery works

#### Task 9.5: Create Main Orchestrator
- [ ] Create `server/api/chat/agentic/orchestrator/index.ts`
- [ ] Implement `messageWithToolsOrchestrator()` function
- [ ] Phase 0: Initialize request
- [ ] Phase 1: Execute continuous loop (max 15 turns)
- [ ] Phase 2: Review after each turn
- [ ] Phase 3: Check completion criteria
- [ ] Phase 4: Synthesize final answer
- [ ] Phase 5: Persist state
- [ ] Add comprehensive error handling

**Success Criteria**:
- Full execution flow works end-to-end
- All phases execute in order
- Error handling is comprehensive
- Integration tests pass

---

## Sub-Goal 10: Integration with Existing MessageWithToolsApi

**Objective**: Integrate the new orchestrator with the existing API endpoint.

**Priority**: Critical (Production deployment)

**Estimated Time**: 2-3 days

**Dependencies**: Sub-Goal 9

### Tasks

#### Task 10.1: Create Feature Flag
- [ ] Add `ENABLE_AGENTIC_FLOW` environment variable
- [ ] Update server config
- [ ] Add feature flag check in endpoint

**Success Criteria**:
- Feature flag works correctly
- Defaults to disabled

#### Task 10.2: Create Router Logic
- [ ] Update `server/api/chat/agents.ts`
- [ ] Add conditional routing based on feature flag
- [ ] Route to new orchestrator when enabled
- [ ] Route to legacy flow when disabled
- [ ] Preserve all existing behavior for legacy flow

**Success Criteria**:
- Routing works correctly
- No breaking changes to existing API
- Both flows can run simultaneously

#### Task 10.3: Migrate SSE Event Handling
- [ ] Ensure SSE events from new flow match existing format
- [ ] Test event streaming
- [ ] Verify frontend compatibility

**Success Criteria**:
- SSE events are compatible
- Frontend displays events correctly
- No breaking changes

#### Task 10.4: Migrate Auth and Validation
- [ ] Reuse existing auth logic
- [ ] Reuse workspace validation
- [ ] Reuse model configuration parsing
- [ ] Ensure all security checks are preserved

**Success Criteria**:
- Auth works identically
- No security regressions
- All validations preserved

---

## Sub-Goal 11: Testing & Quality Assurance

**Objective**: Comprehensive testing across all components.

**Priority**: Critical (Quality assurance)

**Estimated Time**: 5-7 days

**Dependencies**: Sub-Goals 1-10

### Tasks

#### Task 11.1: Unit Tests - Type Definitions
- [ ] Test all Zod schemas
- [ ] Test type validation
- [ ] Test edge cases

#### Task 11.2: Unit Tests - Context Management
- [ ] Test context initialization
- [ ] Test all updater functions
- [ ] Test state queries
- [ ] Test immutability

#### Task 11.3: Unit Tests - Hooks
- [ ] Test onBeforeToolExecution
- [ ] Test onAfterToolExecution
- [ ] Test duplicate detection
- [ ] Test failure tracking
- [ ] Test context filtering

#### Task 11.4: Unit Tests - Review System
- [ ] Test review executor
- [ ] Test review analyzer
- [ ] Test review trigger logic

#### Task 11.5: Integration Tests - End-to-End Scenarios
- [ ] Test "Alex Q4" scenario from plan
- [ ] Test multi-source parallel search
- [ ] Test clarification flow
- [ ] Test error recovery
- [ ] Test replanning after review
- [ ] Test custom agent execution

#### Task 11.6: Performance Testing
- [ ] Measure latency for typical queries
- [ ] Measure memory usage
- [ ] Test with high concurrency
- [ ] Profile bottlenecks

#### Task 11.7: Load Testing
- [ ] Test with 10 concurrent users
- [ ] Test with 50 concurrent users
- [ ] Test with 100 concurrent users
- [ ] Monitor resource usage

**Success Criteria**:
- All unit tests pass
- Integration tests cover main scenarios
- Performance meets targets (20-30% improvement)
- Load tests show acceptable resource usage

---

## Sub-Goal 12: Documentation & Developer Experience

**Objective**: Create comprehensive documentation for the new system.

**Priority**: High (Developer enablement)

**Estimated Time**: 3-4 days

**Dependencies**: Sub-Goals 1-11

### Tasks

#### Task 12.1: Create Architecture Documentation
- [ ] Document overall architecture
- [ ] Create flow diagrams
- [ ] Document component interactions
- [ ] Document state management

#### Task 12.2: Create API Documentation
- [ ] Document all public functions
- [ ] Document all hooks
- [ ] Document context structure
- [ ] Add JSDoc comments

#### Task 12.3: Create Developer Guide
- [ ] How to add new tools
- [ ] How to modify prompts
- [ ] How to debug issues
- [ ] How to add new review criteria

#### Task 12.4: Create Runbook
- [ ] Common issues and solutions
- [ ] Debugging techniques
- [ ] Performance tuning guide
- [ ] Monitoring and alerting

**Success Criteria**:
- Documentation is complete and clear
- Developers can onboard quickly
- Common issues are documented

---

## Sub-Goal 13: Gradual Rollout & Monitoring

**Objective**: Deploy the new system gradually with comprehensive monitoring.

**Priority**: Critical (Production safety)

**Estimated Time**: 4-5 days (plus ongoing monitoring)

**Dependencies**: Sub-Goals 1-12

### Tasks

#### Task 13.1: Set Up Monitoring
- [ ] Add metrics for plan creation rate
- [ ] Add metrics for clarification frequency
- [ ] Add metrics for parallel execution usage
- [ ] Add metrics for tool failure recovery
- [ ] Add metrics for latency
- [ ] Add metrics for cost per query
- [ ] Set up dashboards

**Success Criteria**:
- All key metrics are tracked
- Dashboards are accessible
- Alerts are configured

#### Task 13.2: Internal Testing Phase (10% traffic)
- [ ] Enable for internal users only
- [ ] Monitor metrics daily
- [ ] Collect feedback
- [ ] Fix critical bugs
- [ ] Run for 1 week

**Success Criteria**:
- No critical bugs
- Metrics meet targets
- Positive internal feedback

#### Task 13.3: Beta Users Phase (25% traffic)
- [ ] Expand to beta users
- [ ] Monitor metrics closely
- [ ] Collect user feedback
- [ ] Fix identified issues
- [ ] Run for 2 weeks

**Success Criteria**:
- No major issues reported
- Metrics stable or improving
- Positive user feedback

#### Task 13.4: Expanded Rollout (50% traffic)
- [ ] Expand to 50% of users
- [ ] Continue monitoring
- [ ] Address edge cases
- [ ] Optimize performance
- [ ] Run for 2 weeks

**Success Criteria**:
- System performs well at scale
- No degradation in key metrics

#### Task 13.5: Full Rollout (100% traffic)
- [ ] Enable for all users
- [ ] Monitor closely for first week
- [ ] Collect final feedback
- [ ] Document lessons learned

**Success Criteria**:
- Successful migration of all traffic
- Metrics meet or exceed targets
- User satisfaction maintained or improved

#### Task 13.6: Legacy Code Removal
- [ ] Remove feature flag
- [ ] Remove legacy orchestrator code
- [ ] Clean up unused functions
- [ ] Update documentation

**Success Criteria**:
- Codebase is clean
- No dead code remains
- Single execution path

---

## Success Metrics Summary

### Key Performance Indicators

1. **Plan Creation Rate**: 95%+ of queries create execution plans
2. **Parallel Execution**: 60%+ of multi-tool scenarios use parallel execution
3. **Review Coverage**: 100% of turns get automatic review
4. **Latency Improvement**: 20-30% reduction vs current system
5. **Tool Telemetry**: 100% of tool calls tracked with complete metadata
6. **Error Recovery**: 90%+ of failures handled gracefully

### Quality Metrics

1. **Code Coverage**: 80%+ test coverage
2. **Type Safety**: 100% TypeScript strict mode
3. **Documentation**: All public APIs documented
4. **Zero Regressions**: No breaking changes to existing functionality

---

## Risk Mitigation

### Technical Risks

| Risk | Mitigation |
|------|-----------|
| Performance degradation | Incremental rollout with monitoring, performance testing before each phase |
| Breaking existing functionality | Feature flag, comprehensive integration tests, gradual rollout |
| Complex state management bugs | Strong typing, immutability, extensive unit tests |
| Review overhead slowing execution | Make review frequency configurable, optimize review prompts |

### Operational Risks

| Risk | Mitigation |
|------|-----------|
| User confusion during transition | Clear communication, documentation, support readiness |
| Increased costs from LLM calls | Monitor costs closely, optimize prompts, set budget alerts |
| Monitoring gaps | Set up comprehensive metrics before rollout |

---

## Dependencies & Prerequisites

### Before Starting
- [ ] JAF library is fully integrated and working
- [ ] Existing MessageWithToolsApi is stable
- [ ] Test infrastructure is in place
- [ ] CI/CD pipeline is configured

### External Dependencies
- JAF (@xynehq/jaf) - Version X.X.X
- OpenTelemetry for tracing
- Existing database schemas
- Existing SSE infrastructure

---

## Timeline Estimate

**Total Estimated Time**: 8-10 weeks

- **Weeks 1-2**: Sub-Goals 1-4 (Foundation)
- **Weeks 3-4**: Sub-Goals 5-6 (Hooks)
- **Week 5**: Sub-Goal 7 (Review)
- **Week 6**: Sub-Goal 8 (Custom Agents)
- **Weeks 7-8**: Sub-Goal 9 (Orchestrator)
- **Week 9**: Sub-Goals 10-11 (Integration & Testing)
- **Week 10**: Sub-Goals 12-13 (Documentation & Rollout begins)
- **Weeks 11+**: Ongoing monitoring and optimization

---

## Notes

- Each sub-goal should be completed and tested before moving to the next
- Regular code reviews after each sub-goal
- Integration tests should be added incrementally
- Keep the main branch stable - use feature branches
- Document learnings and unexpected challenges as they arise
