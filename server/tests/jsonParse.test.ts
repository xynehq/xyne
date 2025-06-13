import { jsonParseLLMOutput } from "@/ai/provider"
import { describe, expect, test } from "bun:test"

describe("jsonParseLLMOutput", () => {
  test("should parse valid JSON object", () => {
    const input = '{"answer": "Some random answer"}'
    const result = jsonParseLLMOutput(input)
    expect(result).toEqual({ answer: "Some random answer" })
  })

  test("should handle JSON in code blocks", () => {
    const input = '```json\n{"name": "test"}\n```'
    const result = jsonParseLLMOutput(input)
    expect(result).toEqual({ name: "test" })
  })

  test("should handle multi-line content", () => {
    const input = `{
      "answer": "##Specify all the alternatives of a **choice** as a mapping 
      A map is a convenience shorthand"
    }`
    const result = jsonParseLLMOutput(input)
    expect(result).toEqual({
      answer:
        "##Specify all the alternatives of a **choice** as a mapping \n      A map is a convenience shorthand",
    })
  })

  test("should handle empty input", () => {
    expect(jsonParseLLMOutput("")).toBe("")
    expect(jsonParseLLMOutput("   ")).toBe("")
  })

  test("should handle JSON with comments", () => {
    const input = `{
      "answer": "test" // Another comment
    }`
    const result = jsonParseLLMOutput(input)
    expect(result).toEqual({ answer: "test" })
  })

  test("should handle nested objects", () => {
    const input = `{
      "answer": {
        "name": "John",
        "details": {
          "age": 30,
          "city": "New York"
        }
      }
    }`
    const result = jsonParseLLMOutput(input)
    expect(result).toEqual({
      answer: {
        name: "John",
        details: {
          age: 30,
          city: "New York",
        },
      },
    })
  })

  test("should handle arrays", () => {
    const input = `{
      "answer": [1, 2, 3]
    }`
    const result = jsonParseLLMOutput(input)
    expect(result).toEqual({
      answer: [1, 2, 3],
    })
  })

  test("should handle carriage returns", () => {
    const input = `{
      "content": "Line 1\r\nLine 2\r\nLine 3"
    }`
    const result = jsonParseLLMOutput(input)
    expect(result).toEqual({ content: "Line 1\r\nLine 2\r\nLine 3" })
  })

  test("should handle missing initial brace and leading whitespace", () => {
    const input = '   "answer": "some value"}'
    const ANSWER_TOKEN = '"answer":'
    const result = jsonParseLLMOutput(input, ANSWER_TOKEN)
    expect(result).toEqual({ answer: "some value" })
  })

  test("should handle missing initial brace and trailing content after brace", () => {
    const input = '   "answer": "some value"} some trailing text'
    const ANSWER_TOKEN = '"answer":'
    const result = jsonParseLLMOutput(input, ANSWER_TOKEN)
    expect(result).toEqual({ answer: "some value" })
  })

  test("should handle plain text input and wrap it in an answer object", () => {
    const input = "This is a plain text answer."
    const ANSWER_TOKEN = '"answer":'
    const result = jsonParseLLMOutput(input, ANSWER_TOKEN)
    console.debug(result)
    expect(result).toEqual({ answer: "This is a plain text answer." })
  })

  test("all correct execept end curly brace", () => {
    const input = '{"answer": "This is a plain text answer."'
    const ANSWER_TOKEN = '"answer":'
    const result = jsonParseLLMOutput(input, ANSWER_TOKEN)
    expect(result).toEqual({ answer: "This is a plain text answer." })
  })

  test("backslash would get replaced by Quotes due to partial library", () => {
    const input = '{"answer": "This is a plain text answer \\\\"}' //Extra Backslash added as an escape character, thus 4 backslashes
    const ANSWER_TOKEN = '"answer":'
    const result = jsonParseLLMOutput(input, ANSWER_TOKEN)
    expect(result).toEqual({ answer: "This is a plain text answer \\" })
  })
  test("should handle text with quotes when using jsonKey", () => {
    const text = 'This is a "quoted" text that should not break'
    const result = jsonParseLLMOutput(text, '"answer":')
    expect(result).toEqual({
      answer: 'This is a "quoted" text that should not break',
    })
  })

  test("should handle text with curly braces when using jsonKey", () => {
    const text = "This text has {braces} in it"
    const result = jsonParseLLMOutput(text, '"answer":')
    expect(result).toEqual({
      answer: "This text has {braces} in it",
    })
  })

  test("should handle text with both quotes and braces when using jsonKey", () => {
    const text = 'Answer is "hello {world}" and more text'
    const result = jsonParseLLMOutput(text, '"answer":')
    expect(result).toEqual({
      answer: 'Answer is "hello {world}" and more text',
    })
  })

  test("should handle markdown text with bullets and formatting when using jsonKey", () => {
    const text = `Imagine you're a chef joining a high-end restaurant. Before you can cook, you need:
- Access to the kitchen (repository access)
- The right knives and tools (development setup)
- Knowledge of where ingredients are stored (codebase structure)
- Understanding of the kitchen's systems (build processes)
**Setting up Euler PS is the same process** - preparing your development "kitchen" for payment orchestration work.
### Prerequisites You'll Need:`
    const result = jsonParseLLMOutput(text, '"answer":')
    expect(result).toEqual({
      answer: text,
    })
  })

  test("string not closed and multiline inside answer key", () => {
    const input = `{
    "answer": "This is a plain text answer.
    `
    const ANSWER_TOKEN = '"answer":'
    const result = jsonParseLLMOutput(input, ANSWER_TOKEN)
    expect(result).toEqual({ answer: "This is a plain text answer." })
  })
  test("no start brace, tripple backticks at end", () => {
    const input = `"answer": "This is a plain text answer."
  }
    \`\`\``
    const ANSWER_TOKEN = '"answer":'
    const result = jsonParseLLMOutput(input, ANSWER_TOKEN)
    expect(result).toEqual({ answer: "This is a plain text answer." })
  })
  test("no start brace, tripple backticks at end and answer null", () => {
    const input = `"answer": null
  }
\`\`\``
    const ANSWER_TOKEN = '"answer":'
    const result = jsonParseLLMOutput(input, ANSWER_TOKEN)
    expect(result.answer).toEqual(null)
  })

  test("should handle unterminated string with newlines and convert newlines to spaces in value", () => {
    const input = `{
  "answer": "kalp
and for this one"}
`
    const ANSWER_TOKEN = '"answer":'
    const result = jsonParseLLMOutput(input, ANSWER_TOKEN)
    expect(result).toEqual({ answer: "kalp\nand for this one" })
  })

  test("should handle ```json prefix without newline before JSON object", () => {
    const input = '```json{"name": "direct"}'
    const result = jsonParseLLMOutput(input)
    expect(result).toEqual({ name: "direct" })
  })

  test("should handle JSON with a full line comment before a key-value pair", () => {
    const input = `{
      // This is a full line comment explaining the answer
      "answer": "The value itself is simple."
    }`
    const ANSWER_TOKEN = '"answer":'
    const result = jsonParseLLMOutput(input, ANSWER_TOKEN)
    expect(result).toEqual({ answer: "The value itself is simple." })
  })

  test("should handle text with quotes when using jsonKey", () => {
    const text = 'This is a "quoted" text that should not break'
    const result = jsonParseLLMOutput(text, '"answer":')
    expect(result).toEqual({
      answer: 'This is a "quoted" text that should not break',
    })
  })

  test("should handle text with curly braces when using jsonKey", () => {
    const text = "This text has {braces} in it"
    const result = jsonParseLLMOutput(text, '"answer":')
    expect(result).toEqual({
      answer: "This text has {braces} in it",
    })
  })

  test("should handle text with both quotes and braces when using jsonKey", () => {
    const text = 'Answer is "hello {world}" and more text'
    const result = jsonParseLLMOutput(text, '"answer":')
    expect(result).toEqual({
      answer: 'Answer is "hello {world}" and more text',
    })
  })

  test("should handle markdown text with bullets and formatting when using jsonKey", () => {
    const text = `Imagine you're a chef joining a high-end restaurant. Before you can cook, you need:
- Access to the kitchen (repository access)
- The right knives and tools (development setup)
- Knowledge of where ingredients are stored (codebase structure)
- Understanding of the kitchen's systems (build processes)
**Setting up Euler PS is the same process** - preparing your development "kitchen" for payment orchestration work.
### Prerequisites You'll Need:`
    const result = jsonParseLLMOutput(text, '"answer":')
    expect(result).toEqual({
      answer: text,
    })
  })

  test("should handle code blocks with triple backticks when using jsonKey", () => {
    const text = `\`\`\`purescript
-- Order represents the fundamental transaction unit
type Order = {
   orderId :: OrderId
  , merchantId :: MerchantId
  , amount :: Amount
  , currency :: Currency
  , status :: OrderStatus
  , paymentMethods :: Array PaymentMethod
  , createdAt :: DateTime
  , updatedAt :: DateTime
  }
-- Payment method abstraction
data PaymentMethod
  = Card CardDetails
  | UPI UPIDetails
  | NetBanking BankCode
  | Wallet WalletProvider
\`\`\``
    const result = jsonParseLLMOutput(text, '"answer":')
    expect(result).toEqual({
      answer: text,
    })
  })

  test("should handle complex markdown content starting with headers when using jsonKey", () => {
    const text = `## 🔧 Concept D.3: Debugging Transaction Issues

**Technical Overview:**
Debugging transaction issues in Euler involves systematic investigation of payment flows using multiple tools and techniques. This includes analyzing logs, tracking process flows, examining gateway responses, and understanding transaction state transitions to identify root causes of failures [28].

**Real-world Example:**
Debugging a payment transaction is like being a medical doctor diagnosing a patient. You gather symptoms (error messages), check vital signs (system metrics), review medical history (transaction logs), run tests (reproduce the issue), and systematically eliminate possibilities until you find the root cause.

**Essential Debugging Tools:**

1. **Process Tracker** - Monitor transaction state transitions and workflow progression
2. **Log Viewer** - Examine detailed execution logs across services  
3. **Session ID Tracking** - Follow complete transaction journeys`
    const result = jsonParseLLMOutput(text, '"answer":')
    expect(result).toEqual({
      answer: text,
    })
  })
})
