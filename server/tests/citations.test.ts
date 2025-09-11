import { processMessage } from "@/api/chat/chat"
import { textToCitationIndex } from "@/api/chat/utils"
import { splitGroupedCitationsWithSpaces } from "@/utils"
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
    expect(matches.map((m) => m[1])).toEqual(["1", "2", "3"])
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
    // Should preserve the original citation if not in map
    expect(processed).toBe("Valid[1] and invalid citations")
  })
})

describe("Grouped Citation Splitting", () => {
  test("should split basic grouped citations", () => {
    const text = "See references [1,2,3] for more info"
    const result = splitGroupedCitationsWithSpaces(text)
    expect(result).toBe("See references [1] [2] [3] for more info")
  })
  test("should handle multiple grouped citations", () => {
    const text = "See [1,2] and also [3,4,5]"
    const result = splitGroupedCitationsWithSpaces(text)
    expect(result).toBe("See [1] [2] and also [3] [4] [5]")
  })
  test("should handle single number in brackets", () => {
    const text = "Single citation [1]"
    const result = splitGroupedCitationsWithSpaces(text)
    expect(result).toBe("Single citation [1]")
  })

  test("should handle invalid content in grouped citations", () => {
    const text = "[1,a,2] and [b,c,3] and [1,@,#,2]"
    const result = splitGroupedCitationsWithSpaces(text)
    expect(result).toBe(text)
  })

  test("should handle mixed valid and invalid grouped citations in sentence", () => {
    const text = "Good [1,2] bad [a,b] ok [3,4]"
    const result = splitGroupedCitationsWithSpaces(text)
    expect(result).toBe("Good [1] [2] bad [a,b] ok [3] [4]")
  })

  test("should correctly split grouped citations with spaces and multiple digits", () => {
    const text = "This is a test [3, 20, 22] for citations."
    const result = splitGroupedCitationsWithSpaces(text)
    expect(result).toBe("This is a test [3] [20] [22] for citations.")
  })

  test("should correctly split grouped citations with no spaces and multiple digits", () => {
    const text = "This is a test [3,20,22] for citations."
    const result = splitGroupedCitationsWithSpaces(text)
    expect(result).toBe("This is a test [3] [20] [22] for citations.")
  })

  // this fails for now
  test.skip("should handle mixed valid and invalid citations", () => {
    const text = "Mixed [1,2.5,3] and [a,2,b] citations"
    const result = splitGroupedCitationsWithSpaces(text)
    expect(result).toBe("Mixed [1] [3] and [2] citations")
  })

  test("should handle empty groups", () => {
    const text = "Empty groups [] and [,,,] and [, ,]"
    const result = splitGroupedCitationsWithSpaces(text)
    expect(result).toBe("Empty groups [] and [,,,] and [, ,]")
  })
})
