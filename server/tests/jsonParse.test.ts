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

  test("should handle escaped JSON response from AI model", () => {
    const input = `\\n{\\n  \\"answer\\": \\"Based on the Euler onboarding resources, here are the structured next steps in the Juspay onboarding process:\\n\\n## **Module 0: Prerequisites**\\n- **Express Checkout and Payment Orchestration** - Understanding Euler flow and payment orchestration [27]\\n- **Key Terminology and Concepts** - Learning payment flow diagrams and core concepts [27]\\"\\n}`
    const result = jsonParseLLMOutput(input)
    expect(result).toEqual({
      answer:
        "Based on the Euler onboarding resources, here are the structured next steps in the Juspay onboarding process:\n\n## **Module 0: Prerequisites**\n- **Express Checkout and Payment Orchestration** - Understanding Euler flow and payment orchestration [27]\n- **Key Terminology and Concepts** - Learning payment flow diagrams and core concepts [27]",
    })
  })

  test('should handle escaped JSON with \\"answer\\" pattern', () => {
    const input = `{\\"answer\\": \\"This is a test with escaped quotes and\\nnewlines\\"}`
    const result = jsonParseLLMOutput(input)
    expect(result).toEqual({
      answer: "This is a test with escaped quotes and\nnewlines",
    })
  })

  test("should handle JSON response with escaped quotes and literal newlines from AI model", () => {
    const response = `\`\`\`json\n{\n  \"answer\": \"Based on the Euler onboarding resources, here are the structured next steps in the Juspay onboarding process:\n\n## **Module 0: Prerequisites**\n- **Express Checkout and Payment Orchestration** - Understanding Euler flow and payment orchestration [27]\n- **Key Terminology and Concepts** - Learning payment flow diagrams and core concepts [27]\n\n## **Module A: Getting Ready with Tools**\n- **Setting Up Euler PS** - Clone the Euler PS project from Bitbucket [27]\n- **Dashboard Access** - Get access to Grafana, EC Ops (Production & Sandbox), and Kibana [27]\n- **SQL and Data Access Tools** - Set up MySQL Web and BigQuery access [27]\n- **Postman Collection Setup** - Download Postman and import Euler API collections [27]\n\n## **Module D: System Operations**\n- **Monitoring with Grafana and EC Ops Dashboard** - Learn system monitoring [27]\n- **Log Analysis with Kibana** - Understanding log analysis and debugging [27]\n- **Debugging Transaction Issues** - Using Process Tracker and Sentry [27]\n\n## **Module E: Domain-Specific Flows**\n- **UPI Variants** - Understanding Intent and Collect flows [27]\n\n## **Module F: Code Architecture**\n- **PureScript and Haskell Introduction** - Learning the core programming languages [27]\n- **Merchant Integration Patterns** - Understanding integration approaches [27]\n- **Code Structure and Organization** - System walkthrough sessions [27]\n\nThe onboarding appears to follow a progressive structure from basic setup to advanced domain knowledge. You should start with Module 0 prerequisites and work through the modules systematically.\"\n}\n\`\`\``

    const result = jsonParseLLMOutput(response)

    expect(result).toEqual({
      answer: `Based on the Euler onboarding resources, here are the structured next steps in the Juspay onboarding process:

## **Module 0: Prerequisites**
- **Express Checkout and Payment Orchestration** - Understanding Euler flow and payment orchestration [27]
- **Key Terminology and Concepts** - Learning payment flow diagrams and core concepts [27]

## **Module A: Getting Ready with Tools**
- **Setting Up Euler PS** - Clone the Euler PS project from Bitbucket [27]
- **Dashboard Access** - Get access to Grafana, EC Ops (Production & Sandbox), and Kibana [27]
- **SQL and Data Access Tools** - Set up MySQL Web and BigQuery access [27]
- **Postman Collection Setup** - Download Postman and import Euler API collections [27]

## **Module D: System Operations**
- **Monitoring with Grafana and EC Ops Dashboard** - Learn system monitoring [27]
- **Log Analysis with Kibana** - Understanding log analysis and debugging [27]
- **Debugging Transaction Issues** - Using Process Tracker and Sentry [27]

## **Module E: Domain-Specific Flows**
- **UPI Variants** - Understanding Intent and Collect flows [27]

## **Module F: Code Architecture**
- **PureScript and Haskell Introduction** - Learning the core programming languages [27]
- **Merchant Integration Patterns** - Understanding integration approaches [27]
- **Code Structure and Organization** - System walkthrough sessions [27]

The onboarding appears to follow a progressive structure from basic setup to advanced domain knowledge. You should start with Module 0 prerequisites and work through the modules systematically.`,
    })
  })
})
