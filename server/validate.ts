export const isURLValid = (url: string): boolean => {
  try {
    new URL(url)
    return true
  } catch {
    return false
  }
}
