import { z } from "zod"

// Entity and Relationship extraction schemas
export const EntitySchema = z.object({
  name: z.string(),
  type: z.enum([
    "PERSON",
    "ORGANIZATION",
    "LOCATION",
    "CONCEPT",
    "PRODUCT",
    "EVENT",
    "DATE",
  ]),
  description: z.string().optional(),
  properties: z.record(z.any()).optional(),
})

export const RelationshipSchema = z.object({
  source: z.string(),
  target: z.string(),
  type: z.string(),
  description: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  properties: z.record(z.any()).optional(),
})

export const ExtractionResultSchema = z.object({
  entities: z.array(EntitySchema),
  relationships: z.array(RelationshipSchema),
})

export type Entity = z.infer<typeof EntitySchema>
export type Relationship = z.infer<typeof RelationshipSchema>
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>

// LLM prompt for entity and relationship extraction
const EXTRACTION_PROMPT = `
You are an expert knowledge graph extraction system. Extract entities and relationships from the given text.

Instructions:
1. Identify key entities (people, organizations, locations, concepts, products, events, dates)
2. Extract meaningful relationships between entities
3. Use clear, consistent entity names (normalize variations)
4. Focus on factual, concrete relationships
5. Provide confidence scores for relationships (0-1)

Entity Types:
- PERSON: Individual people
- ORGANIZATION: Companies, institutions, groups
- LOCATION: Places, addresses, geographical locations
- CONCEPT: Ideas, technologies, methodologies
- PRODUCT: Products, services, software
- EVENT: Meetings, conferences, incidents
- DATE: Specific dates or time periods

Relationship Examples:
- "works_at", "employed_by"
- "located_in", "based_in"
- "develops", "creates", "maintains"
- "collaborates_with", "partners_with"
- "mentions", "discusses", "references"

Return your response as a JSON object with "entities" and "relationships" arrays.

Text to analyze:
{text}
`

export class KnowledgeGraphExtractor {
  constructor(private llmClient: any) {}

  async extractFromText(
    text: string,
    documentId: string,
  ): Promise<ExtractionResult> {
    try {
      const prompt = EXTRACTION_PROMPT.replace("{text}", text)

      const response = await this.llmClient.complete({
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 2000,
      })

      const content = response.choices[0]?.message?.content
      if (!content) {
        throw new Error("No response from LLM")
      }

      // Parse JSON response
      const jsonMatch = content.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        throw new Error("No JSON found in LLM response")
      }

      const parsed = JSON.parse(jsonMatch[0])
      const result = ExtractionResultSchema.parse(parsed)

      // Add document context to entities and relationships
      result.entities = result.entities.map((entity) => ({
        ...entity,
        properties: {
          ...entity.properties,
          source_document: documentId,
        },
      }))

      result.relationships = result.relationships.map((rel) => ({
        ...rel,
        properties: {
          ...rel.properties,
          source_document: documentId,
        },
      }))

      return result
    } catch (error) {
      console.error("Knowledge graph extraction failed:", error)
      return { entities: [], relationships: [] }
    }
  }

  async extractFromDocuments(
    documents: Array<{ id: string; content: string }>,
  ): Promise<ExtractionResult> {
    const allResults = await Promise.all(
      documents.map((doc) => this.extractFromText(doc.content, doc.id)),
    )

    // Merge all results
    const mergedEntities: Entity[] = []
    const mergedRelationships: Relationship[] = []

    for (const result of allResults) {
      mergedEntities.push(...result.entities)
      mergedRelationships.push(...result.relationships)
    }

    // Deduplicate entities by name and type
    const uniqueEntities = this.deduplicateEntities(mergedEntities)

    return {
      entities: uniqueEntities,
      relationships: mergedRelationships,
    }
  }

  private deduplicateEntities(entities: Entity[]): Entity[] {
    const entityMap = new Map<string, Entity>()

    for (const entity of entities) {
      const key = `${entity.name.toLowerCase()}_${entity.type}`

      if (!entityMap.has(key)) {
        entityMap.set(key, entity)
      } else {
        // Merge properties if entity already exists
        const existing = entityMap.get(key)!
        existing.properties = {
          ...existing.properties,
          ...entity.properties,
        }
      }
    }

    return Array.from(entityMap.values())
  }
}
