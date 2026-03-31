/**
 * toDoWrite tool - pi-mono version
 *
 * Creates or updates an execution plan with sequential tasks.
 * Enhanced for complex query decomposition with dependency tracking and iterative refinement.
 */

import { Type } from "@sinclair/typebox"
import { createXyneTool } from "../adapter"
import type { XyneToolContext } from "../adapter"

// Task type enum for semantic categorization
const taskTypeSchema = Type.Union(
  [
    Type.Literal("understand", { description: "Understand a concept or term" }),
    Type.Literal("identify", {
      description: "Identify specific information or rules",
    }),
    Type.Literal("investigate", {
      description: "Investigate a rule or condition",
    }),
    Type.Literal("analyze", {
      description: "Analyze relationships or patterns",
    }),
    Type.Literal("reconcile", {
      description: "Reconcile apparent contradictions",
    }),
    Type.Literal("synthesize", {
      description: "Synthesize final answer from gathered information",
    }),
    Type.Literal("verify", { description: "Verify completeness or accuracy" }),
  ],
  { description: "Semantic type of the task for query decomposition" },
)

const subTaskSchema = Type.Object({
  id: Type.String({
    description: "Unique task identifier (use task-1, task-2, etc.)",
  }),
  description: Type.String({
    description:
      "Clear, actionable task description. Be specific about what information to gather",
  }),
  type: Type.Optional(taskTypeSchema),
  status: Type.Union(
    [
      Type.Literal("pending"),
      Type.Literal("in_progress"),
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("blocked"),
    ],
    { description: "Task status" },
  ),
  // Dependencies for task ordering
  dependsOn: Type.Optional(
    Type.Array(Type.String(), {
      description: "IDs of tasks that must complete before this task can start",
    }),
  ),
  // Tools required for this task
  toolsRequired: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Tools needed for this task (e.g., searchKnowledgeBase, searchGlobal)",
    }),
  ),
  // Search queries to execute for this task
  searchQueries: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Specific search queries to run for this task. Each query should be 3-4 keywords focused on one aspect",
      maxItems: 3,
    }),
  ),
  // Expected outcome
  expectedOutcome: Type.Optional(
    Type.String({
      description: "What information or result this task should produce",
    }),
  ),
  // Results and metadata
  result: Type.Optional(
    Type.String({
      description: "Task result/summary when completed",
    }),
  ),
  completedAt: Type.Optional(
    Type.Number({
      description: "Timestamp when task was completed",
    }),
  ),
  error: Type.Optional(
    Type.String({
      description: "Error message if task failed",
    }),
  ),
  // Iterative refinement tracking
  iterationCount: Type.Optional(
    Type.Number({
      description: "Number of times this task has been attempted/revised",
    }),
  ),
})

const toDoWriteParams = Type.Object({
  goal: Type.String({
    description:
      "The overarching goal to accomplish. For complex queries, this should capture the user's complete information need.",
    minLength: 1,
  }),
  // Query decomposition context
  userQueryAnalysis: Type.Optional(
    Type.Object({
      mainQuestion: Type.String({
        description: "The core question or information need",
      }),
      subQuestions: Type.Array(Type.String(), {
        description:
          "Breakdown of the query into specific sub-questions that need answers",
      }),
      keyTerms: Type.Array(Type.String(), {
        description:
          "Key terms, concepts, or entities that need definition/clarification",
      }),
      apparentContradictions: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Any apparent contradictions or tensions in the query that need reconciliation",
        }),
      ),
    }),
  ),
  subTasks: Type.Array(subTaskSchema, {
    description:
      "Sequential tasks representing sub-goals. For complex queries: 1) First understand key terms, 2) Then gather specific information, 3) Finally reconcile and synthesize",
    minItems: 1,
  }),
  // Plan metadata
  planMetadata: Type.Optional(
    Type.Object({
      estimatedSteps: Type.Number({
        description: "Estimated number of tool calls needed",
      }),
      canParallelize: Type.Boolean({
        description: "Whether any tasks can run in parallel",
      }),
      refinementStrategy: Type.Optional(
        Type.String({
          description:
            "Strategy for refining the plan if information gaps are found",
        }),
      ),
    }),
  ),
})

export const toDoWriteTool = createXyneTool(
  "toDoWrite",
  `Create or update an execution plan with sequential tasks. MUST be called first before any other tool.

**For complex queries, use this structured approach:**
1. First analyze the user query and populate userQueryAnalysis with:
   - mainQuestion: Core question being asked
   - subQuestions: Break down into 3-6 specific questions
   - keyTerms: List terms that need definition
   - apparentContradictions: Note any tensions in the query

2. Then create subTasks following this pattern:
   - Task 1 (type: "understand"): Define key terms and concepts
   - Tasks 2-N (type: "identify" | "investigate"): Gather specific information
   - Task N+1 (type: "analyze"): Analyze relationships/patterns
   - Task N+2 (type: "reconcile"): Resolve any contradictions
   - Final task (type: "synthesize"): Compose the final answer

3. Use searchQueries on each task with 3-4 keyword-focused queries
4. Set dependencies so tasks flow logically
5. Update the plan iteratively as you discover information gaps`,
  toDoWriteParams,
  async (toolCallId, params, signal, onUpdate, ctx: XyneToolContext) => {
    const { xyneState, persistState } = ctx
    console.log("toDoWrite called with params:", params)
    try {
      // Validate dependencies
      const taskIds = new Set(params.subTasks.map((t) => t.id))
      for (const task of params.subTasks) {
        if (task.dependsOn) {
          for (const depId of task.dependsOn) {
            if (!taskIds.has(depId)) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Invalid dependency: task "${task.id}" depends on unknown task "${depId}"`,
                  },
                ],
                isError: true,
                details: {
                  toolName: "toDoWrite",
                  error: `Unknown dependency: ${depId}`,
                },
              }
            }
          }
        }
      }

      // Update the plan in state with full metadata
      xyneState.plan = {
        goal: params.goal,
        userQueryAnalysis: params.userQueryAnalysis,
        subTasks: params.subTasks.map((task) => ({
          ...task,
          toolsRequired: task.toolsRequired || [],
          dependsOn: task.dependsOn || [],
          searchQueries: task.searchQueries || [],
          iterationCount: task.iterationCount || 0,
        })),
        planMetadata: params.planMetadata,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      // Track that toDoWrite was called this turn
      xyneState.currentTurnArtifacts.todoWriteCalled = true

      // Find the first non-completed task that has no unmet dependencies
      const firstPendingTask = params.subTasks.find((t) => {
        if (t.status !== "pending" && t.status !== "in_progress") return false
        // Check if all dependencies are completed
        if (t.dependsOn && t.dependsOn.length > 0) {
          return t.dependsOn.every((depId) => {
            const depTask = params.subTasks.find((st) => st.id === depId)
            return depTask?.status === "completed"
          })
        }
        return true
      })

      if (firstPendingTask) {
        xyneState.currentSubTask = firstPendingTask.id
      }

      await persistState()

      // Build summary
      const taskTypes = params.subTasks.reduce(
        (acc, t) => {
          const type = t.type || "unknown"
          acc[type] = (acc[type] || 0) + 1
          return acc
        },
        {} as Record<string, number>,
      )

      const typeSummary = Object.entries(taskTypes)
        .map(([type, count]) => `${count} ${type}`)
        .join(", ")

      return {
        content: [
          {
            type: "text",
            text: `Plan created: ${params.subTasks.length} tasks (${typeSummary}) for goal: ${params.goal}`,
          },
        ],
        details: {
          plan: xyneState.plan,
          currentSubTask: xyneState.currentSubTask,
          taskTypes,
          toolName: "toDoWrite",
        },
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: "text", text: `Failed to create plan: ${errMsg}` }],
        isError: true,
        details: { toolName: "toDoWrite", error: errMsg },
      }
    }
  },
)
