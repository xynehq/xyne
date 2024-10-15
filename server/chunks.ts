/**
 * Chunk the input text by paragraphs with optional overlap.
 *
 * @param {string} text - The input text to be chunked.
 * @param {number} maxChunkSize - Maximum size of each chunk.
 * @param {number} overlap - Number of overlapping characters between chunks.
 * @returns {string[]} - An array of text chunks.
 */
// export const chunkTextByParagraph = (
//   text: string,
//   maxChunkSize = 512,
//   overlap = 128,
// ): string[] => {
//   // Split the text into paragraphs using newline characters
//   const paragraphs = text.split(/\n+/)

//   let chunks: string[] = []
//   let currentChunk: string[] = []
//   let currentLength = 0

//   // Helper function to add a chunk to the chunks array
//   const addChunk = (chunkArr: string[]) => {
//     chunks.push(chunkArr.join("\n"))
//     if (overlap > 0 && chunkArr.length > overlap) {
//       // Create an overlapping chunk for the next segment
//       currentChunk = chunkArr.slice(-overlap)
//       currentLength = currentChunk.join("\n").length
//     } else {
//       currentChunk = []
//       currentLength = 0
//     }
//   }

//   for (let paragraph of paragraphs) {
//     const paragraphLength = paragraph.length

//     if (paragraphLength > maxChunkSize) {
//       // Handle very long paragraphs by splitting them into smaller chunks
//       if (currentLength > 0) {
//         addChunk(currentChunk)
//       }
//       // Split the long paragraph into sentences
//       let sentences = paragraph.split(/(?<=[.!?])\s+/)
//       let subChunk = []
//       let subChunkLength = 0
//       for (let sentence of sentences) {
//         if (subChunkLength + sentence.length + 1 > maxChunkSize) {
//           addChunk(subChunk)
//           subChunk = []
//           subChunkLength = 0
//         }
//         subChunk.push(sentence)
//         subChunkLength += sentence.length + 1
//       }
//       if (subChunk.length > 0) {
//         addChunk(subChunk)
//       }
//     } else if (currentLength + paragraphLength + 1 > maxChunkSize) {
//       // If adding the current paragraph exceeds maxChunkSize, finalize the current chunk
//       addChunk(currentChunk)
//       currentChunk = [paragraph]
//       currentLength = paragraphLength
//     } else {
//       // Add the current paragraph to the current chunk
//       currentChunk.push(paragraph)
//       currentLength += paragraphLength + 1
//     }
//   }

//   // Add the last chunk if it exists
//   if (currentChunk.length > 0) {
//     addChunk(currentChunk)
//   }

//   return chunks
// }

// export const chunkTextByParagraph = (
//   text: string,
//   maxChunkSize = 512,
//   overlap = 128,
// ): string[] => {
//   // Helper function to get the byte length of a string
//   const getByteLength = (str: string) => Buffer.byteLength(str, "utf8")

//   // Helper function to clean up illegal code points
//   const cleanText = (str: string) => {
//     // Use a regular expression to remove illegal UTF-8 code points
//     return str.replace(
//       /[\u0000-\u001F\u007F-\u009F\uFDD0-\uFDEF\uFFFE\uFFFF]/g,
//       "",
//     )
//   }

//   // Clean the input text before processing
//   const cleanedText = cleanText(text)

//   // Split the cleaned text into paragraphs using newline characters
//   const paragraphs = cleanedText.split(/\n+/).filter((p) => p.length > 0)

//   let chunks: string[] = []
//   let currentChunk: string[] = []
//   let currentLength = 0

//   // Helper function to add a chunk to the chunks array
//   const addChunk = (chunkArr: string[]) => {
//     const chunkStr = chunkArr.join("\n")
//     chunks.push(chunkStr)

//     if (overlap > 0) {
//       // Calculate overlap in terms of bytes
//       let overlapBytes = 0
//       let overlapChunk: string[] = []

//       // Iterate from the end to get the overlapping paragraphs
//       for (let i = chunkArr.length - 1; i >= 0; i--) {
//         const para = chunkArr[i]
//         const paraByteLength = getByteLength(para) + 1 // +1 for newline character
//         if (overlapBytes + paraByteLength > overlap) {
//           break
//         }
//         overlapChunk.unshift(para)
//         overlapBytes += paraByteLength
//       }
//       currentChunk = overlapChunk
//       currentLength = overlapBytes
//     } else {
//       currentChunk = []
//       currentLength = 0
//     }
//   }

//   for (let paragraph of paragraphs) {
//     const paragraphByteLength = getByteLength(paragraph) + 1 // +1 for newline character

//     if (paragraphByteLength > maxChunkSize) {
//       // Handle very long paragraphs by splitting them into smaller chunks
//       if (currentLength > 0) {
//         addChunk(currentChunk)
//       }
//       // Split the long paragraph into sentences
//       let sentences = paragraph.split(/(?<=[.!?])\s+/)
//       let subChunk: string[] = []
//       let subChunkLength = 0
//       for (let sentence of sentences) {
//         const sentenceByteLength = getByteLength(sentence) + 1 // +1 for space or newline
//         if (subChunkLength + sentenceByteLength > maxChunkSize) {
//           addChunk(subChunk)
//           subChunk = []
//           subChunkLength = 0
//         }
//         subChunk.push(sentence)
//         subChunkLength += sentenceByteLength
//       }
//       if (subChunk.length > 0) {
//         addChunk(subChunk)
//       }
//     } else if (currentLength + paragraphByteLength > maxChunkSize) {
//       // If adding the current paragraph exceeds maxChunkSize, finalize the current chunk
//       addChunk(currentChunk)
//       currentChunk = [paragraph]
//       currentLength = paragraphByteLength
//     } else {
//       // Add the current paragraph to the current chunk
//       currentChunk.push(paragraph)
//       currentLength += paragraphByteLength
//     }
//   }

//   // Add the last chunk if it exists
//   if (currentChunk.length > 0) {
//     addChunk(currentChunk)
//   }

//   return chunks
// }

// Addresses less chars
/**
 * Removes control characters from a string.
 *
 * @param {string} str - The input string to sanitize.
 * @returns {string} - The sanitized string without control characters.
 */
const removeControlCharacters = (str: string): string => {
  return str.replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
}

/**
 * Chunk the input text by paragraphs with optional overlap.
 *
 * @param {string} text - The input text to be chunked.
 * @param {number} maxChunkSize - Maximum size of each chunk in bytes.
 * @param {number} overlap - Number of overlapping bytes between chunks.
 * @returns {string[]} - An array of text chunks.
 */
export const chunkTextByParagraph = (
  text: string,
  maxChunkSize = 512,
  overlap = 128,
): string[] => {
  // Remove control characters from the text
  text = removeControlCharacters(text)

  const getByteLength = (str: string) => Buffer.byteLength(str, "utf8")

  // Split the text into paragraphs using newline characters
  const paragraphs = text.split(/\n+/)

  let chunks: string[] = []
  let currentChunk: string[] = []
  let currentLength = 0

  // Helper function to add a chunk to the chunks array
  const addChunk = (chunkArr: string[]) => {
    const chunkStr = chunkArr.join("\n")
    chunks.push(chunkStr)

    if (overlap > 0) {
      // Calculate overlap in terms of bytes
      let overlapBytes = 0
      let overlapChunk: string[] = []

      // Iterate from the end to get the overlapping paragraphs
      for (let i = chunkArr.length - 1; i >= 0; i--) {
        const para = chunkArr[i]
        const paraByteLength = getByteLength(para) + 1 // +1 for newline character
        if (overlapBytes + paraByteLength > overlap) {
          break
        }
        overlapChunk.unshift(para)
        overlapBytes += paraByteLength
      }
      currentChunk = overlapChunk
      currentLength = overlapBytes
    } else {
      currentChunk = []
      currentLength = 0
    }
  }

  for (let paragraph of paragraphs) {
    const paragraphByteLength = getByteLength(paragraph) + 1 // +1 for newline character

    if (paragraphByteLength > maxChunkSize) {
      // Handle very long paragraphs by splitting them into smaller chunks
      if (currentLength > 0) {
        addChunk(currentChunk)
      }
      // Split the long paragraph into sentences
      let sentences = paragraph.split(/(?<=[.!?])\s+/)
      let subChunk: string[] = []
      let subChunkLength = 0
      for (let sentence of sentences) {
        const sentenceByteLength = getByteLength(sentence) + 1 // +1 for space or newline
        if (subChunkLength + sentenceByteLength > maxChunkSize) {
          addChunk(subChunk)
          subChunk = []
          subChunkLength = 0
        }
        subChunk.push(sentence)
        subChunkLength += sentenceByteLength
      }
      if (subChunk.length > 0) {
        addChunk(subChunk)
      }
    } else if (currentLength + paragraphByteLength > maxChunkSize) {
      // If adding the current paragraph exceeds maxChunkSize, finalize the current chunk
      addChunk(currentChunk)
      currentChunk = [paragraph]
      currentLength = paragraphByteLength
    } else {
      // Add the current paragraph to the current chunk
      currentChunk.push(paragraph)
      currentLength += paragraphByteLength
    }
  }

  // Add the last chunk if it exists
  if (currentChunk.length > 0) {
    addChunk(currentChunk)
  }

  return chunks
}

interface Document {
  body: string
}

interface Chunk {
  chunk: string
  chunkIndex: number
}

export const chunkDocument = (body: string): Chunk[] => {
  let out: Chunk[] = []
  let chunks = chunkTextByParagraph(body, 512, 0)
  for (const [index, chunk] of chunks.entries()) {
    out.push({
      chunk,
      chunkIndex: index,
    })
  }
  return out
}
