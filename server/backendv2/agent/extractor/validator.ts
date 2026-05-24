// JSON Schema validator for extractor agents.
//
// Scope is intentionally narrow: only the shapes our visual schema builder
// can produce (object root with string/number/boolean/enum/array/object
// children). That's why we hand-roll instead of pulling in ajv — the
// dependency footprint isn't worth it for a subset this small.
//
// Returns either { ok: true, value } or { ok: false, errors } with
// path-qualified messages suitable for re-prompting the LLM.

export type ValidationError = {
  /** JSON-pointer-ish path, e.g. "$.invoices[2].total". */
  path: string
  message: string
}

export type ValidationResult<T = unknown> =
  | { ok: true; value: T; rawJson: string }
  | { ok: false; errors: ValidationError[]; rawJson?: string }

const typeName = (v: unknown): string => {
  if (v === null) return "null"
  if (Array.isArray(v)) return "array"
  return typeof v
}

/**
 * LLMs frequently wrap JSON in markdown fences or precede it with prose.
 * Pull out the first plausible JSON blob — either fenced or the first
 * balanced `{…}` / `[…]` substring. Returns the input unchanged when
 * nothing fence-like is found; JSON.parse will then surface the real
 * syntax error.
 */
export const extractJsonBlob = (text: string): string => {
  const trimmed = text.trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  if (fence?.[1]) return fence[1].trim()
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed
  const firstBrace = trimmed.search(/[{[]/)
  if (firstBrace === -1) return trimmed
  return trimmed.slice(firstBrace)
}

type JsonSchemaNode = Record<string, unknown>

const validateNode = (
  value: unknown,
  schema: JsonSchemaNode,
  path: string,
  errors: ValidationError[],
): void => {
  const t = schema["type"]
  if (typeof t !== "string") return

  if (t === "string") {
    if (typeof value !== "string") {
      errors.push({ path, message: `Expected string, got ${typeName(value)}` })
      return
    }
    const allowed = schema["enum"]
    if (Array.isArray(allowed) && !allowed.includes(value)) {
      errors.push({
        path,
        message: `Expected one of [${allowed
          .map((v) => JSON.stringify(v))
          .join(", ")}], got ${JSON.stringify(value)}`,
      })
    }
    return
  }

  if (t === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push({ path, message: `Expected number, got ${typeName(value)}` })
    }
    return
  }

  if (t === "boolean") {
    if (typeof value !== "boolean") {
      errors.push({ path, message: `Expected boolean, got ${typeName(value)}` })
    }
    return
  }

  if (t === "array") {
    if (!Array.isArray(value)) {
      errors.push({ path, message: `Expected array, got ${typeName(value)}` })
      return
    }
    const items = schema["items"]
    if (items && typeof items === "object") {
      value.forEach((v, i) => {
        validateNode(v, items as JsonSchemaNode, `${path}[${i}]`, errors)
      })
    }
    return
  }

  if (t === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors.push({ path, message: `Expected object, got ${typeName(value)}` })
      return
    }
    const props = (schema["properties"] ?? {}) as Record<string, JsonSchemaNode>
    const required = Array.isArray(schema["required"])
      ? (schema["required"] as string[])
      : []
    const obj = value as Record<string, unknown>
    for (const key of required) {
      if (!(key in obj)) {
        errors.push({ path: `${path}.${key}`, message: "Missing required field" })
      }
    }
    for (const [k, v] of Object.entries(obj)) {
      const sub = props[k]
      if (sub) {
        validateNode(v, sub, `${path}.${k}`, errors)
      } else if (schema["additionalProperties"] === false) {
        errors.push({
          path: `${path}.${k}`,
          message: "Unexpected property (not declared in schema)",
        })
      }
    }
    return
  }
}

export const validate = <T = unknown>(
  text: string,
  schema: Record<string, unknown>,
): ValidationResult<T> => {
  const blob = extractJsonBlob(text)
  let parsed: unknown
  try {
    parsed = JSON.parse(blob)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      errors: [{ path: "$", message: `Invalid JSON: ${msg}` }],
      rawJson: blob,
    }
  }
  const errors: ValidationError[] = []
  validateNode(parsed, schema, "$", errors)
  if (errors.length === 0) {
    return { ok: true, value: parsed as T, rawJson: blob }
  }
  return { ok: false, errors, rawJson: blob }
}

/**
 * Render a validation failure into a one-shot prompt fragment the LLM
 * can act on. The schema is re-attached so the model has the shape
 * right in front of it when it produces the next attempt — wrong-shape
 * errors come from the model losing track of the structure mid-loop.
 */
export const formatErrorsForRetry = (
  errors: ValidationError[],
  schema: Record<string, unknown>,
): string => {
  const bullets = errors.map((e) => `- ${e.path}: ${e.message}`).join("\n")
  return [
    "Your previous response did not conform to the required JSON schema.",
    "",
    "Validation errors:",
    bullets,
    "",
    "Required schema:",
    "```json",
    JSON.stringify(schema, null, 2),
    "```",
    "",
    "Please respond with ONLY a JSON object matching the schema. Do not include any prose, markdown, or explanation outside the JSON.",
  ].join("\n")
}
