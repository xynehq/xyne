/**
    * toDoWrite tool - pi-mono version
    * 
    * Creates or updates an execution plan with sequential tasks
    */

   import { Type } from "@sinclair/typebox"
   import { createXyneTool } from "../adapter"
   import type { XyneToolContext } from "../adapter"

   const subTaskSchema = Type.Object({
     id: Type.String({ description: "Unique task identifier" }),
     description: Type.String({ description: "Task description" }),
     status: Type.Union([
       Type.Literal("pending"),
       Type.Literal("in_progress"),
       Type.Literal("completed"),
       Type.Literal("failed"),
       Type.Literal("blocked"),
     ], { description: "Task status" }),
     toolsRequired: Type.Optional(Type.Array(Type.String(), {
       description: "Tools needed for this task",
     })),
     result: Type.Optional(Type.String({
       description: "Task result/summary when completed",
     })),
     completedAt: Type.Optional(Type.Number({
       description: "Timestamp when task was completed",
     })),
     error: Type.Optional(Type.String({
       description: "Error message if task failed",
     })),
   })

   const toDoWriteParams = Type.Object({
     goal: Type.String({
       description: "The overarching goal to accomplish",
       minLength: 1,
     }),
     subTasks: Type.Array(subTaskSchema, {
       description: "Sequential tasks, each representing one sub-goal",
       minItems: 1,
     }),
   })

   export const toDoWriteTool = createXyneTool(
     "toDoWrite",
     "Create or update an execution plan with sequential tasks. MUST be called first before any other tool.",
     toDoWriteParams,
     async (toolCallId, params, signal, onUpdate, ctx: XyneToolContext) => {
       const { xyneState, persistState } = ctx
       
       try {
         // Update the plan in state
         xyneState.plan = {
           goal: params.goal,
           subTasks: params.subTasks.map((task) => ({
             ...task,
             toolsRequired: task.toolsRequired || [],
           })),
         }
         
         // Track that toDoWrite was called this turn
         xyneState.currentTurnArtifacts.todoWriteCalled = true
         
         // Find the first non-completed task to set as current
         const firstPendingTask = params.subTasks.find(
           (t) => t.status === "pending" || t.status === "in_progress"
         )
         
         if (firstPendingTask) {
           xyneState.currentSubTask = firstPendingTask.id
         }
         
         await persistState()
         
         return {
           content: [{ 
             type: "text", 
             text: `Plan created with ${params.subTasks.length} tasks for goal: ${params.goal}` 
           }],
           details: { 
             plan: xyneState.plan,
             currentSubTask: xyneState.currentSubTask,
             toolName: "toDoWrite",
           }
         }
       } catch (error) {
         const errMsg = error instanceof Error ? error.message : String(error)
         return {
           content: [{ type: "text", text: `Failed to create plan: ${errMsg}` }],
           isError: true,
           details: { toolName: "toDoWrite", error: errMsg }
         }
       }
     }
   )