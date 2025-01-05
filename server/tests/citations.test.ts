import { processMessage, textToCitationIndex } from "@/api/chat"
import { describe, expect, test } from "bun:test"

describe("basic citation system", () => {
  test("should extract single citation", () => {
    const text = "This is a reference[1] in text"
    const matches = Array.from(text.matchAll(textToCitationIndex))
    expect(matches).toHaveLength(1)
    expect(matches[0][1]).toBe("1")
  })
  test("should extract multiple citations", () => {
    const text = "Multiple citations[1] in this[2] text[3]"
    const matches = Array.from(text.matchAll(textToCitationIndex))
    expect(matches).toHaveLength(3)
    expect(matches.map(m => m[1])).toEqual(["1", "2", "3"])
  })
  test("should handle adjacent citations", () => {
    const text = "Adjacent citations[1][2][3]here"
    const matches = Array.from(text.matchAll(textToCitationIndex))
    expect(matches).toHaveLength(3)
  })
  test("should ignore malformed citations", () => {
    const text = "Ignore these [a] [1.2] [--1] but catch this[1]"
    const matches = Array.from(text.matchAll(textToCitationIndex))
    expect(matches).toHaveLength(1)
    expect(matches[0][1]).toBe("1")
  })
})

describe("citation processing", () => {
  test("should process message with citation map", () => {
    const text = "See references[1] and[2] here[3]"
    const citationMap = { 1: 0, 2: 1, 3: 2 }
    const processed = processMessage(text, citationMap)
    expect(processed).toBe("See references[1] and[2] here[3]")
  })
  test("should handle non-sequential citation mapping", () => {
    const text = "First[1] and third[3] citation"
    const citationMap = { 1: 0, 3: 1 }
    const processed = processMessage(text, citationMap)
    expect(processed).toBe("First[1] and third[2] citation")
  })

  test("should handle missing citation indices", () => {
    const text = "Valid[1] and invalid[5] citations"
    const citationMap = { 1: 0 }
    const processed = processMessage(text, citationMap)
    console.log(processed)
    // Should preserve the original citation if not in map
    expect(processed).toBe("Valid[1] and invalid citations")
  })
})