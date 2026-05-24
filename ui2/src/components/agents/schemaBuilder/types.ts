// Internal model for the visual schema builder. The form edits a
// nested tree of SchemaField nodes; on submit it serializes to JSON
// Schema (the shape persisted in agents.response_schema) and on load
// it parses JSON Schema back. Keeping the internal model distinct
// from JSON Schema makes the UI simpler — every field has a `name`
// and `required` directly, instead of being split across `properties`
// and `required[]`.

export type SchemaPrimitiveType =
  | "string"
  | "number"
  | "boolean"
  | "enum"
  | "array"
  | "object"

export type SchemaField = {
  /** Stable id for React keys. Not persisted. */
  id: string
  /** Property key in the parent object. */
  name: string
  type: SchemaPrimitiveType
  required: boolean
  description?: string
  /** For enum — allowed string values. */
  enumValues?: string[]
  /** For array — the type of items. We model arrays as homogeneous
   *  collections of a single SchemaField shape. */
  itemType?: SchemaField
  /** For object — nested fields. */
  properties?: SchemaField[]
}

export type ExtractorSchema = {
  /** Top-level field list. The root is always an object. */
  fields: SchemaField[]
  /** Optional description on the root object. */
  description?: string
}

// ──────────────────────────────────────────────────────────────────
//  JSON Schema serialisation
// ──────────────────────────────────────────────────────────────────

type JsonSchemaObject = {
  type: "object"
  description?: string
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  additionalProperties?: false
}

type JsonSchemaNode =
  | { type: "string"; description?: string }
  | { type: "number"; description?: string }
  | { type: "boolean"; description?: string }
  | { type: "string"; enum: string[]; description?: string }
  | {
      type: "array"
      items: JsonSchemaNode
      description?: string
    }
  | JsonSchemaObject

const fieldToJsonNode = (f: SchemaField): JsonSchemaNode => {
  const description = f.description?.trim()
    ? { description: f.description.trim() }
    : {}
  switch (f.type) {
    case "string":
      return { type: "string", ...description }
    case "number":
      return { type: "number", ...description }
    case "boolean":
      return { type: "boolean", ...description }
    case "enum":
      return {
        type: "string",
        enum: f.enumValues ?? [],
        ...description,
      }
    case "array":
      return {
        type: "array",
        items: f.itemType
          ? fieldToJsonNode(f.itemType)
          : { type: "string" },
        ...description,
      }
    case "object":
      return objectShape(f.properties ?? [], f.description)
  }
}

const objectShape = (
  fields: SchemaField[],
  description?: string,
): JsonSchemaObject => ({
  type: "object",
  ...(description?.trim() ? { description: description.trim() } : {}),
  properties: Object.fromEntries(fields.map((f) => [f.name, fieldToJsonNode(f)])),
  required: fields.filter((f) => f.required).map((f) => f.name),
  additionalProperties: false,
})

export const toJsonSchema = (
  schema: ExtractorSchema,
): Record<string, unknown> =>
  objectShape(schema.fields, schema.description) as unknown as Record<
    string,
    unknown
  >

// ──────────────────────────────────────────────────────────────────
//  JSON Schema deserialisation (best-effort)
// ──────────────────────────────────────────────────────────────────

const newId = (): string =>
  `f_${Math.random().toString(36).slice(2, 10)}`

const nodeToField = (
  name: string,
  node: unknown,
  required: boolean,
): SchemaField => {
  if (!node || typeof node !== "object") {
    return { id: newId(), name, type: "string", required }
  }
  const n = node as Record<string, unknown>
  const description =
    typeof n["description"] === "string" ? (n["description"] as string) : undefined
  const t = typeof n["type"] === "string" ? (n["type"] as string) : ""
  if (t === "string" && Array.isArray(n["enum"])) {
    return {
      id: newId(),
      name,
      type: "enum",
      required,
      enumValues: (n["enum"] as unknown[]).map((v) => String(v)),
      ...(description ? { description } : {}),
    }
  }
  if (t === "string" || t === "number" || t === "boolean") {
    return {
      id: newId(),
      name,
      type: t,
      required,
      ...(description ? { description } : {}),
    }
  }
  if (t === "array") {
    const items = n["items"]
    return {
      id: newId(),
      name,
      type: "array",
      required,
      itemType: nodeToField("item", items, true),
      ...(description ? { description } : {}),
    }
  }
  if (t === "object") {
    const properties = (n["properties"] ?? {}) as Record<string, unknown>
    const reqList = Array.isArray(n["required"])
      ? (n["required"] as string[])
      : []
    return {
      id: newId(),
      name,
      type: "object",
      required,
      properties: Object.entries(properties).map(([k, v]) =>
        nodeToField(k, v, reqList.includes(k)),
      ),
      ...(description ? { description } : {}),
    }
  }
  // Unrecognised — best-effort fallback.
  return { id: newId(), name, type: "string", required }
}

export const fromJsonSchema = (
  raw: Record<string, unknown> | null | undefined,
): ExtractorSchema => {
  if (!raw || typeof raw !== "object") return { fields: [] }
  const properties = (raw["properties"] ?? {}) as Record<string, unknown>
  const reqList = Array.isArray(raw["required"])
    ? (raw["required"] as string[])
    : []
  return {
    ...(typeof raw["description"] === "string"
      ? { description: raw["description"] as string }
      : {}),
    fields: Object.entries(properties).map(([k, v]) =>
      nodeToField(k, v, reqList.includes(k)),
    ),
  }
}

export const emptyField = (name: string = ""): SchemaField => ({
  id: newId(),
  name,
  type: "string",
  required: true,
})
