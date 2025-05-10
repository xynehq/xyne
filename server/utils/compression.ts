export function compressTraceJson(json: string): Buffer {
  try {
    const compressed = Bun.gzipSync(json)
    const buffer = Buffer.from(compressed)
    return buffer
  } catch (err) {
    console.error("Compression failed:", err)
    throw new Error("Failed to compress trace JSON")
  }
}

export function decompressTraceJson(buffer: Buffer): string {
  try {
    const decompressed = Bun.gunzipSync(new Uint8Array(buffer))
    const jsonString = new TextDecoder().decode(decompressed)
    return jsonString
  } catch (err) {
    console.error("Decompression failed:", err)
    throw new Error("Failed to decompress trace JSON")
  }
}
