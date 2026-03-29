import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import JSZip from "jszip"
import { XMLParser } from "fast-xml-parser"
import { promises as fsPromises } from "fs"
import crypto from "crypto"
import path from "path"
import {
  DeferredImageDescriptionBatch,
  md5ImageBuffer,
} from "./lib/deferredImageDescription"
import { DATASOURCE_CONFIG } from "./integrations/dataSource/config"
import { chunkTextByParagraph } from "./chunks"

const Logger = getLogger(Subsystem.Integrations).child({
  module: "docxChunks",
})

// Warning system for comprehensive error reporting
interface ProcessingWarning {
  type:
    | "unsupported_element"
    | "symbol_conversion"
    | "field_processing"
    | "table_structure"
    | "general"
  message: string
  element?: string
  context?: any
}

class WarningCollector {
  private warnings: ProcessingWarning[] = []
  private stats = {
    elementsProcessed: 0,
    elementsSkipped: 0,
    symbolsConverted: 0,
    fieldsProcessed: 0,
    tablesProcessed: 0,
    unsupportedElements: new Set<string>(),
  }

  addWarning(warning: ProcessingWarning) {
    this.warnings.push(warning)
    if (warning.type === "unsupported_element" && warning.element) {
      this.stats.unsupportedElements.add(warning.element)
    }
  }

  incrementStat(stat: keyof typeof this.stats) {
    if (typeof this.stats[stat] === "number") {
      ;(this.stats[stat] as number)++
    }
  }

  getWarnings(): ProcessingWarning[] {
    return this.warnings
  }

  getStats() {
    return {
      ...this.stats,
      unsupportedElements: Array.from(this.stats.unsupportedElements),
    }
  }

  logSummary() {
    const stats = this.getStats()
    Logger.info("DOCX Processing Summary:", {
      elementsProcessed: stats.elementsProcessed,
      elementsSkipped: stats.elementsSkipped,
      symbolsConverted: stats.symbolsConverted,
      fieldsProcessed: stats.fieldsProcessed,
      tablesProcessed: stats.tablesProcessed,
      warningsCount: this.warnings.length,
      unsupportedElements: stats.unsupportedElements,
    })

    if (this.warnings.length > 0) {
      Logger.warn(`Found ${this.warnings.length} processing warnings:`)
      this.warnings.forEach((warning, index) => {
        Logger.warn(
          `Warning ${index + 1}: [${warning.type}] ${warning.message}`,
          warning.context,
        )
      })
    }
  }
}

// Symbol character mapping for special fonts
const SYMBOL_MAPPINGS: { [font: string]: { [char: string]: string } } = {
  Wingdings: {
    "21": "☎", // Phone
    "22": "✉", // Envelope
    "23": "📁", // Folder
    "24": "📂", // Open folder
    "25": "🗂", // File folder
    "26": "⌚", // Watch
    "27": "⏰", // Alarm clock
    "28": "📞", // Telephone receiver
    "29": "📠", // Fax
    "2A": "💻", // Computer
    "2B": "🖱", // Computer mouse
    "2C": "⌨", // Keyboard
    "2D": "🖨", // Printer
    "2E": "📧", // Email
    "2F": "🌐", // Globe
    "30": "🔒", // Lock
    "31": "🔓", // Unlock
    "32": "🔑", // Key
    "33": "✂", // Scissors
    "34": "✏", // Pencil
    "35": "✒", // Pen
    "36": "📝", // Memo
    "37": "📋", // Clipboard
    "38": "📌", // Pushpin
    "39": "📎", // Paperclip
    "3A": "🔗", // Link
    "3B": "⚡", // Lightning
    "3C": "☀", // Sun
    "3D": "☁", // Cloud
    "3E": "☂", // Umbrella
    "3F": "❄", // Snowflake
    "40": "⭐", // Star
    "41": "🌙", // Moon
    "42": "🔥", // Fire
    "43": "💧", // Water drop
    "44": "🌍", // Earth
    "45": "🌱", // Seedling
    "46": "🌳", // Tree
    "47": "🌸", // Cherry blossom
    "48": "🌺", // Hibiscus
    "49": "🍀", // Four leaf clover
    "4A": "🐝", // Bee
    "4B": "🦋", // Butterfly
    "4C": "🐛", // Bug
    "4D": "🐾", // Paw prints
    "4E": "👤", // Person
    "4F": "👥", // People
    "50": "👨", // Man
    "51": "👩", // Woman
    "52": "👶", // Baby
    "53": "👴", // Old man
    "54": "👵", // Old woman
    "55": "💼", // Briefcase
    "56": "🎓", // Graduation cap
    "57": "🏠", // House
    "58": "🏢", // Office building
    "59": "🏥", // Hospital
    "5A": "🏫", // School
    "5B": "🏪", // Store
    "5C": "🚗", // Car
    "5D": "✈", // Airplane
    "5E": "🚢", // Ship
    "5F": "🚂", // Train
    "60": "🚲", // Bicycle
    "61": "⚽", // Soccer ball
    "62": "🏀", // Basketball
    "63": "🎾", // Tennis
    "64": "⚾", // Baseball
    "65": "🏈", // Football
    "66": "🎯", // Target
    "67": "🎮", // Video game
    "68": "🎲", // Dice
    "69": "🃏", // Joker
    "6A": "🎭", // Theater masks
    "6B": "🎨", // Artist palette
    "6C": "🎵", // Musical note
    "6D": "🎶", // Musical notes
    "6E": "📻", // Radio
    "6F": "📺", // Television
    "70": "📷", // Camera
    "71": "📹", // Video camera
    "72": "💿", // CD
    "73": "💾", // Floppy disk
    "74": "💽", // Minidisc
    "75": "📀", // DVD
    "76": "🔊", // Speaker
    "77": "🔇", // Muted speaker
    "78": "📢", // Megaphone
    "79": "📣", // Cheering megaphone
    "7A": "🔔", // Bell
    "7B": "🔕", // Bell with slash
    "7C": "📯", // Horn
    "7D": "🎺", // Trumpet
    "7E": "🎸", // Guitar
    "7F": "🎹", // Piano
    "80": "🥁", // Drum
    "81": "🎤", // Microphone
    "82": "🎧", // Headphones
    "83": "📱", // Mobile phone
    "84": "☎", // Telephone
    "85": "📞", // Telephone receiver
    "86": "📟", // Pager
    "87": "📠", // Fax machine
    "88": "💻", // Laptop computer
    "89": "🖥", // Desktop computer
    "8A": "⌨", // Keyboard
    "8B": "🖱", // Computer mouse
    "8C": "🖨", // Printer
    "8D": "💾", // Floppy disk
    "8E": "💿", // Optical disc
    "8F": "📀", // DVD
    "90": "💽", // Minidisc
    "91": "💾", // Floppy disk
    "92": "🗃", // Card file box
    "93": "🗂", // Card index dividers
    "94": "📋", // Clipboard
    "95": "📊", // Bar chart
    "96": "📈", // Chart increasing
    "97": "📉", // Chart decreasing
    "98": "📇", // Card index
    "99": "🗃", // Card file box
    "9A": "🗄", // File cabinet
    "9B": "📁", // File folder
    "9C": "📂", // Open file folder
    "9D": "🗂", // Card index dividers
    "9E": "📑", // Bookmark tabs
    "9F": "📄", // Page facing up
    A0: "📃", // Page with curl
    A1: "📜", // Scroll
    A2: "📰", // Newspaper
    A3: "🗞", // Rolled-up newspaper
    A4: "📓", // Notebook
    A5: "📔", // Notebook with decorative cover
    A6: "📒", // Ledger
    A7: "📕", // Closed book
    A8: "📗", // Green book
    A9: "📘", // Blue book
    AA: "📙", // Orange book
    AB: "📚", // Books
    AC: "📖", // Open book
    AD: "🔖", // Bookmark
    AE: "🏷", // Label
    AF: "💰", // Money bag
    B0: "💴", // Yen banknote
    B1: "💵", // Dollar banknote
    B2: "💶", // Euro banknote
    B3: "💷", // Pound banknote
    B4: "💸", // Money with wings
    B5: "💳", // Credit card
    B6: "💎", // Gem stone
    B7: "⚖", // Balance scale
    B8: "🔧", // Wrench
    B9: "🔨", // Hammer
    BA: "⚒", // Hammer and pick
    BB: "🛠", // Hammer and wrench
    BC: "⛏", // Pick
    BD: "🔩", // Nut and bolt
    BE: "⚙", // Gear
    BF: "⚗", // Alembic
    C0: "🔬", // Microscope
    C1: "🔭", // Telescope
    C2: "📡", // Satellite antenna
    C3: "💉", // Syringe
    C4: "💊", // Pill
    C5: "🩹", // Adhesive bandage
    C6: "🩺", // Stethoscope
    C7: "🔬", // Microscope
    C8: "🧪", // Test tube
    C9: "🧬", // DNA
    CA: "🦠", // Microbe
    CB: "💀", // Skull
    CC: "☠", // Skull and crossbones
    CD: "👻", // Ghost
    CE: "👽", // Alien
    CF: "🤖", // Robot
    D0: "🎃", // Jack-o-lantern
    D1: "😈", // Smiling face with horns
    D2: "👿", // Angry face with horns
    D3: "👹", // Ogre
    D4: "👺", // Goblin
    D5: "💩", // Pile of poo
    D6: "🤡", // Clown face
    D7: "👻", // Ghost
    D8: "💀", // Skull
    D9: "☠", // Skull and crossbones
    DA: "👽", // Alien
    DB: "🤖", // Robot
    DC: "🎭", // Performing arts
    DD: "🎨", // Artist palette
    DE: "🎪", // Circus tent
    DF: "🎢", // Roller coaster
    E0: "🎡", // Ferris wheel
    E1: "🎠", // Carousel horse
    E2: "🎪", // Circus tent
    E3: "🎭", // Performing arts
    E4: "🎨", // Artist palette
    E5: "🎬", // Clapper board
    E6: "🎤", // Microphone
    E7: "🎧", // Headphones
    E8: "🎼", // Musical score
    E9: "🎵", // Musical note
    EA: "🎶", // Musical notes
    EB: "🎹", // Musical keyboard
    EC: "🥁", // Drum
    ED: "🎷", // Saxophone
    EE: "🎺", // Trumpet
    EF: "🎸", // Guitar
    F0: "🎻", // Violin
    F1: "🎲", // Game die
    F2: "🎯", // Direct hit
    F3: "🎳", // Bowling
    F4: "🎮", // Video game
    F5: "🕹", // Joystick
    F6: "🎰", // Slot machine
    F7: "🃏", // Playing card black joker
    F8: "🀄", // Mahjong red dragon
    F9: "🎴", // Flower playing cards
    FA: "🎊", // Confetti ball
    FB: "🎉", // Party popper
    FC: "🎈", // Balloon
    FD: "🎁", // Wrapped gift
    FE: "🎀", // Ribbon
    FF: "🎗", // Reminder ribbon
  },
  Symbol: {
    "21": "!", // Exclamation mark
    "22": "∀", // For all
    "23": "#", // Number sign
    "24": "∃", // There exists
    "25": "%", // Percent sign
    "26": "&", // Ampersand
    "27": "∋", // Such that
    "28": "(", // Left parenthesis
    "29": ")", // Right parenthesis
    "2A": "∗", // Asterisk operator
    "2B": "+", // Plus sign
    "2C": ",", // Comma
    "2D": "−", // Minus sign
    "2E": ".", // Full stop
    "2F": "/", // Solidus
    "30": "0", // Digit zero
    "31": "1", // Digit one
    "32": "2", // Digit two
    "33": "3", // Digit three
    "34": "4", // Digit four
    "35": "5", // Digit five
    "36": "6", // Digit six
    "37": "7", // Digit seven
    "38": "8", // Digit eight
    "39": "9", // Digit nine
    "3A": ":", // Colon
    "3B": ";", // Semicolon
    "3C": "<", // Less-than sign
    "3D": "=", // Equals sign
    "3E": ">", // Greater-than sign
    "3F": "?", // Question mark
    "40": "≅", // Approximately equal to
    "41": "Α", // Greek capital letter alpha
    "42": "Β", // Greek capital letter beta
    "43": "Χ", // Greek capital letter chi
    "44": "Δ", // Greek capital letter delta
    "45": "Ε", // Greek capital letter epsilon
    "46": "Φ", // Greek capital letter phi
    "47": "Γ", // Greek capital letter gamma
    "48": "Η", // Greek capital letter eta
    "49": "Ι", // Greek capital letter iota
    "4A": "ϑ", // Greek theta symbol
    "4B": "Κ", // Greek capital letter kappa
    "4C": "Λ", // Greek capital letter lambda
    "4D": "Μ", // Greek capital letter mu
    "4E": "Ν", // Greek capital letter nu
    "4F": "Ο", // Greek capital letter omicron
    "50": "Π", // Greek capital letter pi
    "51": "Θ", // Greek capital letter theta
    "52": "Ρ", // Greek capital letter rho
    "53": "Σ", // Greek capital letter sigma
    "54": "Τ", // Greek capital letter tau
    "55": "Υ", // Greek capital letter upsilon
    "56": "ς", // Greek small letter final sigma
    "57": "Ω", // Greek capital letter omega
    "58": "Ξ", // Greek capital letter xi
    "59": "Ψ", // Greek capital letter psi
    "5A": "Ζ", // Greek capital letter zeta
    "5B": "[", // Left square bracket
    "5C": "∴", // Therefore
    "5D": "]", // Right square bracket
    "5E": "⊥", // Up tack
    "5F": "_", // Low line
    "60": "‾", // Overline
    "61": "α", // Greek small letter alpha
    "62": "β", // Greek small letter beta
    "63": "χ", // Greek small letter chi
    "64": "δ", // Greek small letter delta
    "65": "ε", // Greek small letter epsilon
    "66": "φ", // Greek small letter phi
    "67": "γ", // Greek small letter gamma
    "68": "η", // Greek small letter eta
    "69": "ι", // Greek small letter iota
    "6A": "ϕ", // Greek phi symbol
    "6B": "κ", // Greek small letter kappa
    "6C": "λ", // Greek small letter lambda
    "6D": "μ", // Greek small letter mu
    "6E": "ν", // Greek small letter nu
    "6F": "ο", // Greek small letter omicron
    "70": "π", // Greek small letter pi
    "71": "θ", // Greek small letter theta
    "72": "ρ", // Greek small letter rho
    "73": "σ", // Greek small letter sigma
    "74": "τ", // Greek small letter tau
    "75": "υ", // Greek small letter upsilon
    "76": "ϖ", // Greek pi symbol
    "77": "ω", // Greek small letter omega
    "78": "ξ", // Greek small letter xi
    "79": "ψ", // Greek small letter psi
    "7A": "ζ", // Greek small letter zeta
    "7B": "{", // Left curly bracket
    "7C": "|", // Vertical line
    "7D": "}", // Right curly bracket
    "7E": "∼", // Tilde operator
    A0: "€", // Euro sign
    A1: "ϒ", // Greek upsilon with hook symbol
    A2: "′", // Prime
    A3: "≤", // Less-than or equal to
    A4: "⁄", // Fraction slash
    A5: "∞", // Infinity
    A6: "ƒ", // Latin small letter f with hook
    A7: "♣", // Black club suit
    A8: "♦", // Black diamond suit
    A9: "♥", // Black heart suit
    AA: "♠", // Black spade suit
    AB: "↔", // Left right arrow
    AC: "←", // Leftwards arrow
    AD: "↑", // Upwards arrow
    AE: "→", // Rightwards arrow
    AF: "↓", // Downwards arrow
    B0: "°", // Degree sign
    B1: "±", // Plus-minus sign
    B2: "″", // Double prime
    B3: "≥", // Greater-than or equal to
    B4: "×", // Multiplication sign
    B5: "∝", // Proportional to
    B6: "∂", // Partial differential
    B7: "•", // Bullet
    B8: "÷", // Division sign
    B9: "≠", // Not equal to
    BA: "≡", // Identical to
    BB: "≈", // Almost equal to
    BC: "…", // Horizontal ellipsis
    BD: "⏐", // Vertical line extension
    BE: "⏐", // Vertical line extension
    BF: "↵", // Downwards arrow with corner leftwards
    C0: "ℵ", // Alef symbol
    C1: "ℑ", // Black-letter capital I
    C2: "ℜ", // Black-letter capital R
    C3: "℘", // Weierstrass elliptic function
    C4: "⊗", // Circled times
    C5: "⊕", // Circled plus
    C6: "∅", // Empty set
    C7: "∩", // Intersection
    C8: "∪", // Union
    C9: "⊃", // Superset of
    CA: "⊇", // Superset of or equal to
    CB: "⊄", // Not a subset of
    CC: "⊂", // Subset of
    CD: "⊆", // Subset of or equal to
    CE: "∈", // Element of
    CF: "∉", // Not an element of
    D0: "∠", // Angle
    D1: "∇", // Nabla
    D2: "®", // Registered sign
    D3: "©", // Copyright sign
    D4: "™", // Trade mark sign
    D5: "∏", // N-ary product
    D6: "√", // Square root
    D7: "⋅", // Dot operator
    D8: "¬", // Not sign
    D9: "∧", // Logical and
    DA: "∨", // Logical or
    DB: "⇔", // Left right double arrow
    DC: "⇐", // Leftwards double arrow
    DD: "⇑", // Upwards double arrow
    DE: "⇒", // Rightwards double arrow
    DF: "⇓", // Downwards double arrow
    E0: "◊", // Lozenge
    E1: "〈", // Left-pointing angle bracket
    E2: "®", // Registered sign
    E3: "©", // Copyright sign
    E4: "™", // Trade mark sign
    E5: "∑", // N-ary summation
    E6: "⎛", // Left parenthesis upper hook
    E7: "⎜", // Left parenthesis extension
    E8: "⎝", // Left parenthesis lower hook
    E9: "⎡", // Left square bracket upper corner
    EA: "⎢", // Left square bracket extension
    EB: "⎣", // Left square bracket lower corner
    EC: "⎧", // Left curly bracket upper hook
    ED: "⎨", // Left curly bracket middle piece
    EE: "⎩", // Left curly bracket lower hook
    EF: "⎪", // Curly bracket extension
    F0: "⎫", // Right curly bracket upper hook
    F1: "⎬", // Right curly bracket middle piece
    F2: "⎭", // Right curly bracket lower hook
    F3: "⎤", // Right square bracket upper corner
    F4: "⎥", // Right square bracket extension
    F5: "⎦", // Right square bracket lower corner
    F6: "⎞", // Right parenthesis upper hook
    F7: "⎟", // Right parenthesis extension
    F8: "⎠", // Right parenthesis lower hook
    F9: "〉", // Right-pointing angle bracket
    FA: "∫", // Integral
    FB: "⌠", // Top half integral
    FC: "⌡", // Bottom half integral
    FD: "⎮", // Integral extension
    FE: "⎯", // Horizontal line extension
    FF: "⎰", // Upper right or lower left integral
  },
}

// Field character stack for form field processing
interface ComplexField {
  type: "begin" | "hyperlink" | "checkbox" | "unknown"
  fldChar?: any
  options?: any
  checked?: boolean
}

// Utility function to clean text consistent with PDF processing
const cleanText = (str: string): string => {
  const normalized = str.replace(/\r\n|\r/g, "\n")
  return normalized.replace(
    /[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u009F\uFDD0-\uFDEF\uFFFE\uFFFF]/g,
    "",
  )
}

/**
 * Post-processes the extracted text to normalize whitespace and handle newlines intelligently.
 * Reusing the same logic as Google Docs processing for consistency.
 */
const postProcessText = (text: string): string => {
  const lines = text.split("\n")
  const processedLines: string[] = []
  let previousLine = ""
  let consecutiveNewlines = 0

  const isListItem = (line: string): boolean => /^[\s]*[-*+] /.test(line)

  lines.forEach((line, index) => {
    const trimmedLine = line.trim()

    if (trimmedLine === "") {
      consecutiveNewlines++
      if (consecutiveNewlines <= 2) {
        processedLines.push("") // Keep up to two empty lines
      }
    } else {
      if (
        consecutiveNewlines >= 2 ||
        index === 0 ||
        trimmedLine.startsWith("#")
      ) {
        // Start of a new paragraph or heading
        processedLines.push(trimmedLine)
      } else if (previousLine !== "" && !isListItem(previousLine)) {
        // Continuation of the previous paragraph (not a list item)
        processedLines[processedLines.length - 1] += " " + trimmedLine
      } else {
        // Single line paragraph or list item
        processedLines.push(trimmedLine)
      }
      consecutiveNewlines = 0
    }

    previousLine = trimmedLine
  })

  return processedLines.join("\n")
}

interface DocxContentItem {
  type: "text" | "image"
  content?: string
  relId?: string
  pos: number
}

interface DocxProcessingResult {
  text_chunks: string[]
  image_chunks: string[]
  text_chunk_pos: number[]
  image_chunk_pos: number[]
}

/**
 * Get heading prefix based on paragraph style (similar to Google Docs processing)
 */
function getHeadingPrefix(paragraph: any): string {
  const pStyle = paragraph["w:pPr"]?.["w:pStyle"]?.["@_w:val"]
  if (pStyle) {
    const headingMatch = pStyle.match(/[Hh]eading(\d+)/)
    if (headingMatch) {
      const level = parseInt(headingMatch[1])
      return "#".repeat(level) + " "
    }
  }
  return ""
}

/**
 * Helper to extract Office Math equations from a paragraph.
 * Returns a string with [MATH: ...] placeholders for each equation found.
 */
function extractMathFromParagraph(paragraph: any): string {
  let mathTexts: string[] = []
  if (!paragraph) return ""

  // Helper to serialize math block to a simplified string
  function serializeMathBlock(mathBlock: any): string {
    // Try to extract all text nodes under the math block
    let result = ""
    function traverse(node: any) {
      if (!node || typeof node !== "object") return
      // If it's a text node
      if (typeof node["w:t"] === "string") {
        result += node["w:t"]
      }
      if (typeof node["#text"] === "string") {
        result += node["#text"]
      }
      // Recursively traverse all children
      for (const key of Object.keys(node)) {
        if (typeof node[key] === "object") {
          traverse(node[key])
        }
        if (Array.isArray(node[key])) {
          for (const child of node[key]) {
            traverse(child)
          }
        }
      }
    }
    traverse(mathBlock)
    return result.trim()
  }

  // Look for <m:oMath> and <m:oMathPara> blocks directly in the paragraph
  // In DOCX XML, these are typically at the paragraph or run level
  if (paragraph["m:oMath"]) {
    const mathBlocks = Array.isArray(paragraph["m:oMath"])
      ? paragraph["m:oMath"]
      : [paragraph["m:oMath"]]
    for (const mathBlock of mathBlocks) {
      const mathString = serializeMathBlock(mathBlock)
      if (mathString) mathTexts.push(`[MATH: ${mathString}]`)
    }
  }
  if (paragraph["m:oMathPara"]) {
    const mathParas = Array.isArray(paragraph["m:oMathPara"])
      ? paragraph["m:oMathPara"]
      : [paragraph["m:oMathPara"]]
    for (const mathPara of mathParas) {
      // m:oMathPara may contain m:oMath as children
      if (mathPara["m:oMath"]) {
        const mathBlocks = Array.isArray(mathPara["m:oMath"])
          ? mathPara["m:oMath"]
          : [mathPara["m:oMath"]]
        for (const mathBlock of mathBlocks) {
          const mathString = serializeMathBlock(mathBlock)
          if (mathString) mathTexts.push(`[MATH: ${mathString}]`)
        }
      } else {
        // Or just serialize the whole oMathPara
        const mathString = serializeMathBlock(mathPara)
        if (mathString) mathTexts.push(`[MATH: ${mathString}]`)
      }
    }
  }
  // Also look for math blocks inside runs
  const runs = paragraph["w:r"] || paragraph.r || []
  const runsArray = Array.isArray(runs) ? runs : [runs]
  for (const run of runsArray) {
    if (!run) continue
    if (run["m:oMath"]) {
      const mathBlocks = Array.isArray(run["m:oMath"])
        ? run["m:oMath"]
        : [run["m:oMath"]]
      for (const mathBlock of mathBlocks) {
        const mathString = serializeMathBlock(mathBlock)
        if (mathString) mathTexts.push(`[MATH: ${mathString}]`)
      }
    }
    if (run["m:oMathPara"]) {
      const mathParas = Array.isArray(run["m:oMathPara"])
        ? run["m:oMathPara"]
        : [run["m:oMathPara"]]
      for (const mathPara of mathParas) {
        if (mathPara["m:oMath"]) {
          const mathBlocks = Array.isArray(mathPara["m:oMath"])
            ? mathPara["m:oMath"]
            : [mathPara["m:oMath"]]
          for (const mathBlock of mathBlocks) {
            const mathString = serializeMathBlock(mathBlock)
            if (mathString) mathTexts.push(`[MATH: ${mathString}]`)
          }
        } else {
          const mathString = serializeMathBlock(mathPara)
          if (mathString) mathTexts.push(`[MATH: ${mathString}]`)
        }
      }
    }
  }
  return mathTexts.join(" ")
}

/**
 * Check if a paragraph style indicates a code block
 */
function isCodeBlockStyle(paragraph: any): boolean {
  const pStyle = paragraph["w:pPr"]?.["w:pStyle"]?.["@_w:val"]
  if (!pStyle) return false

  // Common code block style names
  const codeStylePatterns = [
    /code/i,
    /source/i,
    /program/i,
    /console/i,
    /terminal/i,
    /mono/i,
    /pre/i,
    /listing/i,
    /verbatim/i,
  ]

  return codeStylePatterns.some((pattern) => pattern.test(pStyle))
}

/**
 * Check if paragraph has code-like formatting (background color, borders, etc)
 */
function hasCodeFormatting(paragraph: any): boolean {
  const pPr = paragraph["w:pPr"]
  if (!pPr) return false

  // Check for shading (background color)
  const shading = pPr["w:shd"]
  if (shading && shading["@_w:fill"] && shading["@_w:fill"] !== "auto") {
    // Common code block background colors
    const codeColors = [
      "F5F5F5",
      "F0F0F0",
      "E8E8E8",
      "EEEEEE",
      "F8F8F8",
      "FAFAFA",
    ]
    const fill = shading["@_w:fill"].toUpperCase()
    if (codeColors.includes(fill)) return true
  }

  // Check for borders
  const borders = pPr["w:pBdr"]
  if (borders) return true

  // Check if runs have monospace font
  const runs = paragraph["w:r"] || []
  const runsArray = Array.isArray(runs) ? runs : [runs]
  if (runsArray.length > 0) {
    // Filter out null/undefined runs and check if any valid runs have monospace formatting
    const validRuns = runsArray.filter(
      (run) => run !== null && run !== undefined,
    )
    if (validRuns.length > 0) {
      const hasMonospaceRun = validRuns.some((run) => isCodeFormatting(run))
      if (hasMonospaceRun) return true
    }
  }

  return false
}

/**
 * Check if run formatting indicates code (monospace font)
 */
function isCodeFormatting(run: any): boolean {
  const rFonts = run["w:rPr"]?.["w:rFonts"]
  if (!rFonts) return false

  const fontNames = [
    rFonts["@_w:ascii"],
    rFonts["@_w:hAnsi"],
    rFonts["@_w:cs"],
    rFonts["@_w:eastAsia"],
  ].filter(Boolean)

  const monospaceFonts = [
    /consolas/i,
    /courier/i,
    /monaco/i,
    /monospace/i,
    /terminal/i,
    /fixed/i,
  ]

  return fontNames.some((font) =>
    monospaceFonts.some((pattern) => pattern.test(font)),
  )
}

/**
 * Convert symbol characters using font-specific mappings
 */
function readSymbol(element: any, warningCollector?: WarningCollector): string {
  const font = element.attributes?.["@_w:font"] || element["@_w:font"]
  const char = element.attributes?.["@_w:char"] || element["@_w:char"]

  if (!font || !char) {
    warningCollector?.addWarning({
      type: "symbol_conversion",
      message: "Symbol element missing font or char attribute",
      context: { element },
    })
    return ""
  }

  // Normalize character code - remove 'F0' prefix if present
  let normalizedChar = char.toUpperCase()
  if (normalizedChar.startsWith("F0") && normalizedChar.length === 4) {
    normalizedChar = normalizedChar.substring(2)
  }

  // Look up in symbol mappings
  const fontMappings = SYMBOL_MAPPINGS[font]
  if (fontMappings && fontMappings[normalizedChar]) {
    warningCollector?.incrementStat("symbolsConverted")
    return fontMappings[normalizedChar]
  }

  // Try alternative font names
  const alternativeFonts = ["Wingdings", "Symbol"]
  for (const altFont of alternativeFonts) {
    if (
      altFont !== font &&
      SYMBOL_MAPPINGS[altFont] &&
      SYMBOL_MAPPINGS[altFont][normalizedChar]
    ) {
      warningCollector?.incrementStat("symbolsConverted")
      return SYMBOL_MAPPINGS[altFont][normalizedChar]
    }
  }

  // Fallback: try to convert hex to Unicode
  try {
    const codePoint = parseInt(normalizedChar, 16)
    if (codePoint > 0 && codePoint <= 0x10ffff) {
      const unicodeChar = String.fromCodePoint(codePoint)
      warningCollector?.incrementStat("symbolsConverted")
      return unicodeChar
    }
  } catch (error) {
    // Ignore conversion errors
  }

  warningCollector?.addWarning({
    type: "symbol_conversion",
    message: `Unsupported symbol character: char ${char} in font ${font}`,
    context: { font, char, normalizedChar },
  })

  return `[SYMBOL:${font}:${char}]`
}

/**
 * Process field characters for form fields and complex fields
 */
function readFldChar(
  element: any,
  complexFieldStack: ComplexField[],
  currentInstrText: string[],
  warningCollector?: WarningCollector,
): string {
  const type =
    element.attributes?.["@_w:fldCharType"] || element["@_w:fldCharType"]

  if (type === "begin") {
    complexFieldStack.push({ type: "begin", fldChar: element })
    currentInstrText.length = 0 // Clear instruction text
    warningCollector?.incrementStat("fieldsProcessed")
  } else if (type === "end") {
    const complexFieldEnd = complexFieldStack.pop()
    if (complexFieldEnd?.type === "begin") {
      const parsedField = parseInstrText(
        currentInstrText.join(""),
        complexFieldEnd.fldChar || {},
      )
      if (parsedField.type === "checkbox") {
        return `[CHECKBOX:${parsedField.checked ? "CHECKED" : "UNCHECKED"}]`
      }
    }
    warningCollector?.incrementStat("fieldsProcessed")
  } else if (type === "separate") {
    const complexFieldSeparate = complexFieldStack.pop()
    if (complexFieldSeparate?.type === "begin") {
      const parsedField = parseInstrText(
        currentInstrText.join(""),
        complexFieldSeparate.fldChar || {},
      )
      complexFieldStack.push(parsedField)
    }
  }

  return ""
}

/**
 * Parse instruction text for field types
 */
function parseInstrText(instrText: string, fldChar: any): ComplexField {
  // External hyperlink
  const externalLinkResult = /\s*HYPERLINK\s+"([^"]*)"/.exec(instrText)
  if (externalLinkResult) {
    return { type: "hyperlink", options: { href: externalLinkResult[1] } }
  }

  // Internal hyperlink
  const internalLinkResult = /\s*HYPERLINK\s+\\l\s+"([^"]*)"/.exec(instrText)
  if (internalLinkResult) {
    return { type: "hyperlink", options: { anchor: internalLinkResult[1] } }
  }

  // Form checkbox
  const checkboxResult = /\s*FORMCHECKBOX\s*/.exec(instrText)
  if (checkboxResult) {
    const checkboxElement = fldChar?.["w:ffData"]?.["w:checkBox"]
    if (checkboxElement) {
      const checkedElement = checkboxElement["w:checked"]
      const defaultElement = checkboxElement["w:default"]

      let checked = false
      if (checkedElement) {
        const val =
          checkedElement.attributes?.["@_w:val"] || checkedElement["@_w:val"]
        checked = val !== "false" && val !== "0"
      } else if (defaultElement) {
        const val =
          defaultElement.attributes?.["@_w:val"] || defaultElement["@_w:val"]
        checked = val !== "false" && val !== "0"
      }

      return { type: "checkbox", checked }
    }
    return { type: "checkbox", checked: false }
  }

  // Form text field
  const textFieldResult = /\s*FORMTEXT\s*/.exec(instrText)
  if (textFieldResult) {
    return { type: "unknown", options: { fieldType: "text" } }
  }

  // Form dropdown
  const dropdownResult = /\s*FORMDROPDOWN\s*/.exec(instrText)
  if (dropdownResult) {
    return { type: "unknown", options: { fieldType: "dropdown" } }
  }

  return { type: "unknown" }
}

/**
 * Enhanced table processing with cell merging detection
 */
function extractTextFromTableWithMerging(
  table: any,
  documentData?: any,
  warningCollector?: WarningCollector,
): string {
  if (!table) return ""

  const rows = table["w:tr"] || []
  const rowsArray = Array.isArray(rows) ? rows : [rows]

  // First pass: collect all cells with their properties
  const tableData: Array<
    Array<{
      content: string
      colSpan: number
      vMerge: boolean | null
      rowSpan?: number
    }>
  > = []

  for (const row of rowsArray) {
    const cells = row["w:tc"] || []
    const cellsArray = Array.isArray(cells) ? cells : [cells]

    const rowData = cellsArray.map((cell) => {
      const paragraphs = cell["w:p"] || []
      const paragraphsArray = Array.isArray(paragraphs)
        ? paragraphs
        : [paragraphs]

      const content = paragraphsArray
        .map((p) => extractTextFromParagraph(p, documentData))
        .join("\n")

      // Get cell properties
      const properties = cell["w:tcPr"] || {}
      const gridSpan =
        properties["w:gridSpan"]?.["@_w:val"] ||
        properties["w:gridSpan"]?.attributes?.["@_w:val"]
      const colSpan = gridSpan ? parseInt(gridSpan, 10) : 1

      // Get vertical merge information
      const vMergeElement = properties["w:vMerge"]
      let vMerge: boolean | null = null
      if (vMergeElement) {
        const val =
          vMergeElement.attributes?.["@_w:val"] || vMergeElement["@_w:val"]
        vMerge = val === "continue" || !val // No val means restart, continue means continuation
      }

      return { content, colSpan, vMerge }
    })

    tableData.push(rowData)
  }

  // Second pass: calculate row spans
  const processedTable = calculateRowSpans(tableData, warningCollector)

  // Third pass: generate output
  const result =
    processedTable
      .map((row) => {
        return row
          .filter((cell) => cell.rowSpan !== 0) // Filter out continuation cells
          .map((cell) => cell.content)
          .join("\t") // Tab-separated cells
      })
      .join("\n") + "\n\n" // Newline-separated rows with extra spacing

  warningCollector?.incrementStat("tablesProcessed")
  return result
}

/**
 * Calculate row spans for merged table cells
 */
function calculateRowSpans(
  tableData: Array<
    Array<{
      content: string
      colSpan: number
      vMerge: boolean | null
      rowSpan?: number
    }>
  >,
  warningCollector?: WarningCollector,
): Array<
  Array<{
    content: string
    colSpan: number
    vMerge: boolean | null
    rowSpan: number
  }>
> {
  // Track column merge state
  const columnMergeState: {
    [colIndex: number]: { rowSpan: number; sourceRow: number }
  } = {}

  const processedTable = tableData.map((row, rowIndex) => {
    let colIndex = 0

    return row.map((cell) => {
      // Skip columns that are part of ongoing merges
      while (
        columnMergeState[colIndex] &&
        columnMergeState[colIndex].rowSpan > 0
      ) {
        columnMergeState[colIndex].rowSpan--
        if (columnMergeState[colIndex].rowSpan === 0) {
          delete columnMergeState[colIndex]
        }
        colIndex++
      }

      const currentColIndex = colIndex
      let rowSpan = 1

      if (cell.vMerge === true) {
        // This is a continuation cell - it should be hidden
        rowSpan = 0
      } else if (cell.vMerge === false || cell.vMerge === null) {
        // This starts a new merge or is a standalone cell
        // Look ahead to count merged cells
        let lookAheadRow = rowIndex + 1
        while (lookAheadRow < tableData.length) {
          const nextRowCell = tableData[lookAheadRow][currentColIndex]
          if (nextRowCell && nextRowCell.vMerge === true) {
            rowSpan++
            lookAheadRow++
          } else {
            break
          }
        }

        // Set up merge state for this column
        if (rowSpan > 1) {
          columnMergeState[currentColIndex] = {
            rowSpan: rowSpan - 1,
            sourceRow: rowIndex,
          }
        }
      }

      // Advance column index by the column span
      colIndex += cell.colSpan

      return {
        ...cell,
        rowSpan,
      }
    })
  })

  return processedTable
}

/**
 * Process instruction text elements for field processing
 */
function readInstrText(element: any, currentInstrText: string[]): string {
  const text = element.text?.() || element["#text"] || ""
  currentInstrText.push(text)
  return ""
}

/**
 * Extract text from a text element, handling both string and object formats
 */
function extractTextFromElement(textElement: any): string {
  if (!textElement) return ""

  if (typeof textElement === "string") {
    return textElement
  } else if (textElement["#text"]) {
    return textElement["#text"]
  }

  return ""
}

/**
 * Extract complete text from paragraph including embedded text boxes in order
 */
function extractCompleteTextFromParagraph(
  paragraph: any,
  documentData?: any,
): string {
  if (!paragraph) return ""

  // First get the basic paragraph text
  const paragraphText = extractTextFromParagraph(paragraph, documentData)

  // Now we need to find text boxes and their positions within the paragraph
  const contentParts: { text: string }[] = []

  // Add the main paragraph text at position 0
  if (paragraphText.trim()) {
    contentParts.push({ text: paragraphText })
  }

  // Check for text boxes in various locations and try to determine their position
  // Check for VML shapes with textboxes in w:pict
  if (paragraph["w:pict"]) {
    const pict = paragraph["w:pict"]

    // Check v:shape
    if (pict["v:shape"]) {
      const shapes = Array.isArray(pict["v:shape"])
        ? pict["v:shape"]
        : [pict["v:shape"]]
      for (const shape of shapes) {
        if (shape["v:textbox"]) {
          const textBoxContent = extractTextFromTextBox(shape, documentData)
          if (textBoxContent) {
            // Text boxes typically appear after the paragraph text
            contentParts.push({ text: textBoxContent })
          }
        }
      }
    }

    // Check v:rect
    if (pict["v:rect"]) {
      const rects = Array.isArray(pict["v:rect"])
        ? pict["v:rect"]
        : [pict["v:rect"]]
      for (const rect of rects) {
        if (rect["v:textbox"]) {
          const textBoxContent = extractTextFromTextBox(rect, documentData)
          if (textBoxContent) {
            contentParts.push({ text: textBoxContent })
          }
        }
      }
    }

    // Check v:roundrect
    if (pict["v:roundrect"]) {
      const roundrects = Array.isArray(pict["v:roundrect"])
        ? pict["v:roundrect"]
        : [pict["v:roundrect"]]
      for (const roundrect of roundrects) {
        if (roundrect["v:textbox"]) {
          const textBoxContent = extractTextFromTextBox(roundrect, documentData)
          if (textBoxContent) {
            contentParts.push({ text: textBoxContent })
          }
        }
      }
    }
  }

  // Check for AlternateContent which might contain text boxes
  if (paragraph["mc:AlternateContent"]) {
    const altContent = paragraph["mc:AlternateContent"]
    const fallback = altContent["mc:Fallback"]
    if (fallback && fallback["w:pict"]) {
      const pict = fallback["w:pict"]
      // Process shapes in fallback
      const shapes = []
      if (pict["v:shape"])
        shapes.push(
          ...(Array.isArray(pict["v:shape"])
            ? pict["v:shape"]
            : [pict["v:shape"]]),
        )
      if (pict["v:rect"])
        shapes.push(
          ...(Array.isArray(pict["v:rect"])
            ? pict["v:rect"]
            : [pict["v:rect"]]),
        )
      if (pict["v:roundrect"])
        shapes.push(
          ...(Array.isArray(pict["v:roundrect"])
            ? pict["v:roundrect"]
            : [pict["v:roundrect"]]),
        )

      for (const shape of shapes) {
        if (shape["v:textbox"]) {
          const textBoxContent = extractTextFromTextBox(shape, documentData)
          if (textBoxContent) {
            contentParts.push({ text: textBoxContent })
          }
        }
      }
    }
  }

  return contentParts.map((part) => part.text).join("\n\n")
}

/**
 * Extract text content from a paragraph element with enhanced formatting support
 * Now also extracts Office Math equations as [MATH: ...] placeholders.
 * Enhanced to handle mixed content (runs and breaks) in proper order.
 * Includes symbol character handling and form field processing.
 */
function extractTextFromParagraph(
  paragraph: any,
  documentData?: any,
  warningCollector?: WarningCollector,
): string {
  let text = ""
  if (!paragraph) return text

  // Initialize field processing state
  const complexFieldStack: ComplexField[] = []
  const currentInstrText: string[] = []

  // Check if this is a code block paragraph
  const isCodeBlock =
    isCodeBlockStyle(paragraph) || hasCodeFormatting(paragraph)

  // Hyperlink handling
  if (paragraph["w:hyperlink"]) {
    const hyperlinks = Array.isArray(paragraph["w:hyperlink"])
      ? paragraph["w:hyperlink"]
      : [paragraph["w:hyperlink"]]
    return hyperlinks
      .map((hl) => {
        const relId = hl["@_r:id"]
        const hyperlinkRuns = hl["w:r"] || []
        const hyperlinkRunsArray = Array.isArray(hyperlinkRuns)
          ? hyperlinkRuns
          : [hyperlinkRuns]
        const hyperlinkText = hyperlinkRunsArray
          .map((r) => {
            const textEl = r["w:t"]
            const text =
              typeof textEl === "string" ? textEl : textEl?.["#text"] || ""
            return text
          })
          .join("") // Don't add spaces between runs - preserve original spacing
        if (
          relId &&
          documentData?.__rels &&
          typeof documentData.__rels.get === "function" &&
          documentData.__rels.has(relId)
        ) {
          const href = documentData.__rels.get(relId)
          return `[${hyperlinkText}](${href})`
        }
        return hyperlinkText
      })
      .join(" ")
  }

  // Check for list formatting
  const numPr = paragraph["w:pPr"]?.["w:numPr"]
  let isListItem = false
  let listLevel = 0

  if (numPr) {
    isListItem = true
    listLevel = parseInt(numPr["w:ilvl"]?.["@_w:val"] || "0")
  }

  // Process mixed content (runs and breaks) in order
  // We need to handle the case where breaks are interspersed with runs
  let codeFragments: string[] = []
  let contentParts: string[] = []

  // Get all runs
  const runs = paragraph["w:r"] || paragraph.r || []
  const runsArray = Array.isArray(runs) ? runs : [runs]

  // Get all paragraph-level breaks
  const breaks = paragraph["w:br"] || []
  const breaksArray = Array.isArray(breaks) ? breaks : [breaks]

  // Process runs and collect their text
  for (const run of runsArray) {
    if (!run) continue

    // Check if this run has code formatting
    const isCode = isCodeFormatting(run)

    // Process all child elements of the run in order
    // A run can contain multiple w:t elements with w:br elements between them
    const runParts: string[] = []

    // Get all text elements (w:t) - could be multiple
    const textElements = run["w:t"] || run.t || []
    const textElementsArray = Array.isArray(textElements)
      ? textElements
      : [textElements]

    // Get all break elements (w:br) - could be multiple
    const breakElements = run["w:br"] || run.br || []
    const breakElementsArray = Array.isArray(breakElements)
      ? breakElements
      : [breakElements]

    // Process text elements
    for (const textElement of textElementsArray) {
      if (!textElement) continue

      const runText = extractTextFromElement(textElement)

      if (runText) {
        runParts.push(runText)
      }
    }

    // Handle symbol characters
    const symbolElement = run["w:sym"]
    if (symbolElement) {
      const symbolText = readSymbol(symbolElement, warningCollector)
      if (symbolText) {
        runParts.push(symbolText)
      }
    }

    // Handle field characters
    const fldCharElement = run["w:fldChar"]
    if (fldCharElement) {
      const fieldText = readFldChar(
        fldCharElement,
        complexFieldStack,
        currentInstrText,
        warningCollector,
      )
      if (fieldText) {
        runParts.push(fieldText)
      }
    }

    // Handle instruction text
    const instrTextElement = run["w:instrText"]
    if (instrTextElement) {
      readInstrText(instrTextElement, currentInstrText)
    }

    // If we have multiple text elements, we need to add breaks between them
    // The breaks are typically interspersed with the text elements
    if (textElementsArray.length > 1 && breakElementsArray.length > 0) {
      // Reconstruct with breaks
      const reconstructed: string[] = []

      // Process in order - typically alternating text and breaks
      for (let i = 0; i < textElementsArray.length; i++) {
        const textElement = textElementsArray[i]
        if (!textElement) continue

        const runText = extractTextFromElement(textElement)

        if (runText) {
          reconstructed.push(runText)
          // Add a break after each text element except the last
          if (i < textElementsArray.length - 1) {
            reconstructed.push("\n")
          }
        }
      }

      const fullRunText = reconstructed.join("")
      if (isCode && !isCodeBlock) {
        // Inline code
        codeFragments.push("`" + fullRunText + "`")
      } else {
        contentParts.push(fullRunText)
      }
    } else if (runParts.length > 0) {
      // Single text element or no breaks
      const fullRunText = runParts.join("")
      if (isCode && !isCodeBlock) {
        // Inline code
        codeFragments.push("`" + fullRunText + "`")
      } else {
        contentParts.push(fullRunText)
      }
    }

    // Handle footnote references
    const footnoteRef = run["w:footnoteReference"]
    if (footnoteRef) {
      const footnoteId = footnoteRef["@_w:id"]
      if (footnoteId) {
        contentParts.push(`[^${footnoteId}]`)
      }
    }

    // Handle endnote references
    const endnoteRef = run["w:endnoteReference"]
    if (endnoteRef) {
      const endnoteId = endnoteRef["@_w:id"]
      if (endnoteId) {
        contentParts.push(`[^endnote-${endnoteId}]`)
      }
    }

    // Handle comment references
    const commentRef = run["w:commentReference"]
    if (commentRef) {
      const commentId = commentRef["@_w:id"]
      if (commentId && documentData?.__comments?.has(commentId)) {
        contentParts.push(` [^comment-${commentId}]`)
      }
    }

    // Handle tabs (but not breaks - we handle those with text elements)
    if (run["w:tab"] || run.tab) {
      contentParts.push("\t")
    }

    warningCollector?.incrementStat("elementsProcessed")
  }

  // Add paragraph-level breaks (like textWrapping breaks)
  // These breaks are typically between runs, so we add them as line breaks
  if (breaksArray.length > 0 && breaksArray[0]) {
    // For each break, add a newline
    for (const br of breaksArray) {
      if (br && typeof br === "object") {
        contentParts.push("\n")
      }
    }
  }

  // Join content parts preserving the structure
  text = contentParts.join("")

  // Add inline code fragments
  if (codeFragments.length > 0) {
    text += " " + codeFragments.join(" ")
  }

  // Extract math equations and append as placeholders
  const mathText = extractMathFromParagraph(paragraph)
  if (mathText) {
    if (text.trim()) {
      text += " " + mathText
    } else {
      text = mathText
    }
  }

  // Apply code block formatting
  if (isCodeBlock && text.trim()) {
    // Wrap in code block markers
    text = "```\n" + text.trim() + "\n```"
  }

  // Apply list formatting
  if (isListItem && text.trim() && !isCodeBlock) {
    const indent = "  ".repeat(listLevel)
    text = indent + "- " + text.trim()
  }

  // Apply heading formatting
  if (!isListItem && !isCodeBlock && text.trim()) {
    const headingPrefix = getHeadingPrefix(paragraph)
    text = headingPrefix + text.trim()
  }

  return text
}

/**
 * Extract text from table elements with enhanced cell merging support
 */
function extractTextFromTable(
  table: any,
  documentData?: any,
  warningCollector?: WarningCollector,
): string {
  if (!table) return ""

  // Use enhanced table processing with merging detection
  return extractTextFromTableWithMerging(table, documentData, warningCollector)
}

/**
 * Extract text from text boxes and shapes with enhanced debugging and deep extraction
 */
function extractTextFromTextBox(textBox: any, documentData?: any): string {
  if (!textBox) return ""

  Logger.debug("Processing textBox:", JSON.stringify(textBox, null, 2))

  let text = ""

  // Look for txbxContent (text box content) - modern format
  const txbxContent =
    textBox["w:txbxContent"] || textBox["v:textbox"]?.["w:txbxContent"]
  if (txbxContent) {
    Logger.debug("Found w:txbxContent:", JSON.stringify(txbxContent, null, 2))

    const paragraphs = txbxContent["w:p"] || []
    const paragraphsArray = Array.isArray(paragraphs)
      ? paragraphs
      : [paragraphs]

    Logger.debug(`Processing ${paragraphsArray.length} paragraphs in textbox`)

    text = paragraphsArray
      .map((p, index) => {
        const paragraphText = extractTextFromParagraph(p, documentData)
        Logger.debug(`Paragraph ${index} text:`, paragraphText)
        return paragraphText
      })
      .join("\n")
  }

  // Also check for direct text content in VML textboxes
  if (!text && textBox["v:textbox"]) {
    const vTextbox = textBox["v:textbox"]
    Logger.debug("Found v:textbox:", JSON.stringify(vTextbox, null, 2))

    // Check for direct paragraphs
    if (vTextbox["w:p"]) {
      const paragraphs = Array.isArray(vTextbox["w:p"])
        ? vTextbox["w:p"]
        : [vTextbox["w:p"]]
      text = paragraphs
        .map((p) => extractTextFromParagraph(p, documentData))
        .join("\n")
    }
    // Check for text content
    else if (vTextbox["#text"]) {
      text = vTextbox["#text"]
    }
    // Check for nested txbxContent inside v:textbox
    else if (vTextbox["w:txbxContent"]) {
      const nestedTxbxContent = vTextbox["w:txbxContent"]
      const nestedParagraphs = nestedTxbxContent["w:p"] || []
      const nestedParagraphsArray = Array.isArray(nestedParagraphs)
        ? nestedParagraphs
        : [nestedParagraphs]

      text = nestedParagraphsArray
        .map((p) => extractTextFromParagraph(p, documentData))
        .join("\n")
    }
  }

  // Check for text in shape text paths
  if (!text && textBox["v:textpath"]) {
    const textPath = textBox["v:textpath"]
    if (textPath["@_string"]) {
      text = textPath["@_string"]
    }
  }

  // Deep recursive extraction for any missed content
  if (!text) {
    text = extractTextRecursively(textBox)
  }

  Logger.debug("Final extracted text from textbox:", text)

  // If we found text and it looks like code (has common code indicators), wrap it
  if (text.trim()) {
    const codeIndicators = [
      /^\/\//m, // Comments
      /import\s+/, // Import statements
      /\bclass\s+/, // Class definitions
      /\bfunction\s+/, // Function definitions
      /\bconst\s+/, // Const declarations
      /\blet\s+/, // Let declarations
      /\bvar\s+/, // Var declarations
      /[{};]/, // Code syntax
      /\(\s*\)/, // Function calls
      /=\s*new\s+/, // Object instantiation
      /<[^>]+>/, // XML/HTML tags
      /<\/[^>]+>/, // XML/HTML closing tags
      /<dependency[\s>]/i, // Maven dependency
      /<groupId>/i, // Maven groupId
      /<artifactId>/i, // Maven artifactId
      /<version>/i, // Maven version
      /<scope>/i, // Maven scope
      /<systemPath>/i, // Maven systemPath
      /\$\{[^}]+\}/, // Maven properties like ${project.basedir}
      /xmlns:/, // XML namespaces
      /\w+:\w+/, // Namespaced elements
      /<dependency[\s\S]*?<\/dependency>/i, // Full dependency block
      /<pre[\s>]/i, // Pre blocks
      /<\/pre>/i, // Pre closing tags
    ]

    const isLikelyCode = codeIndicators.some((pattern) => pattern.test(text))

    Logger.debug("Is likely code:", isLikelyCode)

    if (isLikelyCode) {
      return "```\n" + text.trim() + "\n```"
    }

    return `[TEXTBOX: ${text}]`
  }

  return ""
}

/**
 * Recursively extract text from any object structure
 */
function extractTextRecursively(obj: any): string {
  if (!obj || typeof obj !== "object") return ""

  let texts: string[] = []

  // Look for text nodes
  if (typeof obj["w:t"] === "string") {
    texts.push(obj["w:t"])
  } else if (obj["w:t"] && obj["w:t"]["#text"]) {
    texts.push(obj["w:t"]["#text"])
  }

  if (typeof obj["#text"] === "string") {
    texts.push(obj["#text"])
  }

  // Recursively search all properties
  for (const key in obj) {
    if (typeof obj[key] === "object") {
      const nestedText = extractTextRecursively(obj[key])
      if (nestedText) texts.push(nestedText)
    } else if (Array.isArray(obj[key])) {
      for (const item of obj[key]) {
        const nestedText = extractTextRecursively(item)
        if (nestedText) texts.push(nestedText)
      }
    }
  }

  return texts.join(" ")
}

/**
 * Extract text from shapes (including SmartArt)
 */
function extractTextFromShape(shape: any, documentData?: any): string {
  if (!shape) return ""

  let texts: string[] = []

  // Recursive function to find text in shape structures
  function findTextInShape(obj: any) {
    if (!obj || typeof obj !== "object") return

    // Look for text elements
    if (obj["a:t"] || obj["w:t"]) {
      const text = obj["a:t"] || obj["w:t"]
      if (typeof text === "string") {
        texts.push(text)
      } else if (text["#text"]) {
        texts.push(text["#text"])
      }
    }

    // Look for paragraphs in shapes
    if (obj["a:p"]) {
      const paragraphs = Array.isArray(obj["a:p"]) ? obj["a:p"] : [obj["a:p"]]
      for (const p of paragraphs) {
        findTextInShape(p)
      }
    }

    // Recursively search all properties
    for (const key in obj) {
      if (typeof obj[key] === "object") {
        findTextInShape(obj[key])
      }
    }
  }

  findTextInShape(shape)

  return texts.length > 0 ? `[SHAPE: ${texts.join(" ")}]` : ""
}

/**
 * Extract relationship ID from drawing/picture elements
 */
function extractImageRelId(element: any): string | null {
  // Enhanced search function to handle namespaced XML elements
  const searchForEmbed = (obj: any): string | null => {
    if (!obj || typeof obj !== "object") return null

    // Direct r:embed attribute (different namespace variations)
    if (obj["r:embed"]) return obj["r:embed"]
    if (obj["@_r:embed"]) return obj["@_r:embed"]
    if (obj.embed) return obj.embed

    // Search for blip elements with various namespaces
    for (const key in obj) {
      if (
        key.includes("blip") ||
        key.includes("Blip") ||
        key === "a:blip" ||
        key === "pic:blipFill"
      ) {
        const blip = obj[key]
        if (blip) {
          // Check for r:embed in the blip
          if (blip["r:embed"]) return blip["r:embed"]
          if (blip["@_r:embed"]) return blip["@_r:embed"]
          if (blip.embed) return blip.embed

          // Check nested blip elements
          const result = searchForEmbed(blip)
          if (result) return result
        }
      }

      // Recursive search for all objects
      if (typeof obj[key] === "object") {
        const result = searchForEmbed(obj[key])
        if (result) return result
      }
    }

    return null
  }

  // Handle w:drawing elements at paragraph level
  if (element["w:drawing"] || element.drawing) {
    const drawing = element["w:drawing"] || element.drawing
    return searchForEmbed(drawing)
  }

  // Handle w:pict elements at paragraph level (older format)
  if (element["w:pict"] || element.pict) {
    const pict = element["w:pict"] || element.pict
    return searchForEmbed(pict)
  }

  // Check in runs for drawing/pict elements
  const runs = element["w:r"] || []
  const runsArray = Array.isArray(runs) ? runs : [runs]

  for (const run of runsArray) {
    if (!run) continue

    // Handle w:drawing in runs
    if (run["w:drawing"] || run.drawing) {
      const drawing = run["w:drawing"] || run.drawing
      const result = searchForEmbed(drawing)
      if (result) return result
    }

    // Handle w:pict in runs (older format)
    if (run["w:pict"] || run.pict) {
      const pict = run["w:pict"] || run.pict
      const result = searchForEmbed(pict)
      if (result) return result
    }
  }

  return null
}

/**
 * Process DOCX content and extract text/image items in order with enhanced support
 */
function processDocumentContent(
  documentData: any,
  warningCollector?: WarningCollector,
): DocxContentItem[] {
  const items: DocxContentItem[] = []

  if (!documentData?.["w:document"]?.["w:body"]) {
    Logger.warn("No document body found in DOCX")
    return items
  }

  const body = documentData["w:document"]["w:body"]
  const bodyXml = documentData.__bodyXml

  // Process body elements in their natural order
  // DOCX stores elements as either single objects or arrays
  // We need to maintain the document order by processing them sequentially
  const processBodyElement = (
    elementType: string,
    element: any,
    position: number,
  ) => {
    if (!element) return

    switch (elementType) {
      case "w:p": // Paragraph
        // Check for images first
        const imageRelId = extractImageRelId(element)
        if (imageRelId) {
          Logger.debug(`Found image with relationship ID: ${imageRelId}`)
          items.push({
            type: "image",
            relId: imageRelId,
            pos: position,
          })
          return
        }

        // Extract all content from paragraph including text boxes in order
        const paragraphContent = extractCompleteTextFromParagraph(
          element,
          documentData,
        )

        if (paragraphContent.trim()) {
          items.push({
            type: "text",
            content: cleanText(paragraphContent),
            pos: position,
          })
        }
        break

      case "w:tbl": // Table
        const tableText = extractTextFromTable(element, documentData)
        if (tableText.trim()) {
          items.push({
            type: "text",
            content: cleanText(tableText),
            pos: position,
          })
        }
        break

      case "w:sdt": // Structured Document Tag (can contain various content)
        const sdtContent = element["w:sdtContent"]
        if (sdtContent) {
          // Recursively process SDT content
          const sdtItems = processDocumentContent({
            "w:document": { "w:body": sdtContent },
          })
          for (const item of sdtItems) {
            item.pos = position
            items.push(item)
          }
        }
        break

      case "mc:AlternateContent": // Alternative content (often contains drawings/shapes)
        const choice = element["mc:Choice"]
        const fallback = element["mc:Fallback"]

        // Try choice first, then fallback
        const content = choice || fallback
        if (content) {
          // Look for drawings, shapes, etc.
          const drawing = content["w:drawing"]
          if (drawing) {
            const imageId = extractImageRelId({ "w:drawing": drawing })
            if (imageId) {
              items.push({
                type: "image",
                relId: imageId,
                pos: position,
              })
            } else {
              // Try to extract text from shapes
              const shapeText = extractTextFromShape(drawing, documentData)
              if (shapeText) {
                items.push({
                  type: "text",
                  content: cleanText(shapeText),
                  pos: position,
                })
              }
            }
          }
        }
        break

      case "w:txbxContent": // Standalone text box content
        // Process paragraphs within the text box content
        const paragraphs = element["w:p"] || []
        const paragraphsArray = Array.isArray(paragraphs)
          ? paragraphs
          : [paragraphs]

        const textBoxText = paragraphsArray
          .map((p: any) => extractTextFromParagraph(p, documentData))
          .filter((text: string) => text.trim())
          .join("\n")

        if (textBoxText) {
          // Check if it looks like code
          const codeIndicators = [
            /^\/\//m,
            /import\s+/,
            /\bclass\s+/,
            /\bfunction\s+/,
            /\bconst\s+/,
            /\blet\s+/,
            /\bvar\s+/,
            /[{};]/,
            /\(\s*\)/,
            /=\s*new\s+/,
            /<[^>]+>/, // XML/HTML tags
            /<\/[^>]+>/, // XML/HTML closing tags
            /<dependency>/i, // Maven dependency
            /<groupId>/i, // Maven groupId
            /<artifactId>/i, // Maven artifactId
            /<version>/i, // Maven version
            /<scope>/i, // Maven scope
            /<systemPath>/i, // Maven systemPath
            /\$\{[^}]+\}/, // Maven properties like ${project.basedir}
            /xmlns:/, // XML namespaces
            /\w+:\w+/, // Namespaced elements
            /<dependency[\s\S]*?<\/dependency>/i, // Full dependency block
            /<pre[\s>]/i, // Pre blocks
            /<\/pre>/i, // Pre closing tags
          ]

          const isLikelyCode = codeIndicators.some((pattern) =>
            pattern.test(textBoxText),
          )

          const formattedText = isLikelyCode
            ? "```\n" + textBoxText.trim() + "\n```"
            : `[TEXTBOX: ${textBoxText}]`

          items.push({
            type: "text",
            content: cleanText(formattedText),
            pos: position,
          })
        }
        break
    }
  }

  // If we have the raw XML, parse it to maintain order
  if (bodyXml) {
    // We need to process elements in the exact order they appear in the XML
    // This includes text boxes that are embedded within paragraphs

    // First, let's find all content-bearing elements and their positions
    const contentElements: Array<{
      type: string
      position: number
      element: any
    }> = []

    // Find paragraphs and their positions
    const paragraphRegex = /<w:p[\s>]/g
    let match
    let pIndex = 0
    const paragraphs = body["w:p"]
      ? Array.isArray(body["w:p"])
        ? body["w:p"]
        : [body["w:p"]]
      : []

    while ((match = paragraphRegex.exec(bodyXml)) !== null) {
      if (pIndex < paragraphs.length) {
        contentElements.push({
          type: "w:p",
          position: match.index,
          element: paragraphs[pIndex++],
        })
      }
    }

    // Find tables and their positions
    const tableRegex = /<w:tbl[\s>]/g
    let tblIndex = 0
    const tables = body["w:tbl"]
      ? Array.isArray(body["w:tbl"])
        ? body["w:tbl"]
        : [body["w:tbl"]]
      : []

    while ((match = tableRegex.exec(bodyXml)) !== null) {
      if (tblIndex < tables.length) {
        contentElements.push({
          type: "w:tbl",
          position: match.index,
          element: tables[tblIndex++],
        })
      }
    }

    // Find SDTs and their positions
    const sdtRegex = /<w:sdt[\s>]/g
    let sdtIndex = 0
    const sdts = body["w:sdt"]
      ? Array.isArray(body["w:sdt"])
        ? body["w:sdt"]
        : [body["w:sdt"]]
      : []

    while ((match = sdtRegex.exec(bodyXml)) !== null) {
      if (sdtIndex < sdts.length) {
        contentElements.push({
          type: "w:sdt",
          position: match.index,
          element: sdts[sdtIndex++],
        })
      }
    }

    // Find AlternateContent and their positions
    const altContentRegex = /<mc:AlternateContent[\s>]/g
    let altIndex = 0
    const altContents = body["mc:AlternateContent"]
      ? Array.isArray(body["mc:AlternateContent"])
        ? body["mc:AlternateContent"]
        : [body["mc:AlternateContent"]]
      : []

    while ((match = altContentRegex.exec(bodyXml)) !== null) {
      if (altIndex < altContents.length) {
        contentElements.push({
          type: "mc:AlternateContent",
          position: match.index,
          element: altContents[altIndex++],
        })
      }
    }

    // Find standalone text box content
    const txbxContentRegex = /<w:txbxContent[\s>]/g
    let txbxIndex = 0
    const txbxContents = body["w:txbxContent"]
      ? Array.isArray(body["w:txbxContent"])
        ? body["w:txbxContent"]
        : [body["w:txbxContent"]]
      : []

    while ((match = txbxContentRegex.exec(bodyXml)) !== null) {
      if (txbxIndex < txbxContents.length) {
        contentElements.push({
          type: "w:txbxContent",
          position: match.index,
          element: txbxContents[txbxIndex++],
        })
      }
    }

    // Sort all elements by their position in the XML
    contentElements.sort((a, b) => a.position - b.position)

    // Process elements in their XML order
    Logger.debug(`Processing ${contentElements.length} elements in XML order`)

    contentElements.forEach((item, index) => {
      Logger.debug(
        `Processing element ${index}: type=${item.type}, position=${item.position}`,
      )
      processBodyElement(item.type, item.element, index)
    })
  } else {
    // Fallback to the old method if we don't have XML
    const elementsByType: { [key: string]: any[] } = {
      "w:p": body["w:p"]
        ? Array.isArray(body["w:p"])
          ? body["w:p"]
          : [body["w:p"]]
        : [],
      "w:tbl": body["w:tbl"]
        ? Array.isArray(body["w:tbl"])
          ? body["w:tbl"]
          : [body["w:tbl"]]
        : [],
      "w:sdt": body["w:sdt"]
        ? Array.isArray(body["w:sdt"])
          ? body["w:sdt"]
          : [body["w:sdt"]]
        : [],
      "mc:AlternateContent": body["mc:AlternateContent"]
        ? Array.isArray(body["mc:AlternateContent"])
          ? body["mc:AlternateContent"]
          : [body["mc:AlternateContent"]]
        : [],
    }

    let position = 0

    // Process all elements
    for (const type in elementsByType) {
      const elements = elementsByType[type]
      elements.forEach((element: any) => {
        processBodyElement(type, element, position++)
      })
    }
  }

  // Sort items by position to ensure correct order
  items.sort((a, b) => a.pos - b.pos)

  // Reassign sequential positions
  items.forEach((item, index) => {
    item.pos = index
  })

  Logger.debug(
    `Processed ${items.length} content items, ${items.filter((i) => i.type === "image").length} images`,
  )
  return items
}

/**
 * Extract footnotes from DOCX document
 */
async function extractFootnotes(
  zip: JSZip,
  parser: XMLParser,
): Promise<string> {
  try {
    const footnotesXml = zip.file("word/footnotes.xml")
    if (!footnotesXml) return ""

    const footnotesText = await footnotesXml.async("text")
    const footnotesData = parser.parse(footnotesText)
    if (!footnotesData?.["w:footnotes"]?.["w:footnote"]) return ""

    const footnotes = footnotesData["w:footnotes"]["w:footnote"]
    const footnotesArray = Array.isArray(footnotes) ? footnotes : [footnotes]

    return footnotesArray
      .map((footnote) => {
        const id = footnote["@_w:id"]
        if (!id || id === "-1" || id === "0") return "" // Skip separator and continuation footnotes

        const paragraphs = footnote["w:p"] || []
        const paragraphsArray = Array.isArray(paragraphs)
          ? paragraphs
          : [paragraphs]

        const content = paragraphsArray
          .map((p) => extractTextFromParagraph(p))
          .join(" ")
          .trim()

        return content ? `[^${id}]: ${content}` : ""
      })
      .filter((f) => f)
      .join("\n")
  } catch (error) {
    Logger.warn(
      `Could not extract footnotes: ${error instanceof Error ? error.message : error}`,
    )
    return ""
  }
}

/**
 * Extract endnotes from DOCX document
 */
async function extractEndnotes(zip: JSZip, parser: XMLParser): Promise<string> {
  try {
    const endnotesXml = zip.file("word/endnotes.xml")
    if (!endnotesXml) return ""

    const endnotesText = await endnotesXml.async("text")
    const endnotesData = parser.parse(endnotesText)
    if (!endnotesData?.["w:endnotes"]?.["w:endnote"]) return ""

    const endnotes = endnotesData["w:endnotes"]["w:endnote"]
    const endnotesArray = Array.isArray(endnotes) ? endnotes : [endnotes]

    return endnotesArray
      .map((endnote) => {
        const id = endnote["@_w:id"]
        if (!id || id === "-1" || id === "0") return "" // Skip separator and continuation endnotes

        const paragraphs = endnote["w:p"] || []
        const paragraphsArray = Array.isArray(paragraphs)
          ? paragraphs
          : [paragraphs]

        const content = paragraphsArray
          .map((p) => extractTextFromParagraph(p))
          .join(" ")
          .trim()

        return content ? `[^endnote-${id}]: ${content}` : ""
      })
      .filter((f) => f)
      .join("\n")
  } catch (error) {
    Logger.warn(
      `Could not extract endnotes: ${error instanceof Error ? error.message : error}`,
    )
    return ""
  }
}

/**
 * Extract headers and footers from DOCX document
 */
async function extractHeadersAndFooters(
  zip: JSZip,
  parser: XMLParser,
): Promise<string> {
  let headerFooter = ""

  try {
    // Extract headers
    for (let i = 1; i <= 3; i++) {
      const headerFile = zip.file(`word/header${i}.xml`)
      if (headerFile) {
        const headerText = await headerFile.async("text")
        const headerData = parser.parse(headerText)
        if (headerData?.["w:hdr"]) {
          const hdr = headerData["w:hdr"]

          // Process all elements in header
          const headerContent: string[] = []

          // Process paragraphs
          if (hdr["w:p"]) {
            const paragraphs = Array.isArray(hdr["w:p"])
              ? hdr["w:p"]
              : [hdr["w:p"]]
            for (const p of paragraphs) {
              const text = extractTextFromParagraph(p)
              if (text.trim()) headerContent.push(text)
            }
          }

          // Process tables
          if (hdr["w:tbl"]) {
            const tables = Array.isArray(hdr["w:tbl"])
              ? hdr["w:tbl"]
              : [hdr["w:tbl"]]
            for (const tbl of tables) {
              const text = extractTextFromTable(tbl)
              if (text.trim()) headerContent.push(text)
            }
          }

          if (headerContent.length > 0) {
            headerFooter += `Header (${i}):\n${headerContent.join("\n")}\n\n`
          }
        }
      }
    }

    // Extract footers
    for (let i = 1; i <= 3; i++) {
      const footerFile = zip.file(`word/footer${i}.xml`)
      if (footerFile) {
        const footerText = await footerFile.async("text")
        const footerData = parser.parse(footerText)
        if (footerData?.["w:ftr"]) {
          const ftr = footerData["w:ftr"]

          // Process all elements in footer
          const footerContent: string[] = []

          // Process paragraphs
          if (ftr["w:p"]) {
            const paragraphs = Array.isArray(ftr["w:p"])
              ? ftr["w:p"]
              : [ftr["w:p"]]
            for (const p of paragraphs) {
              const text = extractTextFromParagraph(p)
              if (text.trim()) footerContent.push(text)
            }
          }

          // Process tables
          if (ftr["w:tbl"]) {
            const tables = Array.isArray(ftr["w:tbl"])
              ? ftr["w:tbl"]
              : [ftr["w:tbl"]]
            for (const tbl of tables) {
              const text = extractTextFromTable(tbl)
              if (text.trim()) footerContent.push(text)
            }
          }

          if (footerContent.length > 0) {
            headerFooter += `Footer (${i}):\n${footerContent.join("\n")}\n\n`
          }
        }
      }
    }
  } catch (error) {
    Logger.warn(
      `Could not extract headers/footers: ${error instanceof Error ? error.message : error}`,
    )
  }

  return headerFooter
}

/**
 * Parse relationships file to map relationship IDs to file paths
 */
function parseRelationships(relsData: any): Map<string, string> {
  const relationships = new Map<string, string>()

  if (!relsData?.Relationships?.Relationship) {
    return relationships
  }

  const rels = relsData.Relationships.Relationship
  const relsArray = Array.isArray(rels) ? rels : [rels]

  for (const rel of relsArray) {
    if (rel["@_Id"] && rel["@_Target"]) {
      // Remove leading slash and word/ prefix if present
      let target = rel["@_Target"]
      if (target.startsWith("/")) target = target.substring(1)
      if (target.startsWith("word/")) target = target.substring(5)

      relationships.set(rel["@_Id"], target)
    }
  }

  return relationships
}

/**
 * Process text items into chunks and add to results
 * Returns the overlap text to maintain continuity across images
 */
function processTextItems(
  textItems: string[],
  text_chunks: string[],
  text_chunk_pos: number[],
  startPos: number,
  overlapBytes: number = 32,
): { nextPos: number; overlapText: string } {
  if (textItems.length === 0) return { nextPos: startPos, overlapText: "" }

  const cleanedText = textItems.join("\n")
  const chunks = chunkTextByParagraph(cleanedText, 512, 128)

  let currentPos = startPos
  for (const chunk of chunks) {
    text_chunks.push(chunk)
    text_chunk_pos.push(currentPos++)
  }

  // Return overlap text for continuity across images
  // Take the last overlapBytes from the processed text
  let overlapText = ""
  let overlapLen = 0
  for (let i = cleanedText.length - 1; i >= 0; i--) {
    const charBytes = Buffer.byteLength(cleanedText[i], "utf8")
    if (overlapLen + charBytes > overlapBytes) break
    overlapText = cleanedText[i] + overlapText
    overlapLen += charBytes
  }

  return { nextPos: currentPos, overlapText }
}

export async function extractTextAndImagesWithChunksFromDocx(
  data: Uint8Array,
  docid: string = crypto.randomUUID(),
  extractImages: boolean = false,
  describeImages: boolean = true,
  logWarnings: boolean = false,
): Promise<DocxProcessingResult> {
  Logger.info(`Starting DOCX processing for document: ${docid}`)

  // Initialize warning collector for comprehensive error reporting
  const warningCollector = new WarningCollector()

  // Load the DOCX data directly
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(data)
  } catch (error) {
    const { name, message } = error as Error
    if (
      message.includes("PasswordException") ||
      name.includes("PasswordException")
    ) {
      Logger.warn("Password protected DOCX, skipping")
      warningCollector.addWarning({
        type: "general",
        message: "Password protected DOCX file",
        context: { error: message },
      })
    } else {
      Logger.error(error, `DOCX load error: ${error}`)
      warningCollector.addWarning({
        type: "general",
        message: "Failed to load DOCX file",
        context: { error: message },
      })
    }
    warningCollector.logSummary()
    return {
      text_chunks: [],
      image_chunks: [],
      text_chunk_pos: [],
      image_chunk_pos: [],
    }
  }

  try {
    // Parse the main document
    const documentXml = await zip.file("word/document.xml")?.async("text")
    if (!documentXml) {
      throw new Error("Could not find word/document.xml in DOCX file")
    }

    // Extract the body content directly from XML to maintain order
    const bodyMatch = documentXml.match(/<w:body[^>]*>([\s\S]*?)<\/w:body>/)
    const bodyXml = bodyMatch ? bodyMatch[1] : ""

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      textNodeName: "#text",
      trimValues: false, // Don't trim whitespace
    })

    const documentData = parser.parse(documentXml)
    // Store the raw body XML for order preservation
    documentData.__bodyXml = bodyXml

    let relationships: Map<string, string> | null = null
    // Always parse relationships for hyperlinks
    const relsXml = await zip
      .file("word/_rels/document.xml.rels")
      ?.async("text")
    if (relsXml) {
      const relsData = parser.parse(relsXml)
      relationships = parseRelationships(relsData)
      // Store into documentData to access during hyperlink extraction
      documentData.__rels = relationships
    }

    // Parse comments.xml
    let commentsMap: Map<string, string> = new Map()
    const commentsXml = await zip.file("word/comments.xml")?.async("text")
    if (commentsXml) {
      const commentsData = parser.parse(commentsXml)
      const comments = commentsData?.["w:comments"]?.["w:comment"]
      const commentsArray = Array.isArray(comments) ? comments : [comments]
      for (const comment of commentsArray) {
        const id = comment["@_w:id"]
        const commentParas = comment["w:p"] || []
        const commentParasArray = Array.isArray(commentParas)
          ? commentParas
          : [commentParas]
        const text = commentParasArray
          .map((p) => extractTextFromParagraph(p))
          .join(" ")
          .trim()
        if (id && text) {
          commentsMap.set(id, text)
        }
      }
    }
    documentData.__comments = commentsMap

    // Extract content items in order
    const contentItems = processDocumentContent(documentData, warningCollector)

    // Extract footnotes, endnotes, headers, and footers
    const footnotes = await extractFootnotes(zip, parser)
    const endnotes = await extractEndnotes(zip, parser)
    const headerFooter = await extractHeadersAndFooters(zip, parser)

    let text_chunks: string[] = []
    let image_chunks: string[] = []
    let text_chunk_pos: number[] = []
    let image_chunk_pos: number[] = []

    let globalSeq = 0
    let crossImageOverlap = "" // Track overlap across images

    const imageSeqToHash = new Map<number, string>()
    const imageDescribeBatch = new DeferredImageDescriptionBatch()

    // Process items sequentially, handling overlap properly
    let textBuffer: string[] = []
    let textStartPos = globalSeq

    const flushTextBuffer = () => {
      if (textBuffer.length > 0) {
        // If we have crossImageOverlap, prepend it to the text buffer
        let textToProcess = textBuffer
        if (crossImageOverlap && extractImages) {
          textToProcess = [crossImageOverlap + " " + textBuffer.join("\n")]
          crossImageOverlap = "" // Clear after using
        }

        const { nextPos, overlapText } = processTextItems(
          textToProcess,
          text_chunks,
          text_chunk_pos,
          textStartPos,
        )
        textBuffer = []
        textStartPos = nextPos
        globalSeq = nextPos
        // Only store overlap for continuation if we're extracting images
        if (extractImages) {
          crossImageOverlap = overlapText
        }
      }
    }

    for (const item of contentItems) {
      if (item.type === "text" && item.content) {
        textBuffer.push(item.content)
      } else if (
        item.type === "image" &&
        item.relId &&
        extractImages &&
        relationships
      ) {
        // Flush any pending text before processing image
        flushTextBuffer()

        // Process image
        const imagePath = relationships.get(item.relId)
        if (imagePath) {
          // 5MB limit
          try {
            const fullImagePath = `word/${imagePath}`
            const imageFile = zip.file(fullImagePath)

            if (imageFile) {
              const imageBuffer = await imageFile.async("nodebuffer")

              // Skip small images
              if (imageBuffer.length < 10000) {
                Logger.debug(`Skipping small image: ${imagePath}`)
                continue
              }

              if (
                imageBuffer.length >
                DATASOURCE_CONFIG.MAX_IMAGE_FILE_SIZE_MB * 1024 * 1024
              ) {
                Logger.warn(
                  `Skipping large image (${(imageBuffer.length / (1024 * 1024)).toFixed(2)} MB): ${imagePath}`,
                )
                continue
              }

              const imageExtension = path.extname(imagePath).toLowerCase()
              if (
                !DATASOURCE_CONFIG.SUPPORTED_IMAGE_TYPES.has(
                  `image/${imageExtension.slice(1)}`,
                )
              ) {
                Logger.warn(
                  `Unsupported image format: ${imageExtension}. Skipping image: ${imagePath}`,
                )
                continue
              }

              const imageHash = md5ImageBuffer(imageBuffer)
              let outputPath: string
              try {
                const baseDir = path.resolve(
                  process.env.IMAGE_DIR || "downloads/xyne_images_db",
                )
                const outputDir = path.join(baseDir, docid)
                await fsPromises.mkdir(outputDir, { recursive: true })

                const saveExtension = path.extname(imagePath) || ".png"
                const imageFilename = `${globalSeq}${saveExtension}`
                outputPath = path.join(outputDir, imageFilename)

                await fsPromises.writeFile(
                  outputPath,
                  new Uint8Array(imageBuffer),
                )
                Logger.info(`Saved image to: ${outputPath}`)
              } catch (saveError) {
                Logger.error(
                  `Failed to save image ${imagePath}: ${saveError instanceof Error ? saveError.message : saveError}`,
                )
                continue
              }

              const description =
                imageDescribeBatch.registerImagePathForLaterDescribe(
                  imageHash,
                  path.resolve(outputPath),
                  describeImages,
                )

              image_chunks.push(description)
              image_chunk_pos.push(globalSeq)
              imageSeqToHash.set(globalSeq, imageHash)
              globalSeq++

              Logger.debug(`Successfully processed image: ${imagePath}`)
            } else {
              Logger.warn(`Could not find image file: ${fullImagePath}`)
            }
          } catch (error) {
            Logger.warn(
              `Failed to process image ${imagePath}: ${error instanceof Error ? error.message : error}`,
            )
          }
        } else {
          Logger.warn(`Could not resolve relationship ID: ${item.relId}`)
        }
      }
    }

    // Flush any remaining text with cross-image overlap
    if (textBuffer.length > 0 || crossImageOverlap) {
      // Combine any remaining text with accumulated image placeholders
      const textContent = textBuffer.length > 0 ? textBuffer.join("\n") : ""
      const combinedText = crossImageOverlap
        ? crossImageOverlap + " " + textContent
        : textContent

      if (combinedText.trim()) {
        const { nextPos } = processTextItems(
          [combinedText],
          text_chunks,
          text_chunk_pos,
          textStartPos,
        )
        globalSeq = nextPos
        crossImageOverlap = "" // Clear after using
      }
    }

    // Add footnotes, endnotes, and headers/footers to the end if they exist
    const additionalContent = [footnotes, endnotes, headerFooter]
      .filter(Boolean)
      .join("\n\n")

    if (additionalContent.trim()) {
      const postProcessedContent = postProcessText(additionalContent)
      const finalContent = crossImageOverlap
        ? crossImageOverlap + " " + postProcessedContent
        : postProcessedContent
      const { nextPos } = processTextItems(
        [finalContent],
        text_chunks,
        text_chunk_pos,
        globalSeq,
      )
      globalSeq = nextPos
      crossImageOverlap = "" // Clear after final processing
    }

    // Add comments as footnotes
    if (commentsMap.size > 0) {
      const commentFootnotes = Array.from(commentsMap.entries()).map(
        ([id, text]) => `[^comment-${id}]: ${text}`,
      )
      const postProcessed = postProcessText(commentFootnotes.join("\n"))
      const finalContent = crossImageOverlap
        ? crossImageOverlap + " " + postProcessed
        : postProcessed
      const { nextPos } = processTextItems(
        [finalContent],
        text_chunks,
        text_chunk_pos,
        globalSeq,
      )
      globalSeq = nextPos
      //   crossImageOverlap = "" // Clear after final processing
    }

    await imageDescribeBatch.flushDescribeQueue(describeImages)
    imageDescribeBatch.stripRejectedImageRows(
      image_chunks,
      image_chunk_pos,
      imageSeqToHash,
    )
    imageDescribeBatch.applyResolvedDescriptions(
      image_chunks,
      image_chunk_pos,
      imageSeqToHash,
    )

    Logger.info(
      `DOCX processing completed. Total text chunks: ${text_chunks.length}, Total image chunks: ${image_chunks.length}`,
    )

    // Log processing summary with warnings
    if (logWarnings) {
      warningCollector.logSummary()
    }

    return {
      text_chunks,
      image_chunks,
      text_chunk_pos,
      image_chunk_pos,
    }
  } finally {
    // @ts-ignore
    zip = null
  }
}
