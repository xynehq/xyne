const fallbackUUID = () => {
  const cryptoObj = globalThis.crypto

  if (cryptoObj?.getRandomValues) {
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

  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16)
    const nibble = char === "x" ? value : (value & 0x3) | 0x8
    return nibble.toString(16)
  })
}

export const generateUUID = () => {
  const cryptoObj = globalThis.crypto
  if (typeof cryptoObj?.randomUUID === "function") {
    return cryptoObj.randomUUID()
  }
  return fallbackUUID()
}
