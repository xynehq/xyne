/**
 * Chunk the input text by paragraphs with optional overlap.
 *
 * @param {string} text - The input text to be chunked.
 * @param {number} maxChunkSize - Maximum size of each chunk.
 * @param {number} overlap - Number of overlapping characters between chunks.
 * @returns {string[]} - An array of text chunks.
 */
export const chunkTextByParagraph = (
    text: string,
    maxChunkSize = 512,
    overlap = 128,
): string[] => {
    // Split the text into paragraphs using newline characters
    const paragraphs = text.split(/\n+/);

    let chunks: string[] = [];
    let currentChunk: string[] = [];
    let currentLength = 0;

    // Helper function to add a chunk to the chunks array
    const addChunk = (chunkArr: string[]) => {
        chunks.push(chunkArr.join("\n"));
        if (overlap > 0 && chunkArr.length > overlap) {
            // Create an overlapping chunk for the next segment
            currentChunk = chunkArr.slice(-overlap);
            currentLength = currentChunk.join("\n").length;
        } else {
            currentChunk = [];
            currentLength = 0;
        }
    };

    for (let paragraph of paragraphs) {
        const paragraphLength = paragraph.length;

        if (paragraphLength > maxChunkSize) {
            // Handle very long paragraphs by splitting them into smaller chunks
            if (currentLength > 0) {
                addChunk(currentChunk);
            }
            // Split the long paragraph into sentences
            let sentences = paragraph.split(/(?<=[.!?])\s+/);
            let subChunk = [];
            let subChunkLength = 0;
            for (let sentence of sentences) {
                if (subChunkLength + sentence.length + 1 > maxChunkSize) {
                    addChunk(subChunk);
                    subChunk = [];
                    subChunkLength = 0;
                }
                subChunk.push(sentence);
                subChunkLength += sentence.length + 1;
            }
            if (subChunk.length > 0) {
                addChunk(subChunk);
            }
        } else if (currentLength + paragraphLength + 1 > maxChunkSize) {
            // If adding the current paragraph exceeds maxChunkSize, finalize the current chunk
            addChunk(currentChunk);
            currentChunk = [paragraph];
            currentLength = paragraphLength;
        } else {
            // Add the current paragraph to the current chunk
            currentChunk.push(paragraph);
            currentLength += paragraphLength + 1;
        }
    }

    // Add the last chunk if it exists
    if (currentChunk.length > 0) {
        addChunk(currentChunk);
    }

    return chunks;
};

interface Document {
    body: string
}

interface Chunk {
    chunk: string,
    chunkIndex: number
}

export const chunkDocument = (body: string): Chunk[] => {
    let out: Chunk[] = []
    let chunks = chunkTextByParagraph(body, 512, 0);
    for (const [index, chunk] of chunks.entries()) {
        out.push({
            chunk,
            chunkIndex: index,
        });
    }
    return out;
};