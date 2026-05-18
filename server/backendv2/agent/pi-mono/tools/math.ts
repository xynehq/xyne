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

const BINARY_OPS = new Set(["add", "subtract", "multiply", "divide"])
const REQUIRE_NONEMPTY = new Set(["sum", "avg", "min", "max"])

// Truncate long arrays in the human-readable string so the LLM doesn't pay
// for thousands of tokens echoing its own input back. The full array is
// preserved in `details` for tracing/UI.
const formatValues = (values: number[]): string => {
  if (values.length <= 8) {
    return `[${values.join(", ")}]`
  }
  const head = values.slice(0, 4).join(", ")
  const tail = values.slice(-2).join(", ")
  return `[${head}, …, ${tail}] (N=${values.length})`
}

export const mathTool = defineTool({
  name: "math",
  label: "Math",
  description:
    "Perform a single arithmetic or aggregate operation on numbers. " +
    "Binary ops (add, subtract, multiply, divide) require exactly 2 values; " +
    "subtract and divide are non-commutative — values=[a, b] means a-b / a/b. " +
    "Aggregates: sum, avg, min, max need at least 1 value; count and " +
    "count_distinct accept an empty array.",
  promptSnippet:
    "Use `math` for arithmetic or aggregates over numeric values. Always pass `values` as an array of numbers; the `operation` field picks the op.",
  parameters: Type.Object({
    operation: Type.Union(
      [
        Type.Literal("add"),
        Type.Literal("subtract"),
        Type.Literal("multiply"),
        Type.Literal("divide"),
        Type.Literal("sum"),
        Type.Literal("avg"),
        Type.Literal("count"),
        Type.Literal("min"),
        Type.Literal("max"),
        Type.Literal("count_distinct"),
      ],
      { description: "Which operation to perform." },
    ),
    values: Type.Array(Type.Number(), {
      description:
        "Operands. Binary ops (add/subtract/multiply/divide) require exactly 2. Aggregates: sum/avg/min/max need 1+; count/count_distinct accept 0+. For subtract: [a, b] → a - b. For divide: [a, b] → a / b.",
    }),
  }),
  // eslint-disable-next-line @typescript-eslint/require-await
  async execute(_toolCallId, params) {
    const { operation, values } = params

    if (values.some((v) => !Number.isFinite(v))) {
      return errorResult(
        `Refused: values must all be finite numbers.`,
        "non_finite_operand",
      )
    }

    if (BINARY_OPS.has(operation) && values.length !== 2) {
      return errorResult(
        `Refused: '${operation}' requires exactly 2 values; got ${String(values.length)}.`,
        "wrong_arity",
      )
    }

    if (REQUIRE_NONEMPTY.has(operation) && values.length === 0) {
      return errorResult(
        `Refused: '${operation}' requires at least 1 value.`,
        "empty_input",
      )
    }

    let value: number
    let pretty: string

    switch (operation) {
      case "add":
      case "subtract":
      case "multiply":
      case "divide": {
        // Arity already enforced above; destructure with a defensive guard
        // to satisfy noUncheckedIndexedAccess.
        const [a, b] = values
        if (a === undefined || b === undefined) {
          return errorResult(
            `Refused: '${operation}' requires exactly 2 values.`,
            "wrong_arity",
          )
        }
        if (operation === "divide" && b === 0) {
          return errorResult("Refused: division by zero.", "division_by_zero")
        }
        const symbol =
          operation === "add"
            ? "+"
            : operation === "subtract"
              ? "-"
              : operation === "multiply"
                ? "*"
                : "/"
        value =
          operation === "add"
            ? a + b
            : operation === "subtract"
              ? a - b
              : operation === "multiply"
                ? a * b
                : a / b
        pretty = `${String(a)} ${symbol} ${String(b)} = ${String(value)}`
        break
      }
      case "sum":
        value = values.reduce((acc, v) => acc + v, 0)
        pretty = `sum(${formatValues(values)}) = ${String(value)}`
        break
      case "avg":
        value = values.reduce((acc, v) => acc + v, 0) / values.length
        pretty = `avg(${formatValues(values)}) = ${String(value)}`
        break
      case "count":
        value = values.length
        pretty = `count(${formatValues(values)}) = ${String(value)}`
        break
      case "min":
        value = Math.min(...values)
        pretty = `min(${formatValues(values)}) = ${String(value)}`
        break
      case "max":
        value = Math.max(...values)
        pretty = `max(${formatValues(values)}) = ${String(value)}`
        break
      case "count_distinct":
        // Exact equality via Set — fine for integers; for floats note that
        // 0.1+0.2 !== 0.3, so distinctness is bit-exact, not numeric.
        value = new Set(values).size
        pretty = `count_distinct(${formatValues(values)}) = ${String(value)}`
        break
    }

    return textResult(pretty, { operation, values, value })
  },
})
