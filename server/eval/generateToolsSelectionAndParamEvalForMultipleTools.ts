import pc from "picocolors";
import { generateToolSelectionOutput, jsonParseLLMOutput } from "@/ai/provider";
import { Models, type ModelParams } from "@/ai/types";
import fs from "fs";
import path from "path";
import { constructToolContext, userContext } from "@/ai/context";
import { getLogger } from "@/logger";
import { Subsystem } from "@/types";
import config from "@/config";
import { agentTools } from "@/api/chat/tools";
import { getUserAndWorkspaceByEmail } from "@/db/user";
import { db } from "@/db/client";
import type { Message } from "@aws-sdk/client-bedrock-runtime";

const Logger = getLogger(Subsystem.Eval);
const { defaultBestModel } = config;
const modelId = defaultBestModel || Models.Claude_3_5_Sonnet;

const myEmail = "email@example.com";
const workspaceId = "ht.........";

if (!myEmail) throw new Error("Please set the email");
if (!workspaceId) throw new Error("Please add the workspaceId");

type Data = {
  input: string;
  expected: { tool: string | string[]; arguments: Record<string, any> };
  messages?: Message[];
  reasoning?: boolean;
};

type SelectTool = {
  toolName: string;
  toolSchema: string;
  description?: string;
  externalId?: string;
};

// Mock AgentReasoningStep for logging and streaming reasoning
type AgentReasoningStepType =
  | "Iteration"
  | "LogMessage"
  | "AnalyzingQuery"
  | "Planning"
  | "ToolExecuting"
  | "ToolParameters"
  | "ToolResult"
  | "ValidationError"
  | "BroadeningSearch";

interface AgentReasoningStep {
  type: AgentReasoningStepType;
  message?: string;
  iteration?: number;
  details?: string;
  toolName?: string;
  parameters?: Record<string, any>;
  resultSummary?: string;
  itemsFound?: number;
  error?: string;
}

// Mock MinimalAgentFragment for context gathering
interface MinimalAgentFragment {
  id: string;
  content: string;
  source: {
    docId: string;
    title?: string;
    app?: string;
    url?: string;
    entity?: string;
  };
  confidence: number;
}

// Mock synthesis states
enum ContextSysthesisState {
  Complete = "Complete",
  Partial = "Partial",
  NotFound = "NotFound",
}

const loadTestData = (): Data[] => {
  try {
    const filePath = path.join(
      __dirname,
      "..",
      "..",
      "eval-data",
      "test-queries.json",
    );
    const data = fs.readFileSync(filePath, "utf-8");
    const parsedData = JSON.parse(data);
    if (!Array.isArray(parsedData))
      throw new Error("Test data must be an array");
    return parsedData;
  } catch (error) {
    console.error("Error loading test data:", error);
    throw error;
  }
};

const data = loadTestData();
if (!data.length) throw new Error("Data is not set for the evals");

function compareArguments(
  expectedArgs: Record<string, any>,
  actualArgs: Record<string, any>,
): number {
  let matched = 0;
  const expectedKeys = Object.keys(expectedArgs);
  for (const key of expectedKeys) {
    if (key in actualArgs) matched++;
  }
  return expectedKeys.length === 0 ? 1 : matched / expectedKeys.length;
}

function evaluateToolSequence(expected: string[], actual: string[]): number {
  if (!expected.length || !actual.length) return 0;
  let score = 0;
  const minLen = Math.min(expected.length, actual.length);
  for (let i = 0; i < minLen; i++) {
    if (expected[i] === actual[i]) score++;
  }
  return score / expected.length;
}

function evaluateResponse({
  outputTools,
  outputArgs,
  expected,
  input,
}: {
  outputTools: string[];
  outputArgs: Record<string, any>[];
  expected: { tool: string | string[]; arguments: Record<string, any> };
  input: string;
}) {
  console.log("####### EVALUATING TOOL SELECTION ########");
  console.log("Generated tool(s):", outputTools || "none");
  console.log("Expected tool(s):", expected.tool);

  const expectedTools = Array.isArray(expected.tool)
    ? expected.tool
    : [expected.tool];
  const actualTools = outputTools || [];

  let matchedTools = 0;
  const matchedToolNames: string[] = [];

  for (const tool of expectedTools) {
    const isValid =
      actualTools.includes(tool) ||
      (tool === "search" &&
        actualTools.includes("time_search") &&
        input.toLowerCase().includes("recent"));

    if (isValid) {
      matchedTools++;
      matchedToolNames.push(tool);
    }
  }

  const toolMatchScore = expectedTools.length
    ? matchedTools / expectedTools.length
    : 0;

  const sequenceScore = evaluateToolSequence(expectedTools, actualTools);

  let argsScore = 0;
  if (matchedToolNames.length > 0 && outputArgs.length > 0) {
    // Average argument match score across all iterations
    const argScores = outputArgs.map((args) =>
      compareArguments(expected.arguments, args),
    );
    argsScore =
      argScores.reduce((sum, score) => sum + score, 0) / argScores.length;
  }

  const overallScore = (toolMatchScore + argsScore + sequenceScore) / 3;

  console.log(
    pc.green(
      `Tool match score: ${(toolMatchScore * 100).toFixed(1)}%, Argument match score: ${(argsScore * 100).toFixed(1)}%, Sequence score: ${(sequenceScore * 100).toFixed(1)}%`,
    ),
  );

  if (overallScore === 1) {
    console.log(pc.green("✅ Full match"));
  } else if (overallScore > 0) {
    console.log(pc.yellow("⚠️ Partial match"));
  } else {
    console.log(pc.red("❌ No match"));
  }

  return { score: overallScore };
}

function saveEvalResults(
  evaluation: { averageScore: number; results: any[] },
  name: string,
) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `${name}-${timestamp}.json`;
  const filePath = path.join(
    process.cwd(),
    "eval-results",
    "tools",
    "compare",
    fileName,
  );

  const evalResultsDir = path.join(
    process.cwd(),
    "eval-results",
    "tools",
    "compare",
  );
  if (!fs.existsSync(evalResultsDir)) {
    fs.mkdirSync(evalResultsDir, { recursive: true });
    Logger.info(`Created directory: ${evalResultsDir}`);
  }

  try {
    fs.writeFileSync(filePath, JSON.stringify(evaluation, null, 2));
    Logger.info(`Evaluation results saved to: ${filePath}`);
    return fileName;
  } catch (error) {
    Logger.error(`Failed to save evaluation results to ${filePath}: ${error}`);
    throw error;
  }
}

// Mock performSynthesis function to simulate context sufficiency
async function performSynthesis(
  ctx: string,
  message: string,
  planningContext: string,
  gatheredFragments: MinimalAgentFragment[],
  messages: any[],
  logAndStreamReasoning: (step: AgentReasoningStep) => Promise<void>,
  email: string,
  attachmentFileIds: string[],
): Promise<{
  synthesisState: ContextSysthesisState;
  answer?: string;
}> {
  // Simulate synthesis logic (simplified)
  // In a real implementation, this would call an LLM to evaluate context sufficiency
  await logAndStreamReasoning({
    type: "LogMessage",
    message: `Simulating synthesis for query: "${message}" with ${gatheredFragments.length} fragments`,
  });

  if (gatheredFragments.length >= 2) {
    // Assume sufficient context if we have at least 2 fragments
    return { synthesisState: ContextSysthesisState.Complete, answer: "Mock answer" };
  } else if (gatheredFragments.length > 0) {
    return { synthesisState: ContextSysthesisState.Partial, answer: "Partial answer" };
  } else {
    return { synthesisState: ContextSysthesisState.NotFound };
  }
}

// Mock tool execution response
async function mockToolExecution(
  toolName: string,
  toolParams: Record<string, any>,
  email: string,
): Promise<{
  result: string;
  contexts?: MinimalAgentFragment[];
  error?: string;
}> {
  // Simulate tool execution (simplified)
  if (toolName === "search" || toolName === "time_search") {
    return {
      result: `Executed ${toolName} with params ${JSON.stringify(toolParams)}`,
      contexts: [
        {
          id: `fragment-${toolName}-${Date.now()}`,
          content: `Mock content from ${toolName}`,
          source: {
            docId: `doc-${toolName}-${Date.now()}`,
            title: `Mock Title from ${toolName}`,
            app: "MockApp",
            entity: "MockEntity",
          },
          confidence: 0.9,
        },
      ],
    };
  } else if (toolName === "Conversational") {
    return {
      result: "Conversational tool selected, no further context needed.",
    };
  } else {
    return {
      result: `Tool ${toolName} not found.`,
      error: "Tool not found",
    };
  }
}

async function runEvaluation(userCtx: string) {
  const results: (Data & {
    outputTools: string[];
    outputArgs: Record<string, any>[];
    score: number;
    rawOutputs: string[];
    reasoningOutputs: string[];
    reasoningSteps: AgentReasoningStep[];
  })[] = [];

  const maxIterations = 10;
  const MAX_CONSECUTIVE_TOOL_FAILURES = 2;

  let toolsPrompt = "";
  if (Object.keys(agentTools).length > 0) {
    toolsPrompt = `While answering check if any below given AVAILABLE_TOOLS can be invoked to get more context to answer the user query more accurately, this is very IMPORTANT so you should check this properly based on the given tools information. 
 AVAILABLE_TOOLS:\n\n`;
    for (const tool of Object.values(agentTools)) {
      toolsPrompt += `${constructToolContext(
        JSON.stringify(tool.parameters),
        tool.name,
        tool.description ?? "",
      )}\n\n`;
    }
  }
  Logger.info("Tools available for evaluation:\n" + toolsPrompt);
  Logger.info("User context:\n" + userCtx);

  for await (const item of data) {
    Logger.info(`Processing query: "${item.input}"`);

    const outputTools: string[] = [];
    const outputArgs: Record<string, any>[] = [];
    const rawOutputs: string[] = [];
    const reasoningOutputs: string[] = [];
    const structuredReasoningSteps: AgentReasoningStep[] = [];
    let gatheredFragments: MinimalAgentFragment[] = [];
    let planningContext = "";
    let agentScratchpad = "";
    let iterationCount = 0;
    let answered = false;
    const previousToolCalls: { tool: string; args: Record<string, any>; failureCount: number }[] = [];

    // Mock logAndStreamReasoning function
    const logAndStreamReasoning = async (reasoningStep: AgentReasoningStep) => {
      const humanReadableLog = convertReasoningStepToText(reasoningStep);
      reasoningOutputs.push(humanReadableLog);
      structuredReasoningSteps.push(reasoningStep);
      Logger.info(`Reasoning: ${humanReadableLog}`);
    };

    // Convert reasoning step to text (simplified)
    const convertReasoningStepToText = (step: AgentReasoningStep): string => {
      switch (step.type) {
        case "Iteration":
          return `Iteration ${step.iteration}`;
        case "LogMessage":
          return step.message || "";
        case "AnalyzingQuery":
        case "Planning":
        case "BroadeningSearch":
          return step.details || "";
        case "ToolExecuting":
          return `Executing tool: ${step.toolName}`;
        case "ToolParameters":
          return `Tool parameters: ${JSON.stringify(step.parameters)}`;
        case "ToolResult":
          return `Tool ${step.toolName} result: ${step.resultSummary}${step.error ? ` (Error: ${step.error})` : ""}`;
        case "ValidationError":
          return `Validation error: ${step.details}`;
        default:
          return JSON.stringify(step);
      }
    };

    await logAndStreamReasoning({
      type: "LogMessage",
      message: `Analyzing your query...`,
    });

    while (iterationCount < maxIterations && !answered) {
      iterationCount++;
      await logAndStreamReasoning({
        type: "Iteration",
        iteration: iterationCount,
      });

      // Build agentScratchpad
      const evidenceSummary =
        gatheredFragments.length > 0
          ? `\n--- CURRENTLY GATHERED EVIDENCE ---\n` +
            gatheredFragments
              .map(
                (f, i) =>
                  `[Fragment ${i + 1}] (Source Doc ID: ${f.source.docId})\n` +
                  `  - Title: ${f.source.title || "Untitled"}\n` +
                  `  - Content Snippet: "${f.content.substring(0, 100)}..."`,
              )
              .join("\n\n")
          : "\n--- NO EVIDENCE GATHERED YET ---";

      const reasoningHeader = `
        --- AGENT REASONING SO FAR ---
        Below is the step-by-step reasoning taken so far. Use this to inform your next action.
        ${structuredReasoningSteps.map(convertReasoningStepToText).join("\n")}
      `;
      agentScratchpad = evidenceSummary + "\n\n" + reasoningHeader;

      // Check for consecutive failures and add warning
      let loopWarningPrompt = "";
      const lastToolCall = previousToolCalls[previousToolCalls.length - 1];
      if (
        lastToolCall &&
        lastToolCall.failureCount >= MAX_CONSECUTIVE_TOOL_FAILURES
      ) {
        loopWarningPrompt = `
          ---
          **Critique Past Actions:** You have repeatedly called the tool '${lastToolCall.tool}' with arguments ${JSON.stringify(
            lastToolCall.args,
          )} and it has failed or yielded insufficient results ${lastToolCall.failureCount} times consecutively. You are stuck in a loop. You MUST choose a DIFFERENT TOOL or escalate to a "no answer found" state if no other tools are viable.
          ---
        `;
        await logAndStreamReasoning({
          type: "LogMessage",
          message: `Detected ${lastToolCall.failureCount} consecutive failures for tool ${lastToolCall.tool}. Attempting to change strategy.`,
        });
      } else if (previousToolCalls.length) {
        loopWarningPrompt = `
          ---
          **Critique Past Actions:** You have already called some tools ${previousToolCalls
            .map(
              (toolCall, idx) =>
                `[Iteration-${idx}] Tool: ${toolCall.tool}, Args: ${JSON.stringify(toolCall.args)}`,
            )
            .join("\n")} and the result was insufficient. You are in a loop. You MUST change your strategy.
          For example:
            1. Choose a **DIFFERENT TOOL**.
            2. Use the **SAME TOOL** but with **DIFFERENT Parameters**.
            3. Use just different **offset** if you think the tool selected is correct and you need to go to the next page to find better context.
          Do NOT make these calls again. Formulate a new, distinct plan.
          ---
        `;
      }

      const modelParams: ModelParams = {
        modelId,
        stream: true,
        json: true,
        reasoning: item.reasoning ?? false,
        messages: item.messages || [],
      };

      Logger.info(
        `Iteration ${iterationCount} - Model params: ${JSON.stringify(modelParams, null, 2)}`,
      );

      const toolSelectionOutput = await generateToolSelectionOutput(
        item.input,
        userCtx,
        toolsPrompt,
        agentScratchpad,
        modelParams,
        undefined, // agentPromptForLLM
        loopWarningPrompt,
        { internal: agentTools },
        config.isDebugMode,
      );

      let output: {
        answer?: string;
        tool?: string | string[];
        arguments?: any;
        reasoning?: string;
      } = {
        answer: null,
        tool: null,
        arguments: null,
      };
      let buffer = "";
      let reasoningOutput = "";
      let reasoningActive = item.reasoning ?? false;

      if (
        toolSelectionOutput &&
        typeof toolSelectionOutput === "object" &&
        typeof toolSelectionOutput[Symbol.asyncIterator] === "function"
      ) {
        for await (const chunk of toolSelectionOutput) {
          if (chunk.text) {
            if (reasoningActive) {
              if (chunk.text.includes("<think>")) {
                reasoningOutput += chunk.text;
              } else if (chunk.text.includes("</think>")) {
                reasoningActive = false;
                const parts = chunk.text.split("</think>");
                if (parts[0]) reasoningOutput += parts[0];
                if (parts[1]) buffer += parts[1].trim();
              } else {
                reasoningOutput += chunk.text;
              }
            } else {
              buffer += chunk.text;
            }
          }
        }
      } else {
        buffer = JSON.stringify(toolSelectionOutput);
      }

      rawOutputs.push(buffer);
      if (reasoningOutput) reasoningOutputs.push(reasoningOutput);

      Logger.info(`Raw LLM output for query "${item.input}": ${buffer}`);
      if (reasoningOutput) Logger.info(`Reasoning output: ${reasoningOutput}`);

      try {
        output = jsonParseLLMOutput(buffer) || {
          answer: null,
          tool: null,
          arguments: null,
        };
        Logger.info(`Parsed output: ${JSON.stringify(output, null, 2)}`);
      } catch (err) {
        Logger.error(
          `Failed to parse LLM output for query "${item.input}": ${buffer}`,
        );
        Logger.error(`Error: ${err}`);
        continue; // Skip to next iteration on parse error
      }

      if (output.tool) {
        const toolName = Array.isArray(output.tool)
          ? output.tool[0]
          : output.tool;
        const toolParams = output.arguments || {};

        outputTools.push(toolName);
        outputArgs.push(toolParams);

        await logAndStreamReasoning({
          type: "ToolExecuting",
          toolName,
        });
        await logAndStreamReasoning({
          type: "ToolParameters",
          parameters: toolParams,
        });

        // Update previousToolCalls
        const lastCallIndex = previousToolCalls.length - 1;
        if (
          lastCallIndex >= 0 &&
          previousToolCalls[lastCallIndex].tool === toolName &&
          JSON.stringify(previousToolCalls[lastCallIndex].args) ===
            JSON.stringify(toolParams)
        ) {
          previousToolCalls[lastCallIndex].failureCount++;
        } else {
          previousToolCalls.push({
            tool: toolName,
            args: toolParams,
            failureCount: 0,
          });
        }

        if (toolName === "Conversational") {
          await logAndStreamReasoning({
            type: "LogMessage",
            message: `Tool ${toolName} selected. Stopping iteration.`,
          });
          answered = true;
          break;
        }

        // Simulate tool execution
        const toolExecutionResponse = await mockToolExecution(
          toolName,
          toolParams,
          myEmail,
        );

        await logAndStreamReasoning({
          type: "ToolResult",
          toolName,
          resultSummary: toolExecutionResponse.result,
          itemsFound: toolExecutionResponse.contexts?.length || 0,
          error: toolExecutionResponse.error,
        });

        // Update failure count based on tool execution result
        const currentToolCall = previousToolCalls[previousToolCalls.length - 1];
        if (
          currentToolCall &&
          (toolExecutionResponse.error ||
            !toolExecutionResponse.contexts ||
            toolExecutionResponse.contexts.length === 0)
        ) {
          currentToolCall.failureCount++;
        } else if (currentToolCall) {
          currentToolCall.failureCount = 0;
        }

        if (toolExecutionResponse.contexts && toolExecutionResponse.contexts.length > 0) {
          gatheredFragments.push(...toolExecutionResponse.contexts);
          planningContext = gatheredFragments
            .map(
              (f, i) =>
                `[${i + 1}] ${f.source.title || `Source ${f.source.docId}`}: ${f.content}`,
            )
            .join("\n");
        }

        // Perform synthesis to check if context is sufficient
        const synthesisOutput = await performSynthesis(
          userCtx,
          item.input,
          planningContext,
          gatheredFragments,
          item.messages || [],
          logAndStreamReasoning,
          myEmail,
          [],
        );

        await logAndStreamReasoning({
          type: "LogMessage",
          message: `Synthesis result: ${synthesisOutput.synthesisState}`,
        });

        if (synthesisOutput.synthesisState === ContextSysthesisState.Complete) {
          await logAndStreamReasoning({
            type: "LogMessage",
            message: "Context is sufficient. Stopping iteration.",
          });
          answered = true;
          break;
        } else if (iterationCount < maxIterations) {
          await logAndStreamReasoning({
            type: "BroadeningSearch",
            details: `Context is insufficient. Planning iteration ${iterationCount + 1}.`,
          });
          continue;
        } else {
          await logAndStreamReasoning({
            type: "LogMessage",
            message: "Max iterations reached. Stopping with available context.",
          });
          break;
        }
      } else {
        // No tool selected
        const lastCall = previousToolCalls[previousToolCalls.length - 1];
        if (lastCall && lastCall.tool === "NoToolSelected") {
          lastCall.failureCount++;
        } else {
          previousToolCalls.push({
            tool: "NoToolSelected",
            args: {},
            failureCount: 1,
          });
        }

        await logAndStreamReasoning({
          type: "LogMessage",
          message: `No tool selected. Re-planning.`,
        });

        const synthesisOutput = await performSynthesis(
          userCtx,
          item.input,
          planningContext,
          gatheredFragments,
          item.messages || [],
          logAndStreamReasoning,
          myEmail,
          [],
        );

        await logAndStreamReasoning({
          type: "LogMessage",
          message: `Synthesis result: ${synthesisOutput.synthesisState}`,
        });

        if (synthesisOutput.synthesisState === ContextSysthesisState.Complete) {
          await logAndStreamReasoning({
            type: "LogMessage",
            message: "Context is sufficient. Stopping iteration.",
          });
          answered = true;
          break;
        } else if (iterationCount < maxIterations) {
          continue;
        } else {
          await logAndStreamReasoning({
            type: "LogMessage",
            message: "Max iterations reached. Stopping with available context.",
          });
          break;
        }
      }
    }

    const { score } = evaluateResponse({
      outputTools,
      outputArgs,
      expected: item.expected,
      input: item.input,
    });

    results.push({
      ...item,
      outputTools,
      outputArgs,
      score: Math.round(score * 100),
      rawOutputs,
      reasoningOutputs,
      reasoningSteps: structuredReasoningSteps,
    });
  }

  const avgScore = results.reduce((a, c) => a + c.score, 0) / results.length;
  console.log(`Tool Selection eval score: ${avgScore}`);

  const savedFileName = saveEvalResults(
    { averageScore: avgScore, results },
    "tool-selection-eval",
  );

  console.log(`Results saved to: ${savedFileName}`);
}

const callRunEvaluation = async () => {
  try {
    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId,
      myEmail,
    );
    const ctx = userContext(userAndWorkspace);
    await runEvaluation(ctx);
  } catch (error) {
    Logger.error("Failed to fetch user and workspace:", error);
    throw error;
  }
};

await callRunEvaluation();