export function getDateForAI() {
  const today = new Date()
  const options: Intl.DateTimeFormatOptions = {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }
  return today.toLocaleDateString("en-GB", options)
}
