/**
    * runPublicAgent tool - pi-mono version
    * 
    * Delegates execution to a specific custom agent
    */

   import { Type } from "@sinclair/typebox"
   import { createXyneTool } from "../adapter"
   import type { XyneToolContext } from "../adapter"

   const runPublicAgentParams = Type.Object({
     agentId: Type.String({
       description: "The unique identifier of the agent to run",
       minLength: 1,
     }),
     query: Type.String({
       description: "The task or query to delegate to the agent",
       minLength: 1,
     }),
     context: Type.Optional(Type.String({
       description: "Additional context to pass to the agent",
     })),
   })

   export const runPublicAgentTool = createXyneTool(
     "runPublicAgent",
     "Delegate execution to a specific custom AI agent. Use this after selecting an agent from listCustomAgents to perform specialized tasks.",
     runPublicAgentParams,
     async (toolCallId, params, signal, onUpdate, ctx: XyneToolContext) => {
       const { xyneState, persistState } = ctx
       
       try {
         // Check if agent exists and hasn't been used
         const agent = xyneState.availableAgents.find(
           (a) => a.agentId === params.agentId
         )
         
         if (!agent) {
           return {
             content: [{ type: "text", text: `Agent ${params.agentId} not found or not available.` }],
             isError: true,
             details: { toolName: "runPublicAgent", error: "Agent not found" }
           }
         }
         
         if (xyneState.usedAgents.includes(params.agentId)) {
           return {
             content: [{ type: "text", text: `Agent ${agent.agentName} has already been used in this conversation.` }],
             isError: true,
             details: { toolName: "runPublicAgent", error: "Agent already used" }
           }
         }
         
         // Mark agent as used
         xyneState.usedAgents.push(params.agentId)
         
         // In a full implementation, this would actually invoke the agent
         // For now, we return a placeholder indicating the delegation
         
         await persistState()
         
         return {
           content: [{ 
             type: "text", 
             text: `Delegated to agent ${agent.agentName}: ${params.query}` 
           }],
           details: { 
             agentId: params.agentId,
             agentName: agent.agentName,
             query: params.query,
             context: params.context,
             delegated: true,
             toolName: "runPublicAgent",
           }
         }
       } catch (error) {
         const errMsg = error instanceof Error ? error.message : String(error)
         return {
           content: [{ type: "text", text: `Failed to run agent: ${errMsg}` }],
           isError: true,
           details: { toolName: "runPublicAgent", error: errMsg }
         }
       }
     }
   )