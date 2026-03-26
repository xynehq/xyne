/**
 * pi-mono Runtime Adapter
 * 
 * Bridges new architecture to existing @mariozechner/pi-coding-agent
 */

import type {
  AgentRuntime,
  AgentSession,
  SessionConfig,
  AgentResponse,
  EventHandler,
  Unsubscribe,
} from "./runtime.interface"

export class PiMonoRuntime implements AgentRuntime {
  async createSession(config: SessionConfig): Promise<AgentSession> {
    // Bridge to existing pi-mono session creation
    const { createAgentSession } = await import("../../../chat/pi-mono/core/runtime")
    
    const piMonoSession = await createAgentSession({
      model: config.model,
      systemPrompt: config.systemPrompt,
      tools: config.tools,
    })

    return new PiMonoSessionAdapter(piMonoSession)
  }
}

class PiMonoSessionAdapter implements AgentSession {
  readonly id: string
  private piMonoSession: any
  private handlers: EventHandler[] = []

  constructor(piMonoSession: any) {
    this.piMonoSession = piMonoSession
    this.id = piMonoSession.id

    // Subscribe to pi-mono events and forward
    this.piMonoSession.on("event", (event: any) => {
      const runtimeEvent = this.mapPiMonoEvent(event)
      this.handlers.forEach(h => h(runtimeEvent))
    })
  }

  async sendMessage(message: string): Promise<AgentResponse> {
    const result = await this.piMonoSession.sendMessage(message)
    
    return {
      content: result.content,
      toolCalls: result.toolCalls?.map((tc: any) => ({
        id: tc.id,
        tool: tc.name,
        arguments: tc.arguments,
      })),
      finishReason: this.mapFinishReason(result.finishReason),
    }
  }

  subscribe(handler: EventHandler): Unsubscribe {
    this.handlers.push(handler)
    return () => {
      const index = this.handlers.indexOf(handler)
      if (index > -1) {
        this.handlers.splice(index, 1)
      }
    }
  }

  stop(): void {
    this.piMonoSession.stop()
    this.handlers = []
  }

  private mapPiMonoEvent(event: any): import("./runtime.interface").RuntimeEvent {
    switch (event.type) {
      case "content":
        return { type: "token", content: event.content }
      case "tool_call":
        return {
          type: "tool-call",
          call: {
            id: event.callId,
            tool: event.toolName,
            arguments: event.arguments,
          },
        }
      case "error":
        return { type: "error", error: new Error(event.message) }
      case "complete":
        return { type: "complete", finishReason: event.finishReason }
      default:
        return { type: "token", content: "" }
    }
  }

  private mapFinishReason(reason: string): "stop" | "tool-calls" | "length" | "error" {
    switch (reason) {
      case "stop":
        return "stop"
      case "tool_calls":
        return "tool-calls"
      case "length":
        return "length"
      default:
        return "error"
    }
  }
}
