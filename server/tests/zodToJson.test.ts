import { z } from "zod"
import { describe, expect, test } from "bun:test"
import { zodSchemaToJsonSchema } from "../api/chat/jaf-provider-utils"

// Test enums for comprehensive enum testing
enum TestNativeEnum {
  VALUE1 = "value1",
  VALUE2 = "value2",
  VALUE3 = "value3",
}

enum NumericEnum {
  FIRST = 1,
  SECOND = 2,
  THIRD = 3,
}

enum MixedEnum {
  STRING_VAL = "string",
  NUMERIC_VAL = 42,
}

describe("zodSchemaToJsonSchema", () => {
  describe("Basic primitive types", () => {
    test("should convert string schema", () => {
      const schema = z.string()
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({ type: "string" })
    })

    test("should convert string schema with description", () => {
      const schema = z.string().describe("A test string")
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({
        type: "string",
        description: "A test string",
      })
    })

    test("should convert number schema", () => {
      const schema = z.number()
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({ type: "number" })
    })

    test("should convert integer schema", () => {
      const schema = z.number().int()
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({ type: "integer" })
    })

    test("should convert number with min/max constraints", () => {
      const schema = z.number().min(0).max(100)
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({
        type: "number",
        minimum: 0,
        maximum: 100,
      })
    })

    test("should convert boolean schema", () => {
      const schema = z.boolean()
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({ type: "boolean" })
    })

    test("should convert date schema", () => {
      const schema = z.date()
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({
        type: "string",
        format: "date-time",
      })
    })

    test("should convert null schema", () => {
      const schema = z.null()
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({ type: "null" })
    })

    test("should convert bigint schema", () => {
      const schema = z.bigint()
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({ type: "integer" })
    })
  })

  describe("Optional and nullable schemas", () => {
    test("should convert optional string", () => {
      const schema = z.string().optional()
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({ type: "string" })
    })

    test("should convert nullable string", () => {
      const schema = z.string().nullable()
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({
        anyOf: [{ type: "string" }, { type: "null" }],
      })
    })

    test("should convert optional nullable string", () => {
      const schema = z.string().nullable().optional()
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({
        anyOf: [{ type: "string" }, { type: "null" }],
      })
    })

    test("should convert default string", () => {
      const schema = z.string().default("default value")
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({ type: "string" })
    })
  })

  describe("Enum schemas", () => {
    test("should convert regular enum", () => {
      const schema = z.enum(["value1", "value2", "value3"])
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({
        type: "string",
        enum: ["value1", "value2", "value3"],
      })
    })

    test("should convert native enum with string values", () => {
      const schema = z.nativeEnum(TestNativeEnum)
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({
        type: "string",
        enum: ["value1", "value2", "value3"],
      })
    })

    test("should convert native enum with numeric values", () => {
      const schema = z.nativeEnum(NumericEnum)
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({
        type: "number",
        enum: [1, 2, 3],
      })
    })

    test("should convert native enum with mixed values", () => {
      const schema = z.nativeEnum(MixedEnum)
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({
        anyOf: [{ type: "string" }, { type: "number" }],
        enum: ["string", 42],
      })
    })
  })

  describe("Array schemas", () => {
    test("should convert array of strings", () => {
      const schema = z.array(z.string())
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({
        type: "array",
        items: { type: "string" },
      })
    })

    test("should convert array of native enum", () => {
      const schema = z.array(z.nativeEnum(TestNativeEnum))
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({
        type: "array",
        items: {
          type: "string",
          enum: ["value1", "value2", "value3"],
        },
      })
    })

    test("should convert array of regular enum", () => {
      const schema = z.array(z.enum(["test1", "test2"]))
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({
        type: "array",
        items: {
          type: "string",
          enum: ["test1", "test2"],
        },
      })
    })

    test("should convert nested arrays", () => {
      const schema = z.array(z.array(z.string()))
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({
        type: "array",
        items: {
          type: "array",
          items: { type: "string" },
        },
      })
    })
  })

  describe("Object schemas", () => {
    test("should convert simple object", () => {
      const schema = z.object({
        name: z.string(),
        age: z.number(),
      })
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
        required: ["name", "age"],
      })
    })

    test("should convert object with optional fields", () => {
      const schema = z.object({
        name: z.string(),
        age: z.number().optional(),
        email: z.string().optional(),
      })
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
          email: { type: "string" },
        },
        required: ["name"],
      })
    })

    test("should convert object with descriptions", () => {
      const schema = z
        .object({
          name: z.string().describe("User's name"),
          age: z.number().describe("User's age"),
        })
        .describe("User object")
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({
        type: "object",
        description: "User object",
        properties: {
          name: {
            type: "string",
            description: "User's name",
          },
          age: {
            type: "number",
            description: "User's age",
          },
        },
        required: ["name", "age"],
      })
    })

    test("should convert nested objects", () => {
      const schema = z.object({
        user: z.object({
          name: z.string(),
          details: z.object({
            age: z.number(),
            city: z.string(),
          }),
        }),
      })
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              name: { type: "string" },
              details: {
                type: "object",
                properties: {
                  age: { type: "number" },
                  city: { type: "string" },
                },
                required: ["age", "city"],
              },
            },
            required: ["name", "details"],
          },
        },
        required: ["user"],
      })
    })
  })

  describe("Tuple schemas", () => {
    test("should convert simple tuple", () => {
      const schema = z.tuple([z.string(), z.number(), z.boolean()])
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({
        type: "array",
        items: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
        minItems: 3,
        maxItems: 3,
        additionalItems: false,
      })
    })

    test("should convert tuple with rest", () => {
      const schema = z.tuple([z.string(), z.number()]).rest(z.boolean())
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({
        type: "array",
        items: [{ type: "string" }, { type: "number" }],
        minItems: 2,
        additionalItems: { type: "boolean" },
      })
    })
  })

  describe("Union and intersection schemas", () => {
    test("should convert union schema", () => {
      const schema = z.union([z.string(), z.number()])
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({
        anyOf: [{ type: "string" }, { type: "number" }],
      })
    })

    test("should convert intersection schema", () => {
      const schema = z.intersection(
        z.object({ name: z.string() }),
        z.object({ age: z.number() }),
      )
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({
        allOf: [
          {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
          {
            type: "object",
            properties: { age: { type: "number" } },
            required: ["age"],
          },
        ],
      })
    })

    test("should convert discriminated union", () => {
      const schema = z.discriminatedUnion("type", [
        z.object({ type: z.literal("email"), email: z.string() }),
        z.object({ type: z.literal("phone"), phone: z.string() }),
      ])
      const result = zodSchemaToJsonSchema(schema)
      expect(result.anyOf).toHaveLength(2)
      expect(result.anyOf).toEqual([
        {
          type: "object",
          properties: {
            type: { type: "string", enum: ["email"] },
            email: { type: "string" },
          },
          required: ["type", "email"],
        },
        {
          type: "object",
          properties: {
            type: { type: "string", enum: ["phone"] },
            phone: { type: "string" },
          },
          required: ["type", "phone"],
        },
      ])
    })
  })

  describe("Literal schemas", () => {
    test("should convert string literal", () => {
      const schema = z.literal("hello")
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({
        type: "string",
        enum: ["hello"],
      })
    })

    test("should convert number literal", () => {
      const schema = z.literal(42)
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({
        type: "number",
        enum: [42],
      })
    })

    test("should convert boolean literal", () => {
      const schema = z.literal(true)
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({
        type: "boolean",
        enum: [true],
      })
    })

    test("should convert null literal", () => {
      const schema = z.literal(null)
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({
        type: "null",
        enum: [null],
      })
    })
  })

  describe("Special collection types", () => {
    test("should convert Set schema", () => {
      const schema = z.set(z.string())
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({
        type: "array",
        items: { type: "string" },
        uniqueItems: true,
      })
    })

    test("should convert Map schema", () => {
      const schema = z.map(z.string(), z.number())
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({
        type: "object",
        additionalProperties: { type: "number" },
      })
    })

    test("should convert Record schema", () => {
      const schema = z.record(z.string(), z.number())
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({
        type: "object",
        additionalProperties: { type: "number" },
      })
    })
  })

  describe("Complex real-world scenarios", () => {
    test("should convert complex nested schema with arrays and enums", () => {
      const schema = z.object({
        name: z.string(),
        tags: z.array(z.nativeEnum(TestNativeEnum)),
        metadata: z
          .object({
            created: z.date(),
            version: z.number().int().min(1),
          })
          .optional(),
        status: z.enum(["active", "inactive"]),
      })

      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({
        type: "object",
        properties: {
          name: { type: "string" },
          tags: {
            type: "array",
            items: {
              type: "string",
              enum: ["value1", "value2", "value3"],
            },
          },
          metadata: {
            type: "object",
            properties: {
              created: { type: "string", format: "date-time" },
              version: { type: "integer", minimum: 1 },
            },
            required: ["created", "version"],
          },
          status: {
            type: "string",
            enum: ["active", "inactive"],
          },
        },
        required: ["name", "tags", "status"],
      })
    })

    test("should handle DriveEntity-like scenario", () => {
      // Simulate the DriveEntity scenario that was fixed
      enum MockDriveEntity {
        Docs = "docs",
        Sheets = "sheets",
        PDF = "pdf",
      }

      const schema = z.object({
        query: z.string(),
        filetype: z.array(z.nativeEnum(MockDriveEntity)).optional(),
        limit: z.number().default(20),
      })

      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({
        type: "object",
        properties: {
          query: { type: "string" },
          filetype: {
            type: "array",
            items: {
              type: "string",
              enum: ["docs", "sheets", "pdf"],
            },
          },
          limit: { type: "number" },
        },
        required: ["query"],
      })
    })
  })

  describe("Edge cases and special types", () => {
    test("should handle unknown/any types", () => {
      const unknownSchema = z.unknown()
      const anySchema = z.any()

      expect(zodSchemaToJsonSchema(unknownSchema)).toEqual({ type: "string" })
      expect(zodSchemaToJsonSchema(anySchema)).toEqual({ type: "string" })
    })

    test("should handle effects/transforms", () => {
      const schema = z.string().transform((s) => s.toUpperCase())
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({ type: "string" })
    })

    test("should handle branded types", () => {
      const schema = z.string().brand<"UserId">()
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({ type: "string" })
    })

    test("should handle readonly types", () => {
      const schema = z.object({ name: z.string() }).readonly()
      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({
        type: "object",
        properties: {
          name: { type: "string" },
        },
        required: ["name"],
      })
    })

    test("should handle empty enum gracefully", () => {
      // This is more of a theoretical case since empty enums don't make sense
      const schema = z.enum([])
      const result = zodSchemaToJsonSchema(schema)
      expect(result.type).toBe("string")
    })
  })

  describe("Description inheritance", () => {
    test("should preserve descriptions through transformations", () => {
      const schema = z.string().describe("Original description").optional()

      const result = zodSchemaToJsonSchema(schema)
      expect(result).toEqual({
        type: "string",
        description: "Original description",
      })
    })

    test("should handle nested descriptions", () => {
      const schema = z
        .object({
          user: z
            .object({
              name: z.string().describe("User's full name"),
            })
            .describe("User information"),
        })
        .describe("API response")

      const result = zodSchemaToJsonSchema(schema)
      expect(result.description).toBe("API response")

      // Type assertion for properties
      const properties = result.properties as Record<string, any>
      expect(properties?.user?.description).toBe("User information")
      expect(properties?.user?.properties?.name?.description).toBe(
        "User's full name",
      )
    })
  })
})
