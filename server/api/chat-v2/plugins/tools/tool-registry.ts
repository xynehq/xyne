/**
 * Tool Registry - Manages tool registration and discovery
 * 
 * REPLACES: buildXyneTools() function in message-agents.ts
 * BENEFITS:
 *   - Dynamic tool registration
 *   - Scoped tool availability per mode
 *   - Tool versioning
 *   - Easy to test (inject mock registry)
 */

import type { Tool, ToolMetadata } from "./tool.interface"
import type { RequestContextLike as RequestContext } from "../../core/orchestrator/request-context.types"
import type { ChatMode } from "../../core/strategies/chat-mode-strategy"

/**
 * Tool filter for selecting subset of tools
 */
export interface ToolFilter {
  categories?: string[]
  names?: string[]
  modes?: ChatMode[]
  availableInContext?: RequestContext
}

/**
 * Tool registry for managing available tools
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>()
  private metadata = new Map<string, ToolMetadata>()
  private modeTools = new Map<ChatMode, Set<string>>()
  
  /**
   * Register a tool
   */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      console.warn(`Tool "${tool.name}" already registered, overwriting`)
    }
    
    this.tools.set(tool.name, tool)
    this.metadata.set(tool.name, {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      category: tool.category || "utility",
      version: tool.version || "1.0.0",
    })
  }
  
  /**
   * Register multiple tools
   */
  registerMany(tools: Tool[]): void {
    for (const tool of tools) {
      this.register(tool)
    }
  }
  
  /**
   * Associate tools with a chat mode
   */
  registerForMode(mode: ChatMode, toolNames: string[]): void {
    const existing = this.modeTools.get(mode) || new Set()
    for (const name of toolNames) {
      if (!this.tools.has(name)) {
        throw new Error(`Cannot register non-existent tool "${name}" for mode "${mode}"`)
      }
      existing.add(name)
    }
    this.modeTools.set(mode, existing)
  }
  
  /**
   * Get a tool by name
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }
  
  /**
   * Check if tool exists
   */
  has(name: string): boolean {
    return this.tools.has(name)
  }
  
  /**
   * Get all registered tools
   */
  getAll(): Tool[] {
    return Array.from(this.tools.values())
  }
  
  /**
   * Get all tool names
   */
  getNames(): string[] {
    return Array.from(this.tools.keys())
  }
  
  /**
   * Get tools for a specific mode
   */
  getForMode(mode: ChatMode): Tool[] {
    const toolNames = this.modeTools.get(mode)
    if (!toolNames) {
      return []
    }
    
    return Array.from(toolNames)
      .map(name => this.tools.get(name))
      .filter((tool): tool is Tool => tool !== undefined)
  }
  
  /**
   * Get tools available in context (respects isAvailable)
   */
  getAvailable(context: RequestContext): Tool[] {
    return this.getAll().filter(tool => {
      if (tool.isAvailable) {
        return tool.isAvailable(context)
      }
      return true
    })
  }
  
  /**
   * Filter tools based on criteria
   */
  filter(filter: ToolFilter): Tool[] {
    let tools = this.getAll()
    
    if (filter.names) {
      tools = tools.filter(t => filter.names!.includes(t.name))
    }
    
    if (filter.categories) {
      tools = tools.filter(t => 
        t.category && filter.categories!.includes(t.category)
      )
    }
    
    if (filter.modes) {
      const modeToolNames = new Set<string>()
      for (const mode of filter.modes) {
        const names = this.modeTools.get(mode)
        if (names) {
          names.forEach(n => modeToolNames.add(n))
        }
      }
      tools = tools.filter(t => modeToolNames.has(t.name))
    }
    
    if (filter.availableInContext) {
      tools = tools.filter(t => {
        if (t.isAvailable) {
          return t.isAvailable(filter.availableInContext!)
        }
        return true
      })
    }
    
    return tools
  }
  
  /**
   * Get tool metadata
   */
  getMetadata(name: string): ToolMetadata | undefined {
    return this.metadata.get(name)
  }
  
  /**
   * Get all metadata
   */
  getAllMetadata(): ToolMetadata[] {
    return Array.from(this.metadata.values())
  }
  
  /**
   * Unregister a tool
   */
  unregister(name: string): boolean {
    this.metadata.delete(name)
    // Remove from mode associations
    for (const [mode, tools] of this.modeTools) {
      tools.delete(name)
    }
    return this.tools.delete(name)
  }
  
  /**
   * Clear all tools
   */
  clear(): void {
    this.tools.clear()
    this.metadata.clear()
    this.modeTools.clear()
  }
  
  /**
   * Get count of registered tools
   */
  get count(): number {
    return this.tools.size
  }
}

/**
 * Singleton instance
 */
export const toolRegistry = new ToolRegistry()
