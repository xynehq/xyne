import { URL } from "url"

// Regular Expressions

/**
 * Matches common signature patterns in emails.
 * - '--' followed by optional whitespace at the end of the line.
 * - '__' followed by optional whitespace at the end of the line.
 * - Lines starting with '-' followed by a word character.
 * - 'Sent from my [device name]'.
 */
const SIGNATURE_REGEX: RegExp =
  /(--\s*$|^__\s*$|^-\w|^Sent from my (\w+\s*){1,3}$)/i

/**
 * Matches quoted reply headers, e.g., 'On Jan 1, 2020, John Doe wrote:'.
 */
const QUOTE_HDR_REGEX: RegExp = /^On.*wrote:$/i

/**
 * Matches lines that start with one or more '>' characters, indicating quoted text.
 */
const QUOTED_REGEX: RegExp = /^(>+)/

/**
 * Matches standard email headers, e.g., 'From:', 'Sent:', 'To:', 'Subject:'.
 */
const HEADER_REGEX: RegExp = /^(From|Sent|To|Subject): .+/i

/**
 * Matches multi-line quote headers, used to handle certain email clients that break headers into multiple lines.
 */
const MULTI_QUOTE_HDR_REGEX: RegExp = /(?!On.*On\s.+?wrote:)(On\s(.+?)wrote:)/s

/**
 * Matches URLs starting with 'http://' or 'https://'.
 */
const URL_REGEX: RegExp = /\bhttps?:\/\/[^\s/$.?#].[^\s]*\b/gi

/**
 * Represents a fragment of an email message.
 * Each fragment is a block of text that shares the same characteristics (e.g., quoted text, signature).
 */
class Fragment {
  public lines: string[]
  public isQuoted: boolean
  public isSignature: boolean
  public isHeader: boolean
  public isHidden: boolean
  public content: string

  constructor() {
    this.lines = []
    this.isQuoted = false
    this.isSignature = false
    this.isHeader = false
    this.isHidden = false
    this.content = ""
  }

  /**
   * Finalizes the fragment by reversing the lines (since they were processed in reverse order)
   * and joining them into a single content string.
   */
  public finish(): void {
    // Reverse the lines back to normal order
    this.lines.reverse()
    this.content = this.lines.join("\n").trim()
  }
}

/**
 * Parses the email body text and extracts the main content, excluding quoted text, signatures, and headers.
 * Replaces URLs with placeholders in the format '[link: domain.tld]'.
 *
 * @param text - The raw email body text to parse.
 * @returns The extracted main content of the email.
 */
export const parseEmailBody = (text: string): string => {
  /**
   * Finishes processing the current fragment, determines its visibility, and adds it to the fragments list.
   *
   * @param fragment - The current fragment being processed.
   */
  const finishFragment = (fragment: Fragment | null): void => {
    if (fragment) {
      fragment.finish()

      if (fragment.isHeader) {
        foundVisible = false
        fragments.forEach((frag) => (frag.isHidden = true))
      }

      if (!foundVisible) {
        if (
          fragment.isQuoted ||
          fragment.isHeader ||
          fragment.isSignature ||
          fragment.content === ""
        ) {
          fragment.isHidden = true
        } else {
          foundVisible = true
        }
      } else {
        fragment.isHidden = true
      }

      fragments.push(fragment)
    }
  }

  // Replace CRLF with LF for consistency
  text = text.replace(/\r\n/g, "\n")

  // Handle multi-line quote headers by removing newline characters within them
  const multiQuoteHeaderMatch: RegExpMatchArray | null = text.match(
    MULTI_QUOTE_HDR_REGEX,
  )
  if (multiQuoteHeaderMatch) {
    text = text.replace(
      MULTI_QUOTE_HDR_REGEX,
      multiQuoteHeaderMatch[1].replace(/\n/g, ""),
    )
  }

  // Fix Outlook style replies by ensuring there's a newline before signature separators
  text = text.replace(/([^\n])(?=\n ?[_-]{7,})/gm, "$1\n")

  // Split the text into lines and reverse the array for bottom-up processing
  const lines: string[] = text.split("\n").reverse()

  const fragments: Fragment[] = []
  let fragment: Fragment | null = null
  let foundVisible: boolean = false

  for (const line of lines) {
    // Remove trailing whitespace from the current line
    const currentLine: string = line.trimEnd()

    // Determine if the current line is a header or quoted text
    const isHeader: boolean =
      QUOTE_HDR_REGEX.test(currentLine) || HEADER_REGEX.test(currentLine)
    const isQuoted: boolean = QUOTED_REGEX.test(currentLine)

    // Replace links in the line with placeholders
    const sanitizedLine: string = replaceLinks(currentLine)

    // Check if the current fragment is a signature
    if (
      fragment &&
      sanitizedLine.trim() === "" &&
      fragment.lines.length > 0 &&
      SIGNATURE_REGEX.test(fragment.lines[fragment.lines.length - 1].trim())
    ) {
      fragment.isSignature = true
      finishFragment(fragment)
      fragment = null
    }

    // Determine if the current line should be added to the existing fragment or start a new one
    if (
      fragment &&
      ((fragment.isHeader === isHeader && fragment.isQuoted === isQuoted) ||
        (fragment.isQuoted &&
          (QUOTE_HDR_REGEX.test(sanitizedLine) || sanitizedLine.trim() === "")))
    ) {
      fragment.lines.push(sanitizedLine)
    } else {
      finishFragment(fragment)
      fragment = new Fragment()
      fragment.isQuoted = isQuoted
      fragment.isHeader = isHeader
      fragment.lines.push(sanitizedLine)
    }
  }

  // Finish the last fragment after processing all lines
  finishFragment(fragment)

  // Reverse the fragments back to their original order
  fragments.reverse()

  // Filter out hidden fragments (e.g., signatures, quotes, headers)
  const visibleFragments: Fragment[] = fragments.filter(
    (frag) => !frag.isHidden,
  )

  // Reconstruct and return the main content from the visible fragments
  const mainContent: string = visibleFragments
    .map((frag) => frag.content)
    .join("\n")
    .trim()

  return mainContent
}

/**
 * Replaces URLs in the given text with placeholders in the format '[link: domain.tld]'.
 *
 * @param text - The text in which to replace URLs.
 * @returns The text with URLs replaced by placeholders.
 */
const replaceLinks = (text: string): string => {
  return text.replace(URL_REGEX, (match: string): string => {
    try {
      const parsedUrl: URL = new URL(match)
      const domain: string = parsedUrl.hostname
      return `${domain}`
    } catch (e) {
      // If URL parsing fails, return the original match
      return match
    }
  })
}
