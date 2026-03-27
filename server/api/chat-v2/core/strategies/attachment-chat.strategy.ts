/**
 * Attachment Chat Strategy
 * 
 * Handles chats with file attachments
 * - Pre-loads attachment context
 * - Processes file fragments
 * - Delegates to AgenticChatStrategy after attachment processing
 * 
 * REPLACES: Attachment processing logic in pi-mono/message-agents.ts (lines 270-310, 500-565)
 */

import { BaseChatModeStrategy, type StrategyCapability } from "./base-chat-mode-strategy"
import { ChatMode } from "./chat-mode-strategy"
import type {
  ChatRequest,
  AssembledChatContext,
  Fragment,
  AttachmentContext,
} from "../../models"
import type { ChatEvent } from "../../shared/events"
import type { RequestContextLike as RequestContext } from "../orchestrator/request-context.types"
import { AgenticContextAssembler, NormalContextAssembler } from "../pipeline/context-assembly"
import type { ContextAssembler } from "../pipeline/context-assembly"
import { AgenticChatStrategy } from "./agentic-chat.strategy"
import { NormalChatStrategy } from "./normal-chat.strategy"

export interface AttachmentChatStrategyOptions {
  /** Strategy to use after attachment processing */
  delegateTo?: "agentic" | "normal"
  /** Process images separately */
  processImages?: boolean
  /** Max file size to process (bytes) */
  maxFileSize?: number
}

/**
 * Attachment fragment with metadata
 */
interface AttachmentFragment extends Fragment {
  isImage: boolean
  fileId: string
  fileName?: string
  mimeType?: string
}

export class AttachmentChatStrategy extends BaseChatModeStrategy {
  readonly mode = ChatMode.Attachment

  private options: Required<AttachmentChatStrategyOptions>

  constructor(options: AttachmentChatStrategyOptions = {}) {
    super()
    this.options = {
      delegateTo: options.delegateTo ?? "agentic",
      processImages: options.processImages ?? true,
      maxFileSize: options.maxFileSize ?? 50 * 1024 * 1024, // 50MB
    }
  }

  /**
   * Attachment strategy handles requests with:
   * - attachments array with items
   */
  canHandle(request: ChatRequest): boolean {
    return !!request.attachments && request.attachments.length > 0
  }

  getCapabilities(): StrategyCapability[] {
    return [
      "streaming",
      "tool-calling",
      "citations",
      "attachments",
      "multi-turn",
      "reasoning",
    ]
  }

  getContextAssembler(): ContextAssembler {
    // Use agentic assembler if delegating to agentic, otherwise normal
    if (this.options.delegateTo === "agentic") {
      return new AgenticContextAssembler(
        {
          includeHistory: true,
          includeEpisodicMemory: true,
          includeChatMemory: true,
          includeAttachments: true,
        },
        { agentId: "" }
      )
    }

    return new NormalContextAssembler({
      includeHistory: true,
      includeAttachments: true,
    })
  }

  async *execute(
    request: ChatRequest,
    context: RequestContext
  ): AsyncIterable<ChatEvent> {
    const startTime = Date.now()

    try {
      yield this.createStartEvent()

      yield this.createReasoningEvent("Processing attachments", {
        attachmentCount: request.attachments?.length,
      })

      // 1. Process attachments
      const attachmentContext = yield* this.processAttachments(request, context)

      // 2. Convert attachments to fragments
      const attachmentFragments = this.convertAttachmentsToFragments(
        attachmentContext,
        request
      )

      yield this.createMetadataEvent({
        attachmentCount: attachmentFragments.length,
        imageCount: attachmentFragments.filter((f) => f.isImage).length,
      })

      // 3. Assemble base context
      const assembler = this.getContextAssembler()
      await assembler.validate(context)
      const chatContext = await assembler.assemble(context)

      // 4. Merge attachment fragments into context
      const enrichedContext: AssembledChatContext = {
        ...chatContext,
        attachments: {
          files: attachmentContext.files.map((f) => ({
            fileId: f.fileId,
            fileName: f.fileName,
            mimeType: f.mimeType,
            isImage: f.isImage,
          })),
          fragments: attachmentFragments,
          summary: attachmentContext.summary || "",
        },
      }

      yield this.createReasoningEvent("Attachment processing complete", {
        fragmentsExtracted: attachmentFragments.length,
      })

      // 5. Delegate to appropriate strategy
      if (this.options.delegateTo === "agentic") {
        yield* this.executeAgentic(enrichedContext, attachmentFragments, context)
      } else {
        yield* this.executeNormal(enrichedContext, attachmentFragments, context)
      }

      yield this.createCompleteEvent({
        durationMs: Date.now() - startTime,
        mode: this.mode,
      })
    } catch (error) {
      yield* this.handleError(error, "ATTACHMENT_STRATEGY_ERROR")
    }
  }

  /**
   * Process file attachments
   */
  private async *processAttachments(
    request: ChatRequest,
    context: RequestContext
  ): AsyncIterable<ChatEvent> {
    const persistence = context.persistence

    if (!request.attachments || request.attachments.length === 0) {
      throw new Error("No attachments provided")
    }

    // Process attachments through persistence service
    // This would typically load file content and extract fragments
    const attachmentContext: AttachmentContext = {
      files: request.attachments.map((att) => ({
        fileId: att.fileId || "",
        fileName: att.fileName,
        mimeType: att.mimeType,
        isImage: att.mimeType?.startsWith("image/") ?? false,
      })),
      fragments: [], // Would be populated by actual file processing
      summary: "",
    }

    // In a real implementation, we would:
    // 1. Load file content from storage
    // 2. Parse/extract text based on file type
    // 3. Generate fragments
    // For now, create placeholder fragments
    for (const file of attachmentContext.files) {
      attachmentContext.fragments.push({
        id: `attachment_${file.fileId}`,
        content: `Content from file: ${file.fileName || file.fileId}`,
        source: {
          docId: file.fileId,
          title: file.fileName || "Attachment",
          app: "attachment" as any,
          entity: "File",
        },
        confidence: 1.0,
        metadata: {
          fileId: file.fileId,
          mimeType: file.mimeType,
          isImage: file.isImage,
        },
      })
    }

    yield this.createMetadataEvent({
      filesProcessed: attachmentContext.files.length,
    })

    return attachmentContext
  }

  /**
   * Convert attachments to fragments
   */
  private convertAttachmentsToFragments(
    attachmentContext: AttachmentContext,
    request: ChatRequest
  ): AttachmentFragment[] {
    const fragments: AttachmentFragment[] = []

    // Convert file fragments to attachment fragments
    for (let i = 0; i < attachmentContext.fragments.length; i++) {
      const frag = attachmentContext.fragments[i]
      const file = attachmentContext.files[i]

      fragments.push({
        ...frag,
        id: `attachment_${file.fileId}_${i}`,
        isImage: file.isImage,
        fileId: file.fileId,
        fileName: file.fileName,
        mimeType: file.mimeType,
      })
    }

    return fragments
  }

  /**
   * Execute agentic mode with attachments
   */
  private async *executeAgentic(
    chatContext: AssembledChatContext,
    attachmentFragments: AttachmentFragment[],
    requestContext: RequestContext
  ): AsyncIterable<ChatEvent> {
    // Create agentic strategy
    const agenticStrategy = new AgenticChatStrategy()

    // Execute with the enriched context
    // The agentic strategy will pick up attachments from the context
    for await (const event of agenticStrategy.execute(
      {
        message: chatContext.userMessage,
        agentId: chatContext.agentConfig?.id,
      },
      requestContext
    )) {
      yield event
    }
  }

  /**
   * Execute normal mode with attachments
   */
  private async *executeNormal(
    chatContext: AssembledChatContext,
    attachmentFragments: AttachmentFragment[],
    requestContext: RequestContext
  ): AsyncIterable<ChatEvent> {
    // Create normal strategy
    const normalStrategy = new NormalChatStrategy()

    // Execute with the enriched context
    for await (const event of normalStrategy.execute(
      { message: chatContext.userMessage },
      requestContext
    )) {
      yield event
    }
  }
}
