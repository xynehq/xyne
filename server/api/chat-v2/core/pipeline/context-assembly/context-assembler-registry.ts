/**
 * Context Assembler Registry
 * 
 * Maps chat modes to appropriate assemblers
 */

import type { ContextAssembler } from "./context-assembler.interface"
import type { ChatMode } from "../../strategies/chat-mode-strategy"

export class ContextAssemblerRegistry {
  private assemblers = new Map<ChatMode, ContextAssembler>()
  private defaultAssembler: ContextAssembler | undefined
  
  /**
   * Register an assembler for a chat mode
   */
  register(mode: ChatMode, assembler: ContextAssembler): void {
    if (this.assemblers.has(mode)) {
      console.warn(`Assembler for mode "${mode}" already registered, overwriting`)
    }
    this.assemblers.set(mode, assembler)
  }
  
  /**
   * Set default assembler
   */
  setDefault(assembler: ContextAssembler): void {
    this.defaultAssembler = assembler
  }
  
  /**
   * Get assembler for mode
   */
  get(mode: ChatMode): ContextAssembler | undefined {
    return this.assemblers.get(mode)
  }
  
  /**
   * Get assembler or throw
   */
  getOrThrow(mode: ChatMode): ContextAssembler {
    const assembler = this.get(mode) ?? this.defaultAssembler
    if (!assembler) {
      throw new Error(`No assembler registered for mode "${mode}" and no default set`)
    }
    return assembler
  }
  
  /**
   * Check if mode has registered assembler
   */
  has(mode: ChatMode): boolean {
    return this.assemblers.has(mode)
  }
  
  /**
   * Get all registered modes
   */
  getRegisteredModes(): ChatMode[] {
    return Array.from(this.assemblers.keys())
  }
  
  /**
   * Unregister assembler
   */
  unregister(mode: ChatMode): boolean {
    return this.assemblers.delete(mode)
  }
}

export const contextAssemblerRegistry = new ContextAssemblerRegistry()
