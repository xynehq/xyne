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

export const promptSections = {
  identity: (name: string, description: string): PromptSection => ({
    name: "identity",
    priority: 0,
    content: `You are ${name}, ${description}.`,
  }),

  context: (data: Record<string, string>): PromptSection => ({
    name: "context",
    priority: 10,
    content: Object.entries(data)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n"),
  }),

  tools: (toolNames: string[]): PromptSection => ({
    name: "tools",
    priority: 20,
    content: `You have access to the following tools:\n${toolNames.map((t) => `- ${t}`).join("\n")}`,
  }),

  instructions: (instructions: string[]): PromptSection => ({
    name: "instructions",
    priority: 30,
    content: instructions.join("\n"),
  }),

  constraints: (constraints: string[]): PromptSection => ({
    name: "constraints",
    priority: 40,
    content: `# CONSTRAINTS\n${constraints.join("\n")}`,
  }),
}
