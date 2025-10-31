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
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean"

const getDefinition = (
  schema: ZodSchema | undefined,
): ZodDefinition | undefined => {
  const definition = schema?._def
  return isRecord(definition) ? (definition as ZodDefinition) : undefined
}

const getZodType = (value: unknown): ZodSchema | undefined =>
  isZodType(value) ? value : undefined

export function zodSchemaToJsonSchema(zodSchema: ZodSchema): JsonSchema {
  const def = getDefinition(zodSchema)
  const typeName =
    typeof def?.typeName === "string"
      ? def.typeName
      : typeof def?.type === "string"
        ? `Zod${def.type.charAt(0).toUpperCase()}${def.type.slice(1)}`
        : undefined

  const attachDesc = (
    schema: JsonSchema,
    node: ZodSchema | undefined,
  ): JsonSchema => {
    // Check for description in the node itself
    const description =
      (node as any)?.description || getDefinition(node)?.description
    return typeof description === "string" && description.length > 0
      ? { ...schema, description }
      : schema
  }

  const schemaFromCandidate = (candidate: unknown): JsonSchema => {
    const zod = getZodType(candidate)
    return zod ? zodSchemaToJsonSchema(zod) : createStringSchema()
  }

  const unwrap = (inner: unknown): JsonSchema =>
    attachDesc(schemaFromCandidate(inner), zodSchema)

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
  if (typeName === "ZodBranded") {
    return unwrap(def.type ?? def.innerType)
  }
  if (typeName === "ZodReadonly") {
    return unwrap(def.innerType ?? def.type)
  }

  if (typeName === "ZodObject") {
    // Handle shape getter - it might be a getter property or a function
    let shapeResult: unknown
    if (typeof def.shape === "function") {
      shapeResult = def.shape()
    } else if (def.shape && typeof def.shape === "object") {
      // If shape is an object with a getter, try to access it
      try {
        shapeResult = def.shape
      } catch {
        shapeResult = undefined
      }
    } else {
      shapeResult = undefined
    }

    const shapeEntries = isRecord(shapeResult)
      ? Object.entries(shapeResult)
      : []

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
    }

    if (required.length > 0) {
      objectSchema.required = required
    }

    let additionalProperties: JsonSchema["additionalProperties"]

    const catchallSchema = getZodType(def.catchall)
    if (catchallSchema) {
      const catchallDef = getDefinition(catchallSchema)
      if (catchallDef?.typeName === "ZodNever") {
        additionalProperties = false
      } else {
        additionalProperties = schemaFromCandidate(catchallSchema)
      }
    } else if (def.unknownKeys === "passthrough") {
      additionalProperties = true
    } else if (def.unknownKeys === "strict") {
      additionalProperties = false
    }

    if (typeof additionalProperties !== "undefined") {
      objectSchema.additionalProperties = additionalProperties
    } else {
      delete objectSchema.additionalProperties
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
    const itemSchema = schemaFromCandidate(def.element ?? def.type)
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
    const unionOptionsRaw: unknown[] = Array.isArray(def.options)
      ? def.options
      : []
    const unionSchemas = unionOptionsRaw.map((option) =>
      schemaFromCandidate(option),
    )
    const unionSchema: JsonSchema = { anyOf: unionSchemas }
    return attachDesc(unionSchema, zodSchema)
  }
  if (typeName === "ZodDiscriminatedUnion") {
    const optionsIterable: Iterable<unknown> =
      def.options instanceof Map ? def.options.values() : []
    const discriminatedSchemas = Array.from(optionsIterable).map((option) =>
      schemaFromCandidate(option),
    )
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
      const checkDef = (check as any)._zod?.def
      return (
        check.isInt === true ||
        check.kind === "int" ||
        checkDef?.check === "int"
      )
    })

    const numberSchema: JsonSchema = {
      type: hasIntegerCheck ? "integer" : "number",
    }

    // Handle min/max constraints
    for (const check of checks) {
      if (!isRecord(check)) continue

      const checkDef = (check as any)._zod?.def
      if (!checkDef) continue

      const checkType = checkDef.check
      const value = checkDef.value
      const inclusive = checkDef.inclusive

      if (typeof checkType === "string" && typeof value === "number") {
        switch (checkType) {
          case "greater_than":
            if (inclusive) {
              numberSchema.minimum = value
            } else {
              numberSchema.exclusiveMinimum = value
            }
            break
          case "less_than":
            if (inclusive) {
              numberSchema.maximum = value
            } else {
              numberSchema.exclusiveMaximum = value
            }
            break
        }
      }
    }

    return attachDesc(numberSchema, zodSchema)
  }
  if (typeName === "ZodBigInt" || typeName === "ZodBigint") {
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
    // Handle both z.enum() (uses def.values) and z.nativeEnum() (uses def.entries)
    let enumValues: (string | number)[] = []

    if (Array.isArray(def.values)) {
      // Standard z.enum() case
      enumValues = def.values.filter(
        (value): value is string | number =>
          typeof value === "string" || typeof value === "number",
      )
    } else if (isRecord(def.entries)) {
      // z.nativeEnum() case - apply the same logic as the other handlers
      const entries = def.entries as Record<string | number, string | number>

      const allValues = Object.values(entries).filter(
        (value): value is string | number =>
          typeof value === "string" || typeof value === "number",
      )

      const numberValues = allValues.filter((v) => typeof v === "number")
      const stringValues = allValues.filter((v) => typeof v === "string")

      // Check if this is a pure numeric enum by seeing if:
      // 1. We have numeric values
      // 2. All string values are actually reverse mappings (found as values for numeric keys)
      const numericKeys = Object.keys(entries).filter(
        (key) => !isNaN(Number(key)),
      )
      const reverseStringMappings = numericKeys
        .map((key) => entries[key])
        .filter((v) => typeof v === "string")

      const isPureNumericEnum =
        numberValues.length > 0 &&
        stringValues.length === reverseStringMappings.length &&
        stringValues.every((str) => reverseStringMappings.includes(str))

      if (isPureNumericEnum) {
        // Pure numeric enum - only use the numeric values
        enumValues = numberValues
      } else {
        // Mixed or string enum - filter out reverse mappings
        const actualValues = allValues.filter((value) => {
          // Include if it's not a reverse mapping
          return !reverseStringMappings.includes(value as string)
        })
        enumValues = actualValues
      }
    }

    // Determine the type based on the enum values
    const hasStringValues = enumValues.some(
      (value) => typeof value === "string",
    )
    const hasNumberValues = enumValues.some(
      (value) => typeof value === "number",
    )

    let enumSchema: JsonSchema

    if (hasStringValues && hasNumberValues) {
      // Mixed enum - use anyOf
      enumSchema = {
        anyOf: [{ type: "string" }, { type: "number" }],
      }
    } else if (hasStringValues) {
      enumSchema = { type: "string" }
    } else if (hasNumberValues) {
      enumSchema = { type: "number" }
    } else {
      enumSchema = { type: "string" } // fallback
    }

    if (enumValues.length > 0) {
      enumSchema.enum = enumValues
    }

    return attachDesc(enumSchema, zodSchema)
  }
  if (typeName === "ZodNativeEnum") {
    // For z.nativeEnum, the values are stored in def.entries, not def.values
    const entries = isRecord(def.entries)
      ? (def.entries as Record<string | number, string | number>)
      : {}

    // Get all values from the enum
    const allValues = Object.values(entries).filter(
      (value): value is string | number =>
        typeof value === "string" || typeof value === "number",
    )

    const numberValues = allValues.filter((v) => typeof v === "number")
    const stringValues = allValues.filter((v) => typeof v === "string")

    // Check if this is a pure numeric enum by seeing if:
    // 1. We have numeric values
    // 2. All string values are actually reverse mappings (found as values for numeric keys)
    const numericKeys = Object.keys(entries).filter(
      (key) => !isNaN(Number(key)),
    )
    const reverseStringMappings = numericKeys
      .map((key) => entries[key])
      .filter((v) => typeof v === "string")

    const isPureNumericEnum =
      numberValues.length > 0 &&
      stringValues.length === reverseStringMappings.length &&
      stringValues.every((str) => reverseStringMappings.includes(str))

    let enumValues: (string | number)[]
    let hasStringType: boolean
    let hasNumberType: boolean

    if (isPureNumericEnum) {
      // Pure numeric enum - only use the numeric values
      enumValues = numberValues
      hasStringType = false
      hasNumberType = true
    } else {
      // Mixed or string enum - use the actual values
      enumValues = allValues
      hasStringType = stringValues.length > 0
      hasNumberType = numberValues.length > 0
    }

    let nativeEnumSchema: JsonSchema

    if (hasStringType && hasNumberType) {
      // Mixed enum
      nativeEnumSchema = {
        anyOf: [{ type: "string" }, { type: "number" }],
      }
    } else if (hasStringType) {
      nativeEnumSchema = { type: "string" }
    } else if (hasNumberType) {
      nativeEnumSchema = { type: "number" }
    } else {
      nativeEnumSchema = { type: "string" } // fallback
    }

    if (enumValues.length > 0) {
      nativeEnumSchema.enum = enumValues.sort((a, b) => {
        if (typeof a === typeof b) {
          return a < b ? -1 : a > b ? 1 : 0
        }
        return typeof a === "number" ? 1 : -1
      })
    }

    return attachDesc(nativeEnumSchema, zodSchema)
  }

  // Handle the case where typeName might be calculated differently for native enums
  if (def?.type === "enum" && isRecord(def.entries)) {
    // This handles z.nativeEnum() when typeName is not "ZodNativeEnum"
    const entries = def.entries as Record<string | number, string | number>

    // Get all values from the enum
    const allValues = Object.values(entries).filter(
      (value): value is string | number =>
        typeof value === "string" || typeof value === "number",
    )

    const numberValues = allValues.filter((v) => typeof v === "number")
    const stringValues = allValues.filter((v) => typeof v === "string")

    // Check if this is a pure numeric enum by seeing if:
    // 1. We have numeric values
    // 2. All string values are actually reverse mappings (found as values for numeric keys)
    const numericKeys = Object.keys(entries).filter(
      (key) => !isNaN(Number(key)),
    )
    const reverseStringMappings = numericKeys
      .map((key) => entries[key])
      .filter((v) => typeof v === "string")

    const isPureNumericEnum =
      numberValues.length > 0 &&
      stringValues.length === reverseStringMappings.length &&
      stringValues.every((str) => reverseStringMappings.includes(str))

    let enumValues: (string | number)[]
    let hasStringType: boolean
    let hasNumberType: boolean

    if (isPureNumericEnum) {
      // Pure numeric enum - only use the numeric values
      enumValues = numberValues
      hasStringType = false
      hasNumberType = true
    } else {
      // Mixed or string enum - use the actual values
      enumValues = allValues
      hasStringType = stringValues.length > 0
      hasNumberType = numberValues.length > 0
    }

    let nativeEnumSchema: JsonSchema

    if (hasStringType && hasNumberType) {
      // Mixed enum
      nativeEnumSchema = {
        anyOf: [{ type: "string" }, { type: "number" }],
      }
    } else if (hasStringType) {
      nativeEnumSchema = { type: "string" }
    } else if (hasNumberType) {
      nativeEnumSchema = { type: "number" }
    } else {
      nativeEnumSchema = { type: "string" } // fallback
    }

    if (enumValues.length > 0) {
      nativeEnumSchema.enum = enumValues.sort((a, b) => {
        if (typeof a === typeof b) {
          return a < b ? -1 : a > b ? 1 : 0
        }
        return typeof a === "number" ? 1 : -1
      })
    }

    return attachDesc(nativeEnumSchema, zodSchema)
  }
  if (typeName === "ZodLiteral") {
    const literalValue = Array.isArray(def.values) ? def.values[0] : def.value
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
  const typeName =
    typeof def?.typeName === "string"
      ? def.typeName
      : typeof def?.type === "string"
        ? `Zod${def.type.charAt(0).toUpperCase()}${def.type.slice(1)}`
        : undefined

  if (typeName === "ZodOptional" || typeName === "ZodDefault") {
    return false
  }

  if (
    typeName === "ZodNullable" ||
    typeName === "ZodEffects" ||
    typeName === "ZodBranded" ||
    typeName === "ZodReadonly"
  ) {
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
