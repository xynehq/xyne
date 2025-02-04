import { cleanDocs } from "@/ai/context"
import { describe, expect, test } from "bun:test"

describe("cleanDocs", () => {
  // Basic URL and formatting cleanup
  //   test('removes Google Docs image URLs', () => {
  //     const inputs = [
  //       'Text ![image](https://lh7-rt.googleusercontent.com/docsz/abc123?param=value) more text',
  //       'Multiple ![img1](https://lh7-rt.googleusercontent.com/docsz/abc) ![img2](https://lh7-rt.googleusercontent.com/docsz/xyz)',
  //       'Text![no-space](https://lh7-rt.googleusercontent.com/docsz/abc)text'
  //     ]
  //     const expected = [
  //       'Text more text',
  //       'Multiple',
  //       'Texttext'
  //     ]
  //     inputs.forEach((input, i) => {
  //       expect(cleanDocs(input)).toBe(expected[i])
  //     })
  //   })

  // Whitespace and newline handling
  test("handles whitespace and newlines properly", () => {
    const inputs = [
      "Line 1\n\n\nLine 2",
      "Line 1\n    \n\nLine 2",
      "Text    with    spaces",
      " Leading and trailing spaces ",
      "Tab\t\tspaces",
    ]
    const expected = [
      "Line 1 Line 2",
      "Line 1 Line 2",
      "Text with spaces",
      "Leading and trailing spaces",
      "Tab spaces",
    ]
    inputs.forEach((input, i) => {
      expect(cleanDocs(input)).toBe(expected[i])
    })
  })

  // Ellipsis and dot patterns
  test("handles ellipsis and dot patterns correctly", () => {
    const inputs = [
      "Text.... more",
      "Sentence ending...Next sentence",
      "Multiple........dots",
    ]
    const expected = [
      "Text  more",
      "Sentence ending Next sentence",
      "Multiple dots",
    ]
    inputs.forEach((input, i) => {
      expect(cleanDocs(input)).toBe(expected[i])
    })
  })

  // Currency and number formatting
  test("handles currency and numbers correctly", () => {
    const inputs = [
      "$480.00",
      "$1,234.56",
      "$128,000.1",
      "$1,000,000.00",
      "1.0e-10",
      "0.123",
      "$0.50",
      "$1234.00",
      "$.50",
      "$1,234,567.89",
    ]
    const expected = [
      "$480.00",
      "$1,234.56",
      "$128,000.1",
      "$1,000,000.00",
      "1.0e-10",
      "0.123",
      "$0.50",
      "$1234.00",
      "$.50",
      "$1,234,567.89",
    ]
    inputs.forEach((input, i) => {
      expect(cleanDocs(input)).toBe(expected[i])
    })
  })

  // Repetitive patterns
  test("handles repetitive patterns correctly", () => {
    const inputs = ["Text .0.0.0.0 more", "Number.0.0.0.0.0"]
    const expected = ["Text more", "Number"]
    inputs.forEach((input, i) => {
      expect(cleanDocs(input)).toBe(expected[i])
    })
  })

  // Control characters
  test("removes control characters while preserving valid text", () => {
    const inputs = [
      "Text\x00\x1F\x7F\x9Fmore",
      "\x00Start\x1FMiddle\x7FEnd\x9F",
      "Mixed\x00Text\x1FWith\x7FControl\x9FChars",
    ]
    const expected = ["Textmore", "StartMiddleEnd", "MixedTextWithControlChars"]
    inputs.forEach((input, i) => {
      expect(cleanDocs(input)).toBe(expected[i])
    })
  })

  // UTF characters
  test("handles UTF characters appropriately", () => {
    const inputs = [
      `Text\uE907bad\uFFFDchars`,
      `Multiple\uE907\uE907\uFFFD\uFFFDChars`,
      `Mixed\uE907Text\uFFFDWith\uE907Bad\uFFFDChars`,
      // Valid UTF characters should be preserved
      "你好,世界",
      "❤️🌟✨",
    ]
    const expected = [
      "Textbadchars",
      "MultipleChars",
      "MixedTextWithBadChars",
      "你好,世界",
      "❤️🌟✨",
    ]
    inputs.forEach((input, i) => {
      expect(cleanDocs(input)).toBe(expected[i])
    })
  })

  // Complex real-world cases
  test("handles complex real-world cases correctly", () => {
    const inputs = [
      // Google Docs paste with multiple issues
      "Summary:\x00\x1F ![img](https://lh7-rt.googleusercontent.com/docsz/abc123)... Key points:",
      // Price list with various formats
      "Product A.... $480.00\nProduct B.... $1,234.56\nProduct C.... $128,000.1",
      // Scientific notation and patterns
      "Measurement: 1.0e-10.... Precision: .0.0.0.0\nValue: $1,234.00",
      // Mixed UTF, control chars, and formatting
      `Price List\x00\x1F:\n\uE907Product\uFFFD A.... $1,234.56\nProduct B.... $480.00\n\n\nTotal.......`,
      // Complex nested patterns
      //   'Item 1.0.0.0... $1,234.56\nItem 2.0.0.0... $480.00\n...Final Total... $1,714.56'
    ]
    const expected = [
      "Summary:   Key points:",
      "Product A  $480.00 Product B  $1,234.56 Product C  $128,000.1",
      "Measurement: 1.0e-10  Precision: Value: $1,234.00",
      "Price List: Product A  $1,234.56 Product B  $480.00 Total",
      //   'Item 1 $1,234.56 Item 2 $480.00 Final Total $1,714.56'
    ]
    inputs.forEach((input, i) => {
      expect(cleanDocs(input)).toBe(expected[i])
    })
  })
})
