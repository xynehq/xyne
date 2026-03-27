import { buildAgentPromptAddendum } from "../../agentPromptCreation"
import { ToolCooldownManager } from "../../tool-cooldown"
import { generateToolDescriptions } from "../../tool-schemas"
import type { XyneAgentState } from "../adapter"
import config from "@/config"

/**
 * Build attachment directive for attachment-first turns
 */
function buildAttachmentDirective(context: XyneAgentState): string {
  const { initialAttachmentPhase, initialAttachmentSummary } =
    getAttachmentPhaseMetadata(context)
  if (!initialAttachmentPhase) {
    return ""
  }

  const summaryLine =
    initialAttachmentSummary ||
    "User provided attachment context for this opening turn."

  return [
    `# ATTACHMENT-FIRST TURN`,
    summaryLine,
    "",
    "Attachment handling:",
    "1. Inspect the attachment fragments below.",
    "2. If the attachments fully answer the user's request → respond using citations (see format below).",
    "3. If the attachments are partial or incomplete → create a plan with todo_write and run the tools needed to fill the gaps in the same turn.",
    "4. State that information is unavailable only after the attachments and available tools have been used and the answer still cannot be found.",
    "",
    "# Response and citations",
    "- Use the provided files and chunks as your knowledge base. Treat `Index {docId} ...` as the start of a document and [0], [1], [2] as chunk indices within that document.",
    '- Cite every factual statement with the exact chunk: K[docId_chunkIndex] (docId from the file header, chunkIndex from the bracketed number). Example: "X is true K[3_12]." Use at most 1-2 citations per sentence; for two chunks use two citations: "... K[3_12] ... K[1_0]".',
    "- Place the citation immediately after the claim. Only cite information that appears in or is directly inferable from the cited chunk; if you cannot ground a claim, omit it.",
    "- Keep tone professional and concise; note inconsistencies across chunks when relevant and acknowledge gaps when the chunks lack detail.",
  ].join("\n")
}

/**
 * Extract attachment phase metadata from state
 */
function getAttachmentPhaseMetadata(context: XyneAgentState): {
  initialAttachmentPhase?: boolean
  initialAttachmentSummary?: string
} {
  return (
    (context.chat.metadata as {
      initialAttachmentPhase?: boolean
      initialAttachmentSummary?: string
    }) || {}
  )
}
const { defaultBestModel, defaultBestModelAgenticMode, JwtPayloadKey } = config
/**
 * Build system prompt for pi-mono (Exact match of JAF's buildAgentInstructions)
 */
export function buildPiMonoSystemPrompt(
  context: XyneAgentState,
  enabledToolNames: string[],
  dateForAI: string,
  agentPrompt?: string,
  delegationEnabled = true,
): string {
  // Filter tools by enabledTools set (same as buildAgentInstructions)
  const availableToolNames = enabledToolNames.filter((tool) =>
    context.enabledTools.has(tool),
  )

  // Generate tool descriptions using the same pattern as buildAgentInstructions
  const toolDescriptions =
    availableToolNames.length > 0
      ? generateToolDescriptions(availableToolNames)
      : "No tools available yet. "

  // Cooldown Manager
  const cooldownMgr = new ToolCooldownManager(context.failedTools)
  const toolsInCooldown = enabledToolNames
    .filter(
      (t) =>
        !context.enabledTools.has(t) &&
        cooldownMgr.isInCooldown(t, context.turnCount),
    )
    .map((name) => ({ name, info: cooldownMgr.getCooldownInfo(name)! }))
  const cooldownBlock =
    toolsInCooldown.length > 0
      ? [
          "",
          "<tools_in_cooldown>",
          "The following tools are temporarily disabled due to repeated failures. Use other tools or data sources instead.",
          ...toolsInCooldown.map(
            ({ name, info }) =>
              `- ${name}: failed ${info.count}x (last: ${info.lastError || "error"}), ${info.cooldownUntilTurn - context.turnCount} turn(s) remaining.`,
          ),
          "</tools_in_cooldown>",
          "",
        ].join("\n")
      : ""

  const agentSection = agentPrompt
    ? `\n\nAgent Constraints:\n${agentPrompt}`
    : ""
  const attachmentDirective = buildAttachmentDirective(context)
  const promptAddendum = buildAgentPromptAddendum()

  const reviewResultBlock = context.review.lastReviewResult
    ? [
        "<last_review_result>",
        JSON.stringify(context.review.lastReviewResult, null, 2),
        "</last_review_result>",
        "",
      ].join("\n")
    : ""

  // Build plan section (same as buildAgentInstructions)
  let planSection = "\n<plan>\n"
  if (context.plan) {
    planSection += `Goal: ${context.plan.goal}\n\n`
    planSection += "Steps:\n"
    if (Array.isArray(context.plan.subTasks)) {
      context.plan.subTasks.forEach((task: any, i: number) => {
        const status =
          task.status === "completed"
            ? "✓"
            : task.status === "in_progress"
              ? "→"
              : task.status === "failed"
                ? "✗"
                : "○"
        planSection += `${i + 1}. [${status}] ${task.description}\n`
        if (task.toolsRequired && task.toolsRequired.length > 0) {
          planSection += `   Tools: ${task.toolsRequired.join(", ")}\n`
        }
      })
    }
    planSection += "\n</plan>\n"
  } else {
    planSection += "No plan exists yet. Use toDoWrite to create one.\n</plan>\n"
  }

  // Delegation guidance (same wording as buildAgentInstructions)
  const delegationGuidance = delegationEnabled
    ? `- Before calling ANY search, calendar, Gmail, Drive, or other research tools, you MUST invoke \`list_custom_agents\` once per run. Treat the workflow as: plan -> list agents -> (maybe) run_public_agent -> other tools. If the selector returns \`null\`, explicitly log that no agent was suitable, then proceed with core tools.\n- Before calling \`run_public_agent\`, invoke \`list_custom_agents\`, compare every candidate, and respect a \`null\` result as "no delegate—continue with built-in tools."\n- Use \`run_custom_agent\` (the execution surface for selected specialists) immediately after choosing an agent from \`list_custom_agents\`; pass the specific agentId plus a rewritten query tailored to that agent.\n- When \`list_custom_agents\` returns high-confidence candidates, pause to assess the current sub-task and explicitly decide whether running one now accelerates the goal; document the rationale either way.\n- Only delegate when a specific agent's documented capabilities make it unquestionably suitable; otherwise keep iterating yourself.`
    : ""

  // Conversation context with isFirstTurn check (same as buildAgentInstructions)
  const isFirstTurn = context.turnCount === 1
  const workingMemoryMessages =
    config.MEMORY_CONFIG?.WORKING_MEMORY_MESSAGES ?? 6
  const conversationContext = isFirstTurn
    ? `You are given only the last ${workingMemoryMessages} messages of this chat in context. Use \`searchChatHistory\` when you need to recall or search older messages.`
    : ""

  const instructionLines: string[] = [
    "You are Xyne, an enterprise search assistant with agentic capabilities.",
    "",
    `The current date is: ${dateForAI}`,
    "",
    "<context>",
    `User: ${context.user.email}`,
    `Workspace: ${context.user.workspaceId}`,
    conversationContext,
    "</context>",
    "",
  ]

  instructionLines.push(
    "<available_tools>",
    toolDescriptions,
    "</available_tools>",
    cooldownBlock,
  )

  if (agentSection.trim()) {
    instructionLines.push(agentSection.trim(), "")
  }

  instructionLines.push(planSection.trim(), "")

  if (attachmentDirective) {
    instructionLines.push(attachmentDirective, "")
  }

  instructionLines.push(promptAddendum.trim())

  if (reviewResultBlock) {
    instructionLines.push("", reviewResultBlock.trim(), "")
  }

  // Review feedback section (same as buildAgentInstructions)
  if (context.review.lastReviewResult) {
    instructionLines.push(
      "# REVIEW FEEDBACK",
      "- Inspect the <last_review_result> block above; treat every instruction, anomaly, and clarification inside it as mandatory.",
      '- Example: if the review notes "Tool X lacked evidence," reopen that sub-task, add a step to fetch the missing evidence, and mark status accordingly before launching tools.',
      "- Log every required fix directly in the plan so auditors can see alignment with the review.",
      '- When the review lists anomalies or ambiguity, capture each as a corrective sub-task (e.g., "Validate source for claim [2]") and close it before moving forward.',
      "- Answer outstanding clarification questions immediately; if the user must respond, surface the exact question back to them.",
      "",
    )
  }

  // Planning section with conditional review feedback instructions
  instructionLines.push(
    "# PLANNING",
    "- Call toDoWrite at the start of a turn when the plan is new, when review requested changes, or when you need to add or close tasks; otherwise you may proceed without calling toDoWrite to avoid unnecessary iterations.",
    "- Terminate the active plan the moment you have enough evidence to cater to the complete requirement of the user; immediately drop any remaining subtasks when the goal is satisfied.",
    "- Scale the number of subtasks to the query's true complexity , however quality of the final answer and complete execution and satisfaction of user's query outranks task count, you must always prioritize quality",
    ...(context.review.lastReviewResult
      ? [
          "- If the review reports `planChangeNeeded=true`, rewrite the plan around the provided `planChangeReason` before running any new tools, even if older tasks were mid-flight.",
          "- Mirror every `toolFeedback.followUp` and `unmetExpectations` item with a dedicated sub-task (or reopened task) and list the tools that will satisfy it.",
          "- Track each `clarificationQuestions` entry as its own sub-task or outbound user question until the ambiguity is resolved inside <last_review_result>.",
          "- If review feedback demands a brand-new approach, rebuild the plan; otherwise refine the existing tasks.",
          "- If no plan change is needed, explicitly mark the tasks `in_progress` or `completed` so the reviewer sees momentum.",
        ]
      : []),
    "- Maintain one sub-task per concrete goal; list only the tools truly needed for that sub-task.",
    '- Only chain subtasks when real dependencies exist—for example, "fetch the people who messaged me today → gather the emails received from them → summarize the combined thread" keeps later steps paused until earlier outputs arrive.',
    "- After every tool run, immediately update the active sub-task's status, result, and any newly required tasks so the plan mirrors reality.",
    "- Never finish a turn after only calling toDoWrite—run at least one execution tool that advances the active task.",
    "",
    "# CONVERSATIONAL QUERIES",
    "- For simple greetings (e.g., 'hi', 'hello', 'hey'), small talk, or conversational questions that don't require searching documents or data, do NOT call search tools.",
    "- Instead, call `synthesizeFinalAnswer` directly with a friendly, helpful response.",
    "- Examples: 'Hi there! How can I help you today?', 'Hello! What would you like to know?'",
    "",
    "# EXECUTION STRATEGY",
    "- Work tasks sequentially; complete the current task before starting the next.",
    "- Call tools with precise parameters tied to the sub-task goal; reuse stored fragments instead of re-fetching data.",
  )

  // Delegation tools check
  const hasDelegationTools =
    enabledToolNames.includes("list_custom_agents") &&
    enabledToolNames.includes("run_public_agent")
  if (delegationEnabled && hasDelegationTools) {
    instructionLines.push(
      "- When delegation is enabled and justified, run list_custom_agents before run_public_agent; document why the selected agent accelerates the plan.",
      "- Prefer list_custom_agents → run_public_agent before core tools when delegation is enabled and justified by the plan.",
      "- Invoke list_custom_agents at the sub-task level whenever targeted delegation could unlock better results; multi-part queries may require multiple calls as the context evolves.",
      "- Let earlier tool outputs reshape later sub-tasks (e.g., if getSlackRelatedMessages returns only Finance senders, rewrite the next list_custom_agents query with that Finance focus before proceeding).",
    )
  }

  instructionLines.push(
    "- Obey the `recommendation` flag: pause for clarifications when it reads `clarify_query`, keep collecting data for `gather_more`, and do not progress until a fresh plan is in place for `replan`.",
    "- If anomalies or notes in the latest review call out missing evidence, misalignments, or unresolved questions, fix those items before progressing and explain the remediation in the plan.",
    "",
    "# TOOL CALLS & EXPECTATIONS",
    "- Use the model's native function/tool-call interface. Provide clean JSON arguments.",
    "- Do NOT wrap tool calls in custom XML—JAF already handles execution.",
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
    "- When research is complete and evidence is locked, CALL `synthesize_final_answer` with optional `insightsUsefulForAnswering` guidance when it will help the final answer model emphasize the right conclusions or ordering. This tool composes and streams the response.",
    "- Never output the final answer directly—always go through the tool and then acknowledge completion.",
  )

  return instructionLines.join("\n")
}
