type UUIDFallbackSource = "crypto.getRandomValues" | "Math.random"

let hasLoggedUUIDFallback = false

const logUUIDFallback = (source: UUIDFallbackSource) => {
  if (hasLoggedUUIDFallback) {
    return
  }

  hasLoggedUUIDFallback = true
  console.info("[uuid] crypto.randomUUID unavailable; using UUID fallback", {
    source,
    isSecureContext: globalThis.isSecureContext,
  })
}

const fallbackUUID = () => {
  const cryptoObj = globalThis.crypto

  if (cryptoObj?.getRandomValues) {
    logUUIDFallback("crypto.getRandomValues")

    const bytes = new Uint8Array(16)
    cryptoObj.getRandomValues(bytes)
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80

    const hex = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    )
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
      .slice(6, 8)
      .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`
  }

  throw new Error("Web Crypto API is unavailable; cannot generate a UUID")
}

export const generateUUID = () => {
  const cryptoObj = globalThis.crypto
  if (typeof cryptoObj?.randomUUID === "function") {
    return cryptoObj.randomUUID()
  }
  return fallbackUUID()
}
