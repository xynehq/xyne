import type { ToolFailureInfo } from "./agent-schemas"

const MAX_FAILURES = 3
const COOLDOWN_TURNS = 3

/**
 * Manages tool failure tracking, cooldown, and automatic recovery.
 * Wraps the context's failedTools map — mutations are reflected on the context.
 *
 * Uses `string` for tool names because JAF provides all tool names as plain
 * strings at runtime. XyneTools is used only at call sites where the name is
 * written in source (e.g. comparisons and schema definitions).
 */
export class ToolCooldownManager {
  constructor(private failures: Map<string, ToolFailureInfo>) {}

  recordFailure(toolName: string, error: string, currentTurn: number): boolean {
    const existing = this.failures.get(toolName) || {
      count: 0,
      lastError: "",
      lastAttempt: 0,
      cooldownUntilTurn: 0,
    }
    const newCount = existing.count + 1
    const enteringCooldown = newCount >= MAX_FAILURES && existing.count < MAX_FAILURES
    this.failures.set(toolName, {
      count: newCount,
      lastError: error,
      lastAttempt: Date.now(),
      cooldownUntilTurn: newCount >= MAX_FAILURES
        ? currentTurn + COOLDOWN_TURNS
        : existing.cooldownUntilTurn,
    })
    return enteringCooldown
  }

  isInCooldown(toolName: string, currentTurn: number): boolean {
    const info = this.failures.get(toolName)
    if (!info) return false
    return info.count >= MAX_FAILURES && currentTurn < info.cooldownUntilTurn
  }

  getCooldownInfo(toolName: string): ToolFailureInfo | undefined {
    return this.failures.get(toolName)
  }

  getAvailableTools<T extends { schema: { name: string } }>(
    tools: T[],
    currentTurn: number
  ): T[] {
    return tools.filter((t) => !this.isInCooldown(t.schema.name, currentTurn))
  }

  recoverExpiredTools(currentTurn: number): string[] {
    const recovered: string[] = []
    for (const [name, info] of this.failures) {
      if (info.count >= MAX_FAILURES && currentTurn >= info.cooldownUntilTurn) {
        info.count = 0
        info.cooldownUntilTurn = 0
        recovered.push(name)
      }
    }
    return recovered
  }
}
