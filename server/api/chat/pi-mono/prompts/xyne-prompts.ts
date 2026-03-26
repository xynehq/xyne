import type { XyneAgentState } from "../adapter"
import { buildAgentPromptAddendum } from "@/api/chat/agentPromptCreation"

export interface XynePromptConfig {
  state: XyneAgentState
  toolNames: string[]
  dateForAI: string
  delegationEnabled?: boolean
  workingMemoryMessages?: number
}

export function buildXynePromptSections(
  config: XynePromptConfig,
): PromptSection[] {
  const {
    state,
    toolNames,
    dateForAI,
    delegationEnabled = true,
    workingMemoryMessages = 6,
  } = config
  const sections: PromptSection[] = []

  // Identity section
  sections.push({
    name: "identity",
    priority: 0,
    content:
      "You are Xyne, an enterprise search assistant with agentic capabilities.",
  })

  // Date context
  sections.push({
    name: "date",
    priority: 1,
    content: `The current date is: ${dateForAI}`,
  })

  // User context section
  const conversationContext = `You are given only the last ${workingMemoryMessages} messages of this chat in context. Use \`searchChatHistory\` when you need to recall or search older messages.`
  sections.push({
    name: "context",
    priority: 5,
    content: [
      "<context>",
      `User: ${state.user.email}`,
      `Workspace: ${state.user.workspaceId}`,
      conversationContext,
      "</context>",
    ].join("\n"),
  })

  // Tools section
  const toolDescriptions =
    toolNames.length > 0
      ? "You have access to the following tools:\n" +
        toolNames.map((t) => `- ${t}`).join("\n") +
        "\ntool schemas are provided to you."
      : "No tools available yet."
  sections.push({
    name: "tools",
    priority: 10,
    content: `<available_tools>\n${toolDescriptions}\n</available_tools>`,
  })

  // Cooldown block (simplified for now)
  const cooldownBlock = buildCooldownBlock(state)
  if (cooldownBlock) {
    sections.push({
      name: "cooldown",
      priority: 12,
      content: cooldownBlock,
    })
  }

  // Agent constraints
  if (state.agentPrompt) {
    sections.push({
      name: "agent-constraints",
      priority: 15,
      content: `Agent Constraints:\n${state.agentPrompt}`,
    })
  }

  // Workspace context
  if (state.userContext) {
    sections.push({
      name: "workspace-context",
      priority: 20,
      content: `Workspace Context:\n${state.userContext}`,
    })
  }

  // Dedicated agent system prompt
  if (state.dedicatedAgentSystemPrompt) {
    sections.push({
      name: "agent-prompt",
      priority: 25,
      content: `Agent System Prompt:\n${state.dedicatedAgentSystemPrompt}`,
    })
  }

  // Plan section
  const planContent = state.plan
    ? `Goal: ${state.plan.goal || "Execute Plan"}\n\nSteps:\n${
        state.plan.subTasks
          ?.map((task: any, i: number) => {
            const status =
              task.status === "completed"
                ? "✓"
                : task.status === "in_progress"
                  ? "→"
                  : task.status === "failed"
                    ? "✗"
                    : "○"
            return `${i + 1}. [${status}] ${task.description}`
          })
          .join("\n") || ""
      }`
    : "No plan exists yet. Use todo_write to create one."

  sections.push({
    name: "plan",
    priority: 30,
    content: `<plan>\n${planContent}\n</plan>`,
  })

  // Attachment directive
  if (state.message.attachments?.length > 0) {
    sections.push({
      name: "attachment-directive",
      priority: 35,
      content: buildAttachmentDirective(),
    })
  }

  // Prompt addendum from agentPromptCreation
  const promptAddendum = buildAgentPromptAddendum()
  sections.push({
    name: "prompt-addendum",
    priority: 38,
    content: promptAddendum,
  })

  // Review result block (before instructions so it can be referenced)
  if (state.review?.lastReviewResult) {
    sections.push({
      name: "review-result",
      priority: 42,
      content: [
        "<last_review_result>",
        JSON.stringify(state.review.lastReviewResult, null, 2),
        "</last_review_result>",
      ].join("\n"),
    })
  }

  // Main instructions
  sections.push({
    name: "instructions",
    priority: 45,
    content: buildInstructions(delegationEnabled, toolNames),
  })

  // Review feedback (after instructions)
  if (state.review?.lastReviewResult) {
    sections.push({
      name: "review-feedback",
      priority: 48,
      content: buildReviewFeedbackInstructions(),
    })
  }

  return sections
}

function buildCooldownBlock(state: XyneAgentState): string {
  if (!state.toolCallHistory || state.toolCallHistory.length === 0) {
    return ""
  }
  // Simplified cooldown representation
  // In a full implementation, this would show tools in cooldown
  return ""
}

function buildAttachmentDirective(): string {
  return [
    "# ATTACHMENT-FIRST TURN",
    "User provided attachment context for this opening turn.",
    "",
    "Attachment handling:",
    "1. Inspect the attachment fragments below.",
    "2. If the attachments fully answer the user's request → respond using citations (see format below).",
    "3. If the attachments are partial or incomplete → create a plan with todo_write and run the tools needed to fill the gaps in the same turn.",
    "4. State that information is unavailable only after the attachments and available tools have been used and the answer still cannot be found.",
    "",
    "# Response and citations",
    "- Use the provided files and chunks as your knowledge base. Each document has a header like `index {citationDocId: N}` and content chunks marked with [0], [1], [2], etc.",
    '- Cite every factual statement using the format K[citationDocId_chunkIndex] where citationDocId is the number from the header and chunkIndex is the bracketed index in the content. Example: "X is true K[3_12]." Use at most 1-2 citations per sentence; for two chunks use two citations: "... K[3_12] ... K[1_0]."',
    "- Place the citation immediately after the claim. Only cite information that appears in or is directly inferable from the cited chunk; if you cannot ground a claim, omit it.",
    "- Keep tone professional and concise; note inconsistencies across chunks when relevant and acknowledge gaps when the chunks lack detail.",
  ].join("\n")
}

function buildInstructions(
  delegationEnabled: boolean,
  toolNames: string[],
): string {
  const hasDelegationTools =
    toolNames.includes("listCustomAgents") &&
    toolNames.includes("runPublicAgent")

  const delegationGuidance = delegationEnabled
    ? `- Before calling ANY search, calendar, Gmail, Drive, or other research tools, you MUST invoke \`listCustomAgents\` once per run. Treat the workflow as: plan -> list agents -> (maybe) runPublicAgent -> other tools. If the selector returns \`null\`, explicitly log that no agent was suitable, then proceed with core tools.
- Before calling \`runPublicAgent\`, invoke \`listCustomAgents\`, compare every candidate, and respect a \`null\` result as "no delegate—continue with built-in tools."
- Use \`runPublicAgent\` immediately after choosing an agent from \`listCustomAgents\`; pass the specific agentId plus a rewritten query tailored to that agent.`
    : ""

  const lines: string[] = [
    "# PLANNING",
    "- Call todo_write at the start of a turn when the plan is new, when review requested changes, or when you need to add or close tasks; otherwise you may proceed without calling todo_write to avoid unnecessary iterations.",
    "- Terminate the active plan the moment you have enough evidence to cater to the complete requirement of the user; immediately drop any remaining subtasks when the goal is satisfied.",
    "- Scale the number of subtasks to the query's true complexity, however quality of the final answer and complete execution and satisfaction of user's query outranks task count, you must always prioritize quality",
    "- Maintain one sub-task per concrete goal; list only the tools truly needed for that sub-task.",
    '- Only chain subtasks when real dependencies exist—for example, "fetch the people who messaged me today → gather the emails received from them → summarize the combined thread" keeps later steps paused until earlier outputs arrive.',
    "- After every tool run, immediately update the active sub-task's status, result, and any newly required tasks so the plan mirrors reality.",
    "- Never finish a turn after only calling todo_write—run at least one execution tool that advances the active task.",
    "# EXECUTION STRATEGY",
    "- Work tasks sequentially; complete the current task before starting the next.",
    "- Call tools with precise parameters tied to the sub-task goal; reuse stored fragments instead of re-fetching data.",
  ]

  if (delegationEnabled && hasDelegationTools) {
    lines.push(
      "- When delegation is enabled and justified, run listCustomAgents before runPublicAgent; document why the selected agent accelerates the plan.",
      "- Prefer listCustomAgents → runPublicAgent before core tools when delegation is enabled and justified by the plan.",
      "- Invoke listCustomAgents at the sub-task level whenever targeted delegation could unlock better results; multi-part queries may require multiple calls as the context evolves.",
      "- Let earlier tool outputs reshape later sub-tasks (e.g., if getSlackRelatedMessages returns only Finance senders, rewrite the next listCustomAgents query with that Finance focus before proceeding).",
    )
  }

  lines.push(
    "- Obey the `recommendation` flag: pause for clarifications when it reads `clarify_query`, keep collecting data for `gather_more`, and do not progress until a fresh plan is in place for `replan`.",
    "- If anomalies or notes in the latest review call out missing evidence, misalignments, or unresolved questions, fix those items before progressing and explain the remediation in the plan.",
    "",
    "# TOOL CALLS & EXPECTATIONS",
    "- Use the model's native function/tool-call interface. Provide clean JSON arguments.",
    "- Do NOT wrap tool calls in custom XML.",
    delegationGuidance,
    "- After you decide which tools to call, emit a standalone expected-results block summarizing what each tool should achieve:",
    "<expected_results>",
    "[",
    "  {",
    '    "toolName": "searchGlobal",',
    '    "goal": "Find Q4 ARR mentions",',
    '    "successCriteria": ["ARR keyword present", "Dated Q4"],',
    '    "failureSignals": ["No ARR context"],',
    '    "stopCondition": "After 2 unsuccessful searches"',
    "  }",
    "]",
    "</expected_results>",
    "- Include one entry per tool invocation you intend to make. These expectations feed automatic review, so keep them specific and measurable.",
    "",
    "# CONSTRAINT HANDLING",
    "- When the user requests an action the available tools cannot execute, produce the closest actionable substitute (draft, checklist, instructions) so progress continues.",
    "- State the exact limitation and what manual follow-up the user must perform to finish.",
    "",
    "# FINAL SYNTHESIS",
    "- When research is complete and evidence is locked, CALL `synthesizeFinalAnswer` tool.",
    "- NEVER output the final answer directly in text—always go through the tool to initiate the final output stream.",
    "- If you do not call the tool, the user will not see your answer.",
  )

  // Filter out empty strings from conditional delegationGuidance
  return lines.filter(Boolean).join("\n")
}

function buildReviewFeedbackInstructions(): string {
  return [
    "# REVIEW FEEDBACK",
    "- Inspect the <last_review_result> block above; treat every instruction, anomaly, and clarification inside it as mandatory.",
    '- Example: if the review notes "Tool X lacked evidence," reopen that sub-task, add a step to fetch the missing evidence, and mark status accordingly before launching tools.',
    "- Log every required fix directly in the plan so auditors can see alignment with the review.",
    '- When the review lists anomalies or ambiguity, capture each as a corrective sub-task (e.g., "Validate source for claim [2]") and close it before moving forward.',
    "- Answer outstanding clarification questions immediately; if the user must respond, surface the exact question back to them.",
  ].join("\n")
}

export interface PromptSection {
  name: string
  content: string
  priority: number
}

export interface PromptBuilderConfig {
  sections: PromptSection[]
  separator?: string
}

export function buildSystemPrompt(config: PromptBuilderConfig): string {
  const separator = config.separator || "\n\n"
  const sorted = [...config.sections].sort((a, b) => a.priority - b.priority)
  return sorted.map((s) => s.content).join(separator)
}

export function buildXyneSystemPrompt(config: XynePromptConfig): string {
  const sections = buildXynePromptSections(config)
  return buildSystemPrompt({ sections })
}
