import type { JSONSchema7 } from "json-schema"

type JsonSchema = JSONSchema7
type ZodDefinition = Record<string, unknown> & {
  typeName?: string
  description?: string
}

type ZodSchema = {
  _def?: unknown
} & object

const createStringSchema = (): JsonSchema => ({ type: "string" })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const isZodType = (value: unknown): value is ZodSchema =>
  isRecord(value) && "_def" in value

const isJsonSchemaPrimitive = (
  value: unknown,
): value is string | number | boolean | null =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"

const getDefinition = (schema: ZodSchema | undefined): ZodDefinition | undefined => {
  const definition = schema?._def
  return isRecord(definition) ? (definition as ZodDefinition) : undefined
}

const getZodType = (value: unknown): ZodSchema | undefined =>
  (isZodType(value) ? value : undefined)

export function zodSchemaToJsonSchema(zodSchema: ZodSchema): JsonSchema {
  const def = getDefinition(zodSchema)
  const typeName = typeof def?.typeName === "string" ? def.typeName : undefined

  const attachDesc = (schema: JsonSchema, node: ZodSchema | undefined): JsonSchema => {
    const description = getDefinition(node)?.description
    return typeof description === "string" && description.length > 0
      ? { ...schema, description }
      : schema
  }

  const schemaFromCandidate = (candidate: unknown): JsonSchema => {
    const zod = getZodType(candidate)
    return zod ? zodSchemaToJsonSchema(zod) : createStringSchema()
  }

  const unwrap = (inner: unknown): JsonSchema => attachDesc(schemaFromCandidate(inner), zodSchema)

  if (!def || !typeName) {
    return attachDesc(createStringSchema(), zodSchema)
  }

  if (typeName === "ZodOptional" || typeName === "ZodDefault") {
    return unwrap(def.innerType)
  }
  if (typeName === "ZodNullable") {
    const innerSchema = schemaFromCandidate(def.innerType)
    const nullSchema: JsonSchema = { type: "null" }
    const nullableSchema: JsonSchema = { anyOf: [innerSchema, nullSchema] }
    return attachDesc(nullableSchema, zodSchema)
  }
  if (typeName === "ZodEffects") {
    return unwrap(def.schema ?? def.innerType ?? def.type)
  }
  if (typeName === "ZodBranded" || typeName === "ZodReadonly") {
    return unwrap(def.type ?? def.innerType)
  }

  if (typeName === "ZodObject") {
    const shapeGetter = typeof def.shape === "function" ? def.shape : undefined
    const shapeResult = shapeGetter ? shapeGetter() : undefined
    const shapeEntries = isRecord(shapeResult) ? Object.entries(shapeResult) : []

    const properties: Record<string, JsonSchema> = {}
    const required: string[] = []

    for (const [key, rawValue] of shapeEntries) {
      const propertySchema = schemaFromCandidate(rawValue)
      properties[key] = propertySchema
      if (isZodType(rawValue) && isZodSchemaRequired(rawValue)) {
        required.push(key)
      }
    }

    const objectSchema: JsonSchema = {
      type: "object",
      properties,
      additionalProperties: false,
    }

    if (required.length > 0) {
      objectSchema.required = required
    }

    return attachDesc(objectSchema, zodSchema)
  }
  if (typeName === "ZodRecord") {
    const valueSchema = schemaFromCandidate(def.valueType)
    const recordSchema: JsonSchema = {
      type: "object",
      additionalProperties: valueSchema,
    }
    return attachDesc(recordSchema, zodSchema)
  }
  if (typeName === "ZodArray") {
    const itemSchema = schemaFromCandidate(def.type)
    const arraySchema: JsonSchema = { type: "array", items: itemSchema }
    return attachDesc(arraySchema, zodSchema)
  }
  if (typeName === "ZodTuple") {
    const tupleItemsRaw: unknown[] = Array.isArray(def.items) ? def.items : []
    const items = tupleItemsRaw.map((item) => schemaFromCandidate(item))
    const tupleSchema: JsonSchema = {
      type: "array",
      items,
      minItems: items.length,
      maxItems: items.length,
    }

    if (isZodType(def.rest)) {
      tupleSchema.additionalItems = zodSchemaToJsonSchema(def.rest)
      delete tupleSchema.maxItems
    } else {
      tupleSchema.additionalItems = false
    }

    return attachDesc(tupleSchema, zodSchema)
  }
  if (typeName === "ZodUnion") {
    const unionOptionsRaw: unknown[] = Array.isArray(def.options) ? def.options : []
    const unionSchemas = unionOptionsRaw.map((option) => schemaFromCandidate(option))
    const unionSchema: JsonSchema = { anyOf: unionSchemas }
    return attachDesc(unionSchema, zodSchema)
  }
  if (typeName === "ZodDiscriminatedUnion") {
    const optionsIterable: Iterable<unknown> = def.options instanceof Map ? def.options.values() : []
    const discriminatedSchemas = Array.from(optionsIterable).map((option) => schemaFromCandidate(option))
    const discriminatedUnionSchema: JsonSchema = { anyOf: discriminatedSchemas }
    return attachDesc(discriminatedUnionSchema, zodSchema)
  }
  if (typeName === "ZodIntersection") {
    const leftSchema = schemaFromCandidate(def.left)
    const rightSchema = schemaFromCandidate(def.right)
    const intersectionSchema: JsonSchema = { allOf: [leftSchema, rightSchema] }
    return attachDesc(intersectionSchema, zodSchema)
  }

  if (typeName === "ZodString") {
    return attachDesc({ type: "string" }, zodSchema)
  }
  if (typeName === "ZodNumber") {
    const checks: unknown[] = Array.isArray(def.checks) ? def.checks : []
    const hasIntegerCheck = checks.some((check) => {
      if (!isRecord(check)) {
        return false
      }
      const kind = check.kind
      return typeof kind === "string" && kind === "int"
    })
    const numberSchema: JsonSchema = { type: hasIntegerCheck ? "integer" : "number" }
    return attachDesc(numberSchema, zodSchema)
  }
  if (typeName === "ZodBigInt") {
    return attachDesc({ type: "integer" }, zodSchema)
  }
  if (typeName === "ZodBoolean") {
    return attachDesc({ type: "boolean" }, zodSchema)
  }
  if (typeName === "ZodDate") {
    const dateSchema: JsonSchema = { type: "string", format: "date-time" }
    return attachDesc(dateSchema, zodSchema)
  }
  if (typeName === "ZodNull") {
    return attachDesc({ type: "null" }, zodSchema)
  }
  if (typeName === "ZodEnum") {
    const enumValuesRaw: unknown[] = Array.isArray(def.values) ? def.values : []
    const enumValues = enumValuesRaw.filter((value): value is string => typeof value === "string")
    const enumSchema: JsonSchema = { type: "string" }
    if (enumValues.length > 0) {
      enumSchema.enum = enumValues
    }
    return attachDesc(enumSchema, zodSchema)
  }
  if (typeName === "ZodNativeEnum") {
    const rawValues = isRecord(def.values) ? Object.values(def.values) : []
    const nativeEnumValues = rawValues.filter((value): value is string | number =>
      typeof value === "string" || typeof value === "number",
    )
    const nativeEnumSchema: JsonSchema = {}
    if (nativeEnumValues.length > 0) {
      nativeEnumSchema.enum = nativeEnumValues
    }
    return attachDesc(nativeEnumSchema, zodSchema)
  }
  if (typeName === "ZodLiteral") {
    const literalValue = def.value
    if (!isJsonSchemaPrimitive(literalValue)) {
      return attachDesc(createStringSchema(), zodSchema)
    }
    const literalSchema: JsonSchema = { enum: [literalValue] }
    if (typeof literalValue === "string") {
      literalSchema.type = "string"
    } else if (typeof literalValue === "number") {
      literalSchema.type = "number"
    } else if (typeof literalValue === "boolean") {
      literalSchema.type = "boolean"
    } else if (literalValue === null) {
      literalSchema.type = "null"
    }
    return attachDesc(literalSchema, zodSchema)
  }
  if (typeName === "ZodSet") {
    const setSchema: JsonSchema = {
      type: "array",
      items: schemaFromCandidate(def.valueType),
      uniqueItems: true,
    }
    return attachDesc(setSchema, zodSchema)
  }
  if (typeName === "ZodMap") {
    const mapSchema: JsonSchema = {
      type: "object",
      additionalProperties: schemaFromCandidate(def.valueType),
    }
    return attachDesc(mapSchema, zodSchema)
  }
  if (typeName === "ZodAny" || typeName === "ZodUnknown") {
    return attachDesc(createStringSchema(), zodSchema)
  }

  return attachDesc(createStringSchema(), zodSchema)
}

function isZodSchemaRequired(zodSchema: ZodSchema): boolean {
  const def = getDefinition(zodSchema)
  const typeName = typeof def?.typeName === "string" ? def.typeName : undefined

  if (
    typeName === "ZodOptional" ||
    typeName === "ZodDefault" ||
    typeName === "ZodNullable" ||
    typeName === "ZodNull"
  ) {
    return false
  }

  if (typeName === "ZodEffects" || typeName === "ZodBranded" || typeName === "ZodReadonly") {
    const innerType = getZodType(def?.schema) ?? getZodType(def?.type)
    if (innerType) {
      return isZodSchemaRequired(innerType)
    }
  }

  const innerFromInnerType = getZodType(def?.innerType)
  if (innerFromInnerType) {
    return isZodSchemaRequired(innerFromInnerType)
  }

  const innerFromType = getZodType(def?.type)
  if (innerFromType) {
    return isZodSchemaRequired(innerFromType)
  }

  return true
}
