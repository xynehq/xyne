// Per-user starred-agent set. There's no backend `star` endpoint on either
// surface, so we keep this in localStorage keyed by the signed-in user's
// email — switching accounts on the same browser shows the right set, and
// signing out doesn't lose it.

const KEY_PREFIX = "ui2.starredAgents:"

const keyFor = (userEmail: string): string => `${KEY_PREFIX}${userEmail}`

const readSet = (userEmail: string): Set<string> => {
  try {
    const raw = window.localStorage.getItem(keyFor(userEmail))
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((v): v is string => typeof v === "string"))
    }
    return new Set()
  } catch {
    return new Set()
  }
}

const writeSet = (userEmail: string, set: Set<string>): void => {
  try {
    window.localStorage.setItem(
      keyFor(userEmail),
      JSON.stringify(Array.from(set)),
    )
  } catch {
    // localStorage may be unavailable (private mode); ignore.
  }
}

export const getStarredAgents = (userEmail: string): Set<string> =>
  readSet(userEmail)

export const isAgentStarred = (
  userEmail: string,
  externalId: string,
): boolean => readSet(userEmail).has(externalId)

export const toggleAgentStar = (
  userEmail: string,
  externalId: string,
): Set<string> => {
  const next = readSet(userEmail)
  if (next.has(externalId)) {
    next.delete(externalId)
  } else {
    next.add(externalId)
  }
  writeSet(userEmail, next)
  return next
}
