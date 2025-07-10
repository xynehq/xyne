import { describe, test, expect } from "bun:test"
import { extractEmailAddresses } from "../integrations/google/gmail/index"

// Gmail API message structure
interface MockGmailMessage {
  id: string
  payload: {
    headers: Array<{ name: string; value: string }>
    body?: {
      data?: string
    }
    parts?: Array<{
      mimeType: string
      body: {
        data?: string
      }
    }>
  }
}

const createMockEmailMessage = (
  messageId: string,
  headers: Record<string, string>,
  body?: string,
): MockGmailMessage => {
  return {
    id: messageId,
    payload: {
      headers: Object.entries(headers).map(([name, value]) => ({
        name,
        value,
      })),
      body: body ? { data: Buffer.from(body).toString("base64") } : undefined,
    },
  }
}

// Helper function to extract header from mock message
const getHeaderFromMessage = (
  message: MockGmailMessage,
  headerName: string,
): string => {
  const header = message.payload.headers.find(
    (h) => h.name.toLowerCase() === headerName.toLowerCase(),
  )
  return header ? header.value : ""
}

// Message ID processing helper
const processMessageId = (messageId: string): string => {
  return messageId.replace(/^<|>$/g, "")
}

// References parsing helper (extract first reference)
const extractFirstReference = (references: string): string => {
  const match = references.match(/<([^>]+)>/)
  return match && match[1] ? match[1] : ""
}

describe("Email Address Extraction", () => {
  test("should extract single name and email in angle brackets", () => {
    const result = extractEmailAddresses("John Doe <john.doe@example.com>")
    expect(result).toEqual(["john.doe@example.com"])
  })

  test("should extract mixed plain and bracketed emails", () => {
    const result = extractEmailAddresses(
      "alice@example.com, Bob <bob@example.com>",
    )
    expect(result).toEqual(["alice@example.com", "bob@example.com"])
  })

  test("should extract multiple recipients with quoted names", () => {
    const result = extractEmailAddresses(
      'Manager <manager@company.com>, "Team Lead" <lead@company.com>',
    )
    expect(result).toEqual(["manager@company.com", "lead@company.com"])
  })

  test("should extract quoted name with special characters", () => {
    const result = extractEmailAddresses(
      '"Dr. Jane O\'Connor" <jane.oconnor@university.edu>',
    )
    expect(result).toEqual(["jane.oconnor@university.edu"])
  })

  test("should extract multiple plain email addresses", () => {
    const result = extractEmailAddresses(
      "bcc1@example.com, bcc2@example.com, bcc3@example.com",
    )
    expect(result).toEqual([
      "bcc1@example.com",
      "bcc2@example.com",
      "bcc3@example.com",
    ])
  })

  test("should return empty array for empty header", () => {
    const result = extractEmailAddresses("")
    expect(result).toEqual([])
  })
})

describe("Full Email Message Parsing", () => {
  test("should parse simple reply email with multiple recipients", () => {
    const message = createMockEmailMessage(
      "197ef38f455edef2",
      {
        "Delivered-To": "john.doe@company.com",
        From: "John Doe <john.doe@gmail.com>",
        Date: "Wed, 9 Jul 2025 18:16:03 +0530",
        "Message-ID":
          "<CAP0fsnk4ndmXDERjEERRFYKjZ5dpcGGfLqFRfJjS7Z6qDLUb8A@mail.gmail.com>",
        Subject: "Re: testing the parent message id",
        To: 'john.doe@company.com, "jane.smith@gmail.com" <jane.smith@gmail.com>',
        "In-Reply-To":
          "<CAP0fsnm0FThCJNrKBOx4QFVXDczrDRukNxi+Y2r-ygxnn_J+dA@mail.gmail.com>",
        References:
          "<CAP0fsnnBFyyMmSOHaC29zkxFwpvHEcy081dVC7LOMjJSUMRMzA@mail.gmail.com> <CAP0fsnmK+1nRSQcrTZrWaw5E=orx=O-SGpkEyCVjQdcbp-rHSg@mail.gmail.com> <CAP0fsn=wTe6VrGCTXoJn93BHq+QUGwgVnEVKQg=B8hbjOe=bAA@mail.gmail.com> <CAP0fsnnrDrXvF=0dqJCKerNyrrCG0tqM+qjteYXqy+AiZ6TY3Q@mail.gmail.com> <CAP0fsn=+PUvDEasE1z1RGKtjA-M_RP+hzfe2fqHi1ntA3Lw2=g@mail.gmail.com> <CAP0fsnm0FThCJNrKBOx4QFVXDczrDRukNxi+Y2r-ygxnn_J+dA@mail.gmail.com>",
      },
      "This is a test reply message.",
    )

    // Test FROM extraction
    const fromHeader = getHeaderFromMessage(message, "From")
    const fromEmails = extractEmailAddresses(fromHeader)
    expect(fromEmails).toEqual(["john.doe@gmail.com"])

    // Test TO extraction
    const toHeader = getHeaderFromMessage(message, "To")
    const toEmails = extractEmailAddresses(toHeader)
    expect(toEmails).toEqual(["john.doe@company.com", "jane.smith@gmail.com"])

    // Test CC extraction (should be empty)
    const ccHeader = getHeaderFromMessage(message, "Cc")
    const ccEmails = extractEmailAddresses(ccHeader)
    expect(ccEmails).toEqual([])

    // Test Message ID extraction
    const messageIdHeader = getHeaderFromMessage(message, "Message-ID")
    const messageId = processMessageId(messageIdHeader)
    expect(messageId).toBe(
      "CAP0fsnk4ndmXDERjEERRFYKjZ5dpcGGfLqFRfJjS7Z6qDLUb8A@mail.gmail.com",
    )

    // Test In-Reply-To extraction
    const inReplyToHeader = getHeaderFromMessage(message, "In-Reply-To")
    const inReplyTo = processMessageId(inReplyToHeader)
    expect(inReplyTo).toBe(
      "CAP0fsnm0FThCJNrKBOx4QFVXDczrDRukNxi+Y2r-ygxnn_J+dA@mail.gmail.com",
    )

    // Test first Reference extraction
    const referencesHeader = getHeaderFromMessage(message, "References")
    const firstReference = extractFirstReference(referencesHeader)
    expect(firstReference).toBe(
      "CAP0fsnnBFyyMmSOHaC29zkxFwpvHEcy081dVC7LOMjJSUMRMzA@mail.gmail.com",
    )

    // Test Delivered-To extraction
    const deliveredToHeader = getHeaderFromMessage(message, "Delivered-To")
    expect(deliveredToHeader).toBe("john.doe@company.com")
  })

  test("should parse email with CC and BCC recipients", () => {
    const message = createMockEmailMessage(
      "test123456789",
      {
        From: "John Doe <john.doe@company.com>",
        To: "alice@example.com, Bob Smith <bob@example.com>",
        Cc: 'Manager <manager@company.com>, "Team Lead" <lead@company.com>',
        Bcc: "secret1@example.com, secret2@example.com",
        "Message-ID": "<unique-message-id@company.com>",
        Subject: "Project Update",
        Date: "Thu, 10 Jul 2025 10:00:00 +0000",
      },
      "Project status update email content.",
    )

    const fromEmails = extractEmailAddresses(
      getHeaderFromMessage(message, "From"),
    )
    expect(fromEmails).toEqual(["john.doe@company.com"])

    const toEmails = extractEmailAddresses(getHeaderFromMessage(message, "To"))
    expect(toEmails).toEqual(["alice@example.com", "bob@example.com"])

    const ccEmails = extractEmailAddresses(getHeaderFromMessage(message, "Cc"))
    expect(ccEmails).toEqual(["manager@company.com", "lead@company.com"])

    const bccEmails = extractEmailAddresses(
      getHeaderFromMessage(message, "Bcc"),
    )
    expect(bccEmails).toEqual(["secret1@example.com", "secret2@example.com"])

    const messageId = processMessageId(
      getHeaderFromMessage(message, "Message-ID"),
    )
    expect(messageId).toBe("unique-message-id@company.com")
  })

  test("should parse original email with no reply context", () => {
    const message = createMockEmailMessage(
      "original123",
      {
        From: "sender@example.com",
        To: "recipient@example.com",
        "Message-ID": "<original-message@example.com>",
        Subject: "New conversation",
        Date: "Fri, 11 Jul 2025 14:30:00 +0000",
      },
      "This is an original email with no reply context.",
    )

    const fromEmails = extractEmailAddresses(
      getHeaderFromMessage(message, "From"),
    )
    expect(fromEmails).toEqual(["sender@example.com"])

    const toEmails = extractEmailAddresses(getHeaderFromMessage(message, "To"))
    expect(toEmails).toEqual(["recipient@example.com"])

    const inReplyTo = processMessageId(
      getHeaderFromMessage(message, "In-Reply-To"),
    )
    expect(inReplyTo).toBe("")

    const firstReference = extractFirstReference(
      getHeaderFromMessage(message, "References"),
    )
    expect(firstReference).toBe("")
  })
})

describe("Message ID Processing", () => {
  test("should remove angle brackets from message ID", () => {
    const result = processMessageId(
      "<CAP0fsnnSD41_vpDFEAkjdDnMcbOqJhtqLSmX=ySnfxRVAw9szQ@mail.gmail.com>",
    )
    expect(result).toBe(
      "CAP0fsnnSD41_vpDFEAkjdDnMcbOqJhtqLSmX=ySnfxRVAw9szQ@mail.gmail.com",
    )
  })

  test("should handle message ID without brackets", () => {
    const result = processMessageId("simple-message-id@example.com")
    expect(result).toBe("simple-message-id@example.com")
  })

  test("should handle empty brackets", () => {
    const result = processMessageId("<>")
    expect(result).toBe("")
  })
})

describe("References Parsing", () => {
  test("should extract first message ID from references", () => {
    const references =
      "<CAP0fsnnBFyyMmSOHaC29zkxFwpvHEcy081dVC7LOMjJSUMRMzA@mail.gmail.com> <CAP0fsnmK+1nRSQcrTZrWaw5E=orx=O-SGpkEyCVjQdcbp-rHSg@mail.gmail.com>"
    const result = extractFirstReference(references)
    expect(result).toBe(
      "CAP0fsnnBFyyMmSOHaC29zkxFwpvHEcy081dVC7LOMjJSUMRMzA@mail.gmail.com",
    )
  })

  test("should extract single reference", () => {
    const references = "<single-reference@example.com>"
    const result = extractFirstReference(references)
    expect(result).toBe("single-reference@example.com")
  })

  test("should return empty string for empty references", () => {
    const result = extractFirstReference("")
    expect(result).toBe("")
  })

  test("should return empty string when no angle brackets found", () => {
    const result = extractFirstReference("no-brackets-here@example.com")
    expect(result).toBe("")
  })
})
