// Recursive secret-redactor. Walks any plain object / array and replaces
// values under known-sensitive keys, plus any string that pattern-matches
// a bearer token, with the literal "[REDACTED]". Returns a shallow
// clone — callers can pass the result directly to JSON.stringify.
//
// Scope: outbound LLM request bodies + headers. System prompts are NOT
// considered secrets (they're part of the agent's persona); ditto user
// messages.

const REDACTED = "[REDACTED]"

// Case-insensitive exact match on the object key. Each entry covers a
// common name that providers / SDKs use for the same logical secret.
const SENSITIVE_KEYS: ReadonlySet<string> = new Set(
  [
    "apikey",
    "api_key",
    "api-key",
    "x-api-key",
    "authorization",
    "auth",
    "cookie",
    "set-cookie",
    "session",
    "sessionid",
    "session-id",
    "x-auth-token",
    "anthropic-api-key",
    "openai-api-key",
    "bearer",
    "token",
    "access_token",
    "refresh_token",
  ].map((k): string => k.toLowerCase()),
)

// String-shaped tokens. We don't try to be exhaustive — these catch the
// shapes our providers actually return / our code passes around.
const VALUE_PATTERNS: RegExp[] = [
  /^Bearer\s+[\w._-]+/i,
  /^sk-[A-Za-z0-9_-]{16,}/, // OpenAI-style API keys
  /^anthropic_[A-Za-z0-9_-]{16,}/i,
]

const looksSecretValue = (v: string): boolean => {
  for (const re of VALUE_PATTERNS) {
    if (re.test(v)) return true
  }
  return false
}

/** Walk-and-clone. Returns a new value with redactions applied. Cycles
 *  short-circuit to "[REDACTED:cycle]" so we never infinite-loop on a
 *  payload someone forgot to defensively serialise. */
export const scrubSensitive = <T>(input: T): T => {
  const seen = new WeakSet<object>()
  const walk = (v: unknown): unknown => {
    if (v === null) return null
    if (typeof v === "string") {
      return looksSecretValue(v) ? REDACTED : v
    }
    if (typeof v !== "object") return v
    if (seen.has(v as object)) return "[REDACTED:cycle]"
    seen.add(v as object)
    if (Array.isArray(v)) {
      return v.map((entry) => walk(entry))
    }
    const out: Record<string, unknown> = {}
    for (const [k, value] of Object.entries(v)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase())) {
        out[k] = REDACTED
      } else {
        out[k] = walk(value)
      }
    }
    return out
  }
  return walk(input) as T
}
