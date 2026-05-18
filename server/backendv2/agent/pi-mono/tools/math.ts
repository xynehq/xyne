import { defineTool } from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"

type ToolReturn = {
  content: { type: "text"; text: string }[]
  details: unknown
  isError?: boolean
}

const textResult = (text: string, details: unknown = {}): ToolReturn => ({
  content: [{ type: "text", text }],
  details,
})

const errorResult = (text: string, error: string): ToolReturn => ({
  content: [{ type: "text", text }],
  details: { error },
  isError: true,
})

export const mathTool = defineTool({
  name: "math",
  label: "Math",
  description:
    "Perform a single arithmetic operation on two numbers. Supports " +
    "addition, subtraction, multiplication, and division.",
  promptSnippet:
    "Use `math` for any arithmetic on two numbers — do not compute by hand.",
  parameters: Type.Object({
    operation: Type.Union(
      [
        Type.Literal("add"),
        Type.Literal("subtract"),
        Type.Literal("multiply"),
        Type.Literal("divide"),
      ],
      { description: "Which arithmetic operation to perform." },
    ),
    a: Type.Number({ description: "Left operand." }),
    b: Type.Number({ description: "Right operand." }),
  }),
  // eslint-disable-next-line @typescript-eslint/require-await
  async execute(_toolCallId, params) {
    const { operation, a, b } = params

    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      return errorResult(
        `Refused: operands must be finite numbers (got a=${String(a)}, b=${String(b)}).`,
        "non_finite_operand",
      )
    }

    let value: number
    let symbol: string
    switch (operation) {
      case "add":
        value = a + b
        symbol = "+"
        break
      case "subtract":
        value = a - b
        symbol = "-"
        break
      case "multiply":
        value = a * b
        symbol = "*"
        break
      case "divide":
        if (b === 0) {
          return errorResult(
            "Refused: division by zero.",
            "division_by_zero",
          )
        }
        value = a / b
        symbol = "/"
        break
    }

    return textResult(`${a} ${symbol} ${b} = ${String(value)}`, {
      operation,
      a,
      b,
      value,
    })
  },
})
