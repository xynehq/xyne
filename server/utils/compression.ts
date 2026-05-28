export function compressTraceJson(json: string): Buffer {
  try {
    const t0 = Date.now()
    const compressed = Bun.gzipSync(json)
    const buffer = Buffer.from(compressed)
    const t1 = Date.now()
    console.info(
      `[TX-TIMING] compressTraceJson inputSize=${json.length} outputSize=${buffer.length} duration=${t1 - t0}ms`,
    )
    return buffer
  } catch (err) {
    console.error("Compression failed:", err)
    throw new Error("Failed to compress trace JSON")
  }
}

export function decompressTraceJson(buffer: Buffer): string {
  try {
    const t0 = Date.now()
    const decompressed = Bun.gunzipSync(new Uint8Array(buffer))
    const jsonString = new TextDecoder().decode(decompressed)
    const t1 = Date.now()
    console.info(
      `[TX-TIMING] decompressTraceJson inputSize=${buffer.length} outputSize=${jsonString.length} duration=${t1 - t0}ms`,
    )
    return jsonString
  } catch (err) {
    console.error("Decompression failed:", err)
    throw new Error("Failed to decompress trace JSON")
  }
}
