// import pc from "picocolors";
// import fs from "fs";
// import path from "path";
// import { userContext } from "@/ai/context";
// import { getLogger } from "@/logger";
// import { MessageRole, Subsystem } from "@/types";
// import { db } from "@/db/client";
// import { streamSSE } from "hono/streaming";
// import { ChatSSEvents } from "@/shared/types";
// import { generateSearchQueryOrAnswerFromConversation, jsonParseLLMOutput } from "@/ai/provider";
// import stringSimilarity from "string-similarity";// Actual LLM functions
// import { UnderstandMessageAndAnswer } from "@/api/chat/chat";
// import { getChatMessagesWithAuth, insertMessage } from "@/db/message";
// import { getUserAndWorkspaceByEmail } from "@/db/user";

// const Logger = getLogger(Subsystem.Eval);
// const myEmail = "oindrila.banerjee@juspay.in";
// const workspaceId = "i3acjjlykgjyamw51qbwhhiu";

// if (!myEmail) throw new Error("Please set the email");
// if (!workspaceId) throw new Error("Please add the workspaceId");

// // Utility functions (minimal implementation for context detection)
// const utils = {
//   isMessageWithContext: (message) => message.includes('context') || message.includes('@'),
//   extractFileIdsFromMessage: async (message) => ({ fileIds: ['file_123'], totalValidFileIdsFromLinkCount: 1 }) // Simplified, replace with actual logic if needed
// };

// // Evaluation data type
// type EvalData = {
//   input: string;
//   chatId?: string;
//   modelId?: string;
//   isReasoningEnabled?: boolean;
//   agentPromptForLLM?: string;
//   attachmentFileIds?: string[];
//   expectedAnswer: string;
// };

// // Evaluation result type
// type EvalResult = {
//   input: string;
//   output: {
//     answer?: string;
//     answerType: "context" | "conversation" | "error";
//     reasoning?: string;
//     error?: string;
//   };
//   expected: {
//     answer: string;
//     answerType: "context" | "conversation";
//   };
//   score: number;
//   metrics: {
//     answerTypeMatch: boolean;
//     hasAnswerMatch: boolean;
//     similarityScore: number;
//   };
//   processingTime: number;
// };

// // Load test data from JSON file
// const loadTestData = (): EvalData[] => {
//   try {
//     const filePath = path.join(__dirname, "..", "..", "eval-data", "test-queries.json");
//     const data = fs.readFileSync(filePath, "utf-8");
//     const parsedData = JSON.parse(data);
//     if (!Array.isArray(parsedData)) throw new Error("Test data must be an array");
//     return parsedData;
//   } catch (error) {
//     Logger.error(`Error loading test data: ${error}`);
//     throw error;
//   }
// };

// // Simulate the AgentMessageApi flow
// async function simulateAgentMessageFlow(evalItem: EvalData, userCtx: string): Promise<EvalResult> {
//   const startTime = Date.now();
//   let chatId = evalItem.chatId || null;
//   let messageId = null;
//   const result: EvalResult = {
//     input: evalItem.input,
//     output: {
//       answerType: "error",
//     },
//     expected: {
//       answer: evalItem.expectedAnswer,
//       answerType: evalItem.attachmentFileIds?.length || utils.isMessageWithContext(evalItem.input) ? "context" : "conversation",
//     },
//     score: 0,
//     metrics: {
//       answerTypeMatch: false,
//       hasAnswerMatch: false,
//       similarityScore: 0,
//     },
//     processingTime: 0,
//   };

//   try {
//     const message = decodeURIComponent(evalItem.input);
//     let answer = "";
//     let reasoning = evalItem.isReasoningEnabled ? "" : null;
//     let answerType: "context" | "conversation" | "error" = "error";
//     const userAndWorkspace = await getUserAndWorkspaceByEmail(db, workspaceId, myEmail);
//     const { user, workspace } = userAndWorkspace;

//     // Simulate chat and message insertion
//     let chat;
//     let messages = [];
//     if (!chatId) {
//       chat = { id: 1, externalId: `chat_${Date.now()}`, title: 'Test Chat', workspaceId: workspace.id, userId: user.id };
//       const insertedMsg = await insertMessage(db, {
//         chatId: chat.id,
//         userId: user.id,
//         chatExternalId: chat.externalId,
//         workspaceExternalId: workspace.externalId,
//         messageRole: MessageRole.User,
//         email: myEmail,
//         sources: [],
//         message,
//         modelId: evalItem.modelId,
//         fileIds: evalItem.attachmentFileIds || []
//       });
//       messages.push(insertedMsg);
//     } else {
//       const existingChat = { id: 2, externalId: chatId, title: 'Existing Chat', workspaceId: workspace.id, userId: user.id };
//       const allMessages = await getChatMessagesWithAuth(db, chatId, myEmail);
//       const insertedMsg = await insertMessage(db, {
//         chatId: existingChat.id,
//         userId: user.id,
//         workspaceExternalId: workspace.externalId,
//         chatExternalId: existingChat.externalId,
//         messageRole: MessageRole.User,
//         email: myEmail,
//         sources: [],
//         message,
//         modelId: evalItem.modelId,
//         fileIds: evalItem.attachmentFileIds || []
//       });
//       chat = existingChat;
//       messages = allMessages.concat(insertedMsg);
//     }

//     const mockContext = {
//       get: (key: string) => ({ sub: myEmail, workspaceId }),
//       req: {
//         valid: () => ({
//           message: evalItem.input,
//           chatId: evalItem.chatId,
//           modelId: evalItem.modelId,
//           isReasoningEnabled: evalItem.isReasoningEnabled,
//           agentId: null,
//         }),
//         query: (name: string) => (name === "attachmentFileIds" ? (evalItem.attachmentFileIds || []).join(",") : undefined),
//       },
//       json: (data) => new Response(JSON.stringify(data)),
//       streamSSE: async (cb) => {
//         const mockStream: any = {
//           writeSSE: (event: { event: string; data: any }) => {
//             const data = typeof event.data === "string" ? event.data : JSON.stringify(event.data);
//             switch (event.event) {
//               case ChatSSEvents.ResponseUpdate:
//                 answer += data;
//                 break;
//               case ChatSSEvents.Reasoning:
//                 reasoning += data;
//                 break;
//               case ChatSSEvents.ResponseMetadata:
//                 const meta = JSON.parse(data);
//                 if (meta.chatId) chatId = meta.chatId;
//                 if (meta.messageId) messageId = meta.messageId;
//                 break;
//               case ChatSSEvents.Error:
//                 result.output.error = data;
//                 break;
//             }
//           },
//           close: () => {},
//           closed: false,
//         };
//         await cb(mockStream);
//       },
//     } as any;

//     // Simulate the two flows
//     const isMsgWithContext = utils.isMessageWithContext(message);
//     const fileIds = isMsgWithContext
//       ? (await utils.extractFileIdsFromMessage(message)).fileIds
//       : (evalItem.attachmentFileIds || []);

//     await streamSSE(mockContext, async (stream) => {
//       const streamKey = `${chat.externalId}`;
//       try {
//         if ((isMsgWithContext && fileIds.length > 0) || (evalItem.attachmentFileIds && evalItem.attachmentFileIds.length > 0)) {
//           // Flow with context
//           answerType = "context";
//           const iterator = UnderstandMessageAndAnswer(
//             myEmail,
//             userCtx,
//             message,
//             {}, // Empty classification
//             messages,
//             0.5,
//             evalItem.isReasoningEnabled,
//             null, // No tracer
//             evalItem.agentPromptForLLM
//           );

//           for await (const chunk of iterator) {
//             if (stream.closed) {
//               result.output.error = "Stream closed prematurely";
//               answerType = "error";
//               break;
//             }
//             if (chunk.text) {
//               if (evalItem.isReasoningEnabled && chunk.reasoning) {
//                 reasoning += chunk.text;
//               } else {
//                 answer += chunk.text;
//               }
//             }
//           }
//         } else {
//           // Flow without context
//           answerType = "conversation";
//           const messagesWithNoErrResponse = messages
//             .slice(0, messages.length - 1)
//             .filter(msg => !msg.errorMessage && !(msg.messageRole === MessageRole.Assistant && !msg.message))
//             .map(msg => ({
//               role: msg.messageRole,
//               content: [{ text: msg.message }],
//             }));

//           const limitedMessages = messagesWithNoErrResponse.slice(-8);
//           const searchOrAnswerIterator = generateSearchQueryOrAnswerFromConversation(message, userCtx, {
//             modelId: evalItem.modelId,
//             stream: true,
//             json: true,
//             reasoning: evalItem.isReasoningEnabled,
//             messages: limitedMessages,
//             agentPrompt: evalItem.agentPromptForLLM,
//           });

//           let parsed = { answer: '' };
//           for await (const chunk of searchOrAnswerIterator) {
//             if (stream.closed) {
//               result.output.error = "Stream closed prematurely";
//               answerType = "error";
//               break;
//             }
//             if (chunk.text) {
//               if (evalItem.isReasoningEnabled && !chunk.text.includes('END_THINKING')) {
//                 reasoning += chunk.text;
//               } else if (chunk.text.includes('END_THINKING')) {
//                 const text = chunk.text.split('END_THINKING')[1].trim();
//                 parsed.answer += text;
//                 answer = parsed.answer;
//               } else {
//                 parsed.answer += chunk.text;
//                 answer = parsed.answer;
//               }
//             }
//           }
//         }

//         if (answer) {
//           const msg = await insertMessage(db, {
//             chatId: chat.id,
//             userId: user.id,
//             workspaceExternalId: workspace.externalId,
//             chatExternalId: chat.externalId,
//             messageRole: MessageRole.Assistant,
//             email: myEmail,
//             sources: [],
//             message: answer,
//             thinking: reasoning,
//             modelId: evalItem.modelId,
//           });
//           messageId = msg.externalId;
//           result.output = { answer, answerType, reasoning };
//         } else {
//           const allMessages = await getChatMessagesWithAuth(db, chat.externalId, myEmail);
//           const lastMessage = allMessages[allMessages.length - 1];
//           result.output = {
//             answerType: "error",
//             error: "Can you please make your query more specific?",
//           };
//           messageId = lastMessage.externalId;
//         }

//         await stream.writeSSE({
//           event: ChatSSEvents.ResponseMetadata,
//           data: JSON.stringify({ chatId: chat.externalId, messageId }),
//         });
//         await stream.writeSSE({ data: "", event: ChatSSEvents.End });
//       } catch (error) {
//         Logger.error(`Error in stream: ${error}`);
//         result.output.error = error.message;
//         result.output.answerType = "error";
//         const allMessages = await getChatMessagesWithAuth(db, chat.externalId, myEmail);
//         const lastMessage = allMessages[allMessages.length - 1];
//         await stream.writeSSE({
//           event: ChatSSEvents.ResponseMetadata,
//           data: JSON.stringify({ chatId: chat.externalId, messageId: lastMessage.externalId }),
//         });
//         await stream.writeSSE({ event: ChatSSEvents.Error, data: error.message });
//         await stream.writeSSE({ data: "", event: ChatSSEvents.End });
//       }
//     });
//   } catch (error) {
//     Logger.error(`Error in agent message flow: ${error}`);
//     result.output.error = error.message;
//     result.output.answerType = "error";
//   }

//   result.processingTime = Date.now() - startTime;
//   return result;
// }

// // Evaluate the response
// function evaluateResponse(result: EvalResult): number {
//   const { output, expected, metrics } = result;

//   console.log("####### EVALUATING AGENT MESSAGE RESPONSE ########");
//   console.log(`Generated answer type: ${output.answerType}`);
//   console.log(`Expected answer type: ${expected.answerType}`);
//   console.log(`Has answer: ${!!output.answer}`);
//   console.log(`Expected answer: ${expected.answer}`);
//   console.log(`Actual answer: ${output.answer || 'N/A'}`);
//   if (output.reasoning) console.log(`Reasoning: ${output.reasoning}`);

//   let score = 0;
//   let totalChecks = 0;

//   // Check answer type match
//   metrics.answerTypeMatch = output.answerType === expected.answerType;
//   if (metrics.answerTypeMatch) score += 1;
//   totalChecks += 1;

//   // Check if answer presence matches expectation
//   metrics.hasAnswerMatch = !!output.answer === !!expected.answer;
//   if (metrics.hasAnswerMatch) score += 1;
//   totalChecks += 1;

//   // Check answer similarity
//   if (output.answer && expected.answer) {
//     metrics.similarityScore = stringSimilarity.compareTwoStrings(
//       output.answer.toLowerCase().trim(),
//       expected.answer.toLowerCase().trim()
//     );
//     score += metrics.similarityScore;
//     totalChecks += 1;
//   } else {
//     metrics.similarityScore = 0;
//   }

//   const finalScore = totalChecks > 0 ? score / totalChecks : 0;

//   console.log(pc.green(`Score: ${(finalScore * 100).toFixed(1)}%`));
//   console.log(`Metrics: ${JSON.stringify(metrics, null, 2)}`);

//   if (finalScore >= 0.8) {
//     console.log(pc.green("✅ Excellent match"));
//   } else if (finalScore >= 0.6) {
//     console.log(pc.yellow("⚠️ Good match"));
//   } else if (finalScore >= 0.4) {
//     console.log(pc.yellow("⚠️ Partial match"));
//   } else {
//     console.log(pc.red("❌ Poor match"));
//   }

//   return finalScore;
// }

// // Save evaluation results
// function saveEvalResults(evaluation: { averageScore: number; results: EvalResult[] }, name: string) {
//   const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
//   const fileName = `${name}-${timestamp}.json`;
//   const filePath = path.join(process.cwd(), "eval-results", "agent-message", fileName);

//   const evalResultsDir = path.join(process.cwd(), "eval-results", "agent-message");
//   if (!fs.existsSync(evalResultsDir)) {
//     fs.mkdirSync(evalResultsDir, { recursive: true });
//     Logger.info(`Created directory: ${evalResultsDir}`);
//   }

//   try {
//     fs.writeFileSync(filePath, JSON.stringify(evaluation, null, 2));
//     Logger.info(`Evaluation results saved to: ${filePath}`);
//     return fileName;
//   } catch (error) {
//     Logger.error(`Failed to save evaluation results to ${filePath}: ${error}`);
//     throw error;
//   }
// }

// // Run evaluation
// async function runEvaluation(userCtx: string) {
//   const data = loadTestData();
//   if (!data.length) throw new Error("Data is not set for the evals");

//   const results: EvalResult[] = [];

//   Logger.info("Starting Agent Message API evaluation...");
//   Logger.info(`User context: ${userCtx}`);

//   for (const item of data) {
//     Logger.info(`Processing query: "${item.input}"`);

//     await new Promise(resolve => setTimeout(resolve, 2000)); // Rate limiting

//     const result = await simulateAgentMessageFlow(item, userCtx);

//     Logger.info(`Result for "${item.input}":`);
//     Logger.info(`- Answer type: ${result.output.answerType}`);
//     Logger.info(`- Has answer: ${!!result.output.answer}`);
//     Logger.info(`- Answer: ${result.output.answer || 'N/A'}`);
//     Logger.info(`- Processing time: ${result.processingTime}ms`);

//     result.score = evaluateResponse(result);
//     results.push(result);

//     console.log("---");
//   }

//   const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length;
//   const avgProcessingTime = results.reduce((sum, r) => sum + r.processingTime, 0) / results.length;

//   console.log(pc.green(`\n=== FINAL RESULTS ===`));
//   console.log(`Average Score: ${(avgScore * 100).toFixed(1)}%`);
//   console.log(`Average Processing Time: ${avgProcessingTime.toFixed(0)}ms`);
//   console.log(`Passed Tests: ${results.filter(r => r.score >= 0.8).length}/${results.length}`);

//   const savedFileName = saveEvalResults({ averageScore: avgScore, results }, "agent-message-eval");

//   console.log(`Results saved to: ${savedFileName}`);

//   return { avgScore, results, avgProcessingTime };
// }

// // Main execution
// const callRunEvaluation = async () => {
//   try {
//     const userAndWorkspace = await getUserAndWorkspaceByEmail(db, workspaceId, myEmail);
//     const ctx = userContext(userAndWorkspace);
//     await runEvaluation(ctx);
//   } catch (error) {
//     Logger.error(`Failed to fetch user and workspace: ${error}`);
//     throw error;
//   }
// };

// await callRunEvaluation();