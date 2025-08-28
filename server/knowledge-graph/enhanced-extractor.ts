import { z } from "zod"
import type VespaClient from "@/search/vespaClient"
import type { VespaSearchResponse } from "@/search/types"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { getProviderByModel } from "@/ai/provider"
import type { Models } from "@/ai/types"
import config from "@/config"

const Logger = getLogger(Subsystem.AI).child({ module: "enhanced-extractor" })

// Enhanced entity and relationship schemas
export const EnhancedEntitySchema = z.object({
  entityId: z.string(),
  entityName: z.string(),
  entityType: z.enum([
    "PERSON",
    "ORGANIZATION",
    "LOCATION",
    "CONCEPT",
    "PRODUCT",
    "EVENT",
    "DATE",
    "TECHNOLOGY",
    "PROJECT",
    "DOCUMENT",
  ]),
  description: z.string().optional(),
  keywords: z.array(z.string()).default([]),
  sourceDocuments: z.array(z.string()).default([]),
  summaryChunks: z.array(z.string()).default([]),
  importance: z.number().min(0).max(1).default(0.5),
  confidence: z.number().min(0).max(1).default(0.8),
  metadata: z.record(z.any()).default({}),
})

export const EnhancedRelationshipSchema = z.object({
  relationshipId: z.string(),
  sourceEntityId: z.string(),
  targetEntityId: z.string(),
  sourceEntityName: z.string(),
  targetEntityName: z.string(),
  relationshipType: z.string(),
  description: z.string().optional(),
  keywords: z.array(z.string()).default([]),
  weight: z.number().min(0).max(1).default(0.5),
  strength: z.number().min(0).max(1).default(0.5),
  confidence: z.number().min(0).max(1).default(0.8),
  bidirectional: z.boolean().default(false),
  sourceDocuments: z.array(z.string()).default([]),
  metadata: z.record(z.any()).default({}),
})

export const ExtractionResultSchema = z.object({
  entities: z.array(EnhancedEntitySchema),
  relationships: z.array(EnhancedRelationshipSchema),
})

export type EnhancedEntity = z.infer<typeof EnhancedEntitySchema>
export type EnhancedRelationship = z.infer<typeof EnhancedRelationshipSchema>
export type EnhancedExtractionResult = z.infer<typeof ExtractionResultSchema>

// Document interface for processing
export interface DocumentForProcessing {
  docId: string
  content: string
  title?: string
  chunks?: string[]
  metadata?: Record<string, any>
  schema: string
}

// LLM prompts for extraction
const ENTITY_EXTRACTION_PROMPT = `
You are an expert knowledge graph entity extractor. Your task is to identify and extract entities from documents while considering existing entities for consistency.

## Instructions:
1. Extract key entities from the document content
2. For each entity, determine if it matches or relates to any existing entities
3. If an entity already exists, reuse it and update with new information from this document
4. Only create new entities when they are truly distinct from existing ones
5. Assign appropriate entity types and importance scores
6. Generate descriptive keywords for each entity

## Entity Types:
- PERSON: Individual people, authors, contributors
- ORGANIZATION: Companies, institutions, teams, groups
- LOCATION: Places, addresses, geographical locations
- CONCEPT: Ideas, methodologies, frameworks, theories
- PRODUCT: Software, tools, products, services
- EVENT: Meetings, conferences, releases, incidents
- DATE: Specific dates or time periods
- TECHNOLOGY: Programming languages, frameworks, platforms
- PROJECT: Software projects, initiatives, repositories
- DOCUMENT: Files, reports, specifications, documentation

## Existing Entities to Consider:
{existing_entities}

## Document Information:
- Title: {document_title}
- Description: {document_description}

## Document Content:
{document_content}

## Output Format:
Return a JSON object with an "entities" array. Each entity should have:
- entityName: Clear, normalized name
- entityType: One of the specified types
- description: Brief description of the entity
- keywords: Array of relevant keywords
- sourceDocuments: Array containing the current document ID
- summaryChunks: Array of relevant text chunks from the document
- importance: Score 0-1 indicating importance
- confidence: Score 0-1 indicating extraction confidence
- metadata: Object with additional properties

Example:
{
  "entities": [
    {
      "entityId": "person_john_doe",
      "entityName": "John Doe",
      "entityType": "PERSON",
      "description": "Software engineer and project contributor",
      "keywords": ["developer", "engineer", "contributor"],
      "sourceDocuments": ["doc123"],
      "summaryChunks": ["John Doe contributed to the project"],
      "importance": 0.7,
      "confidence": 0.9,
      "metadata": {"role": "developer"}
    }
  ]
}
`

const RELATIONSHIP_EXTRACTION_PROMPT = `
You are an expert knowledge graph relationship extractor. Your task is to identify meaningful relationships between entities from the given document.

## Instructions:
1. Identify relationships between entities in the document
2. Consider both explicit and implicit relationships
3. Assign appropriate relationship types and strength scores
4. Generate descriptive keywords for each relationship
5. Determine if relationships are bidirectional

## Common Relationship Types:
- works_at, employed_by
- located_in, based_in
- develops, creates, maintains
- collaborates_with, partners_with
- depends_on, uses, integrates_with
- manages, leads, reports_to
- mentions, discusses, references
- contains, includes, part_of
- precedes, follows, triggers
- similar_to, related_to

## Extracted Entities:
{entities}

## Document Information:
- Document ID: {document_id}
- Content: {document_content}

## Output Format:
Return a JSON object with a "relationships" array. Each relationship should have:
- relationshipId: Unique identifier
- sourceEntityId: ID of source entity
- targetEntityId: ID of target entity
- sourceEntityName: Name of source entity
- targetEntityName: Name of target entity
- relationshipType: Type of relationship
- description: Brief description
- keywords: Array of relevant keywords
- weight: Importance score 0-1
- strength: Connection strength 0-1
- confidence: Extraction confidence 0-1
- bidirectional: Whether relationship works both ways
- sourceDocuments: Array containing the current document ID
- metadata: Additional properties

Example:
{
  "relationships": [
    {
      "relationshipId": "rel_john_doe_works_at_acme_corp",
      "sourceEntityId": "person_john_doe",
      "targetEntityId": "org_acme_corp",
      "sourceEntityName": "John Doe",
      "targetEntityName": "Acme Corp",
      "relationshipType": "works_at",
      "description": "John Doe is employed by Acme Corp",
      "keywords": ["employment", "developer"],
      "weight": 0.8,
      "strength": 0.9,
      "confidence": 0.9,
      "bidirectional": false,
      "sourceDocuments": ["doc123"],
      "metadata": {"department": "engineering"}
    }
  ]
}
`

export class EnhancedKnowledgeGraphExtractor {
  private vespaClient: VespaClient
  private modelId: Models
  private batchSize: number

  constructor(
    vespaClient: VespaClient,
    modelId: Models = config.defaultFastModel as Models,
    batchSize: number = 100,
  ) {
    this.vespaClient = vespaClient
    this.modelId = modelId
    this.batchSize = batchSize
  }

  /**
   * Main extraction method that processes documents from Vespa
   */
  async extractFromVespaDocuments(
    schemas: string[] = ["file", "mail", "event", "chat_message"],
    documentsPerSchema: number = 100,
  ): Promise<EnhancedExtractionResult> {
    Logger.info(
      "Starting enhanced knowledge graph extraction from Vespa documents",
    )

    try {
      // Step 1: Fetch documents from Vespa for each schema
      const allDocuments: DocumentForProcessing[] = []

      for (const schema of schemas) {
        Logger.info(
          `Fetching ${documentsPerSchema} documents from schema: ${schema}`,
        )
        const documents = await this.fetchDocumentsFromSchema(
          schema,
          documentsPerSchema,
        )
        allDocuments.push(...documents)
      }

      Logger.info(`Total documents fetched: ${allDocuments.length}`)

      // Step 2: Process documents in batches
      const batchResults: EnhancedExtractionResult[] = []

      for (let i = 0; i < allDocuments.length; i += this.batchSize) {
        const batch = allDocuments.slice(i, i + this.batchSize)
        Logger.info(
          `Processing batch ${Math.floor(i / this.batchSize) + 1}/${Math.ceil(allDocuments.length / this.batchSize)}`,
        )

        const batchResult = await this.processBatch(batch, batchResults)
        batchResults.push(batchResult)
      }

      // Step 3: Merge all results
      const finalResult = this.mergeResults(batchResults)

      Logger.info(
        `Extraction completed. Entities: ${finalResult.entities.length}, Relationships: ${finalResult.relationships.length}`,
      )

      return finalResult
    } catch (error) {
      Logger.error(error, "Error during enhanced knowledge graph extraction")
      throw error
    }
  }

  /**
   * Fetch documents from a specific Vespa schema
   */
  private async fetchDocumentsFromSchema(
    schema: string,
    limit: number,
  ): Promise<DocumentForProcessing[]> {
    try {
      const searchPayload = {
        yql: `select * from sources ${schema} where true`,
        hits: limit,
        timeout: "30s",
        "ranking.profile": "unranked",
      }

      const response =
        await this.vespaClient.search<VespaSearchResponse>(searchPayload)

      if (!response.root?.children) {
        Logger.warn(`No documents found for schema: ${schema}`)
        return []
      }

      const documents: DocumentForProcessing[] = response.root.children
        .map((doc: any) => {
          const fields = doc.fields || {}

          // Extract content based on document type
          let content = ""
          if (fields.chunks && Array.isArray(fields.chunks)) {
            content = fields.chunks.join(" ")
          } else if (fields.text) {
            content = fields.text
          } else if (fields.content) {
            content = fields.content
          } else if (fields.description) {
            content = fields.description
          }

          return {
            docId: fields.docId || doc.id || `unknown_${Date.now()}`,
            content: content.trim(),
            title:
              fields.title ||
              fields.name ||
              fields.subject ||
              fields.fileName ||
              "",
            chunks: fields.chunks || [],
            metadata: {
              schema,
              app: fields.app,
              entity: fields.entity,
              createdAt: fields.createdAt,
              updatedAt: fields.updatedAt,
              ...fields,
            },
            schema,
          }
        })
        .filter((doc) => doc.content.length > 0) // Only process documents with content

      Logger.info(
        `Fetched ${documents.length} valid documents from schema: ${schema}`,
      )
      return documents
    } catch (error) {
      Logger.error(error, `Error fetching documents from schema: ${schema}`)
      return []
    }
  }

  /**
   * Process a batch of documents
   */
  private async processBatch(
    documents: DocumentForProcessing[],
    previousResults: EnhancedExtractionResult[],
  ): Promise<EnhancedExtractionResult> {
    // Get existing entities from previous batches
    const existingEntities = this.getAllEntitiesFromResults(previousResults)

    const batchEntities: EnhancedEntity[] = []
    const batchRelationships: EnhancedRelationship[] = []

    // Process each document in the batch
    for (const doc of documents) {
      try {
        Logger.debug(`Processing document: ${doc.docId}`)

        // Extract entities for this document
        const documentEntities = await this.extractEntitiesFromDocument(doc, [
          ...existingEntities,
          ...batchEntities,
        ])

        // Merge entities (avoiding duplicates)
        for (const entity of documentEntities) {
          const existingEntity = batchEntities.find(
            (e) => e.entityId === entity.entityId,
          )
          if (existingEntity) {
            // Update existing entity
            this.mergeEntityData(existingEntity, entity)
          } else {
            batchEntities.push(entity)
          }
        }

        // Extract relationships for this document
        const documentRelationships =
          await this.extractRelationshipsFromDocument(doc, batchEntities)

        batchRelationships.push(...documentRelationships)
      } catch (error) {
        Logger.error(error, `Error processing document ${doc.docId}`)
        // Continue with other documents
      }
    }

    return {
      entities: batchEntities,
      relationships: batchRelationships,
    }
  }

  /**
   * Extract entities from a single document using LLM
   */
  async extractEntitiesFromDocument(
    document: DocumentForProcessing,
    existingEntities: EnhancedEntity[],
  ): Promise<EnhancedEntity[]> {
    try {
      // Prepare existing entities context
      const existingEntitiesContext =
        existingEntities.length > 0
          ? existingEntities
              .map((e) => `${e.entityId}: ${e.entityName} (${e.entityType})`)
              .join("\n")
          : "None"

      // Prepare prompt
      const prompt = ENTITY_EXTRACTION_PROMPT.replace(
        "{existing_entities}",
        existingEntitiesContext,
      )
        .replace("{document_id}", document.docId)
        .replace("{document_title}", document.title || "")
        .replace("{document_schema}", document.schema)
        .replace(
          "{document_content}",
          this.truncateContent(document.content, 4000),
        )

      // Call LLM
      const provider = getProviderByModel(this.modelId)
      const response = await provider.converse(
        [{ role: "user", content: [{ text: prompt }] }],
        {
          modelId: this.modelId,
          json: true,
          temperature: 0.1,
          stream: false,
        },
      )

      if (!response.text) {
        Logger.warn(`No response from LLM for document ${document.docId}`)
        return []
      }

      // Parse response
      const parsed = this.parseJsonResponse(response.text)
      if (!parsed?.entities || !Array.isArray(parsed.entities)) {
        Logger.warn(
          `Invalid entity extraction response for document ${document.docId}`,
        )
        return []
      }

      // Validate and process entities
      const entities: EnhancedEntity[] = []
      for (const entityData of parsed.entities) {
        try {
          const entity = EnhancedEntitySchema.parse({
            ...entityData,
            sourceDocuments: [document.docId],
            createdAt: Date.now(),
            updatedAt: Date.now(),
            extractedBy: "enhanced-extractor",
          })
          entities.push(entity)
        } catch (error) {
          Logger.warn(
            `Invalid entity data in document ${document.docId}:`,
            entityData,
          )
        }
      }

      Logger.debug(
        `Extracted ${entities.length} entities from document ${document.docId}`,
      )
      return entities
    } catch (error) {
      Logger.error(
        error,
        `Error extracting entities from document ${document.docId}`,
      )
      return []
    }
  }

  /**
   * Extract relationships from a single document using LLM
   */
  async extractRelationshipsFromDocument(
    document: DocumentForProcessing,
    entities: EnhancedEntity[],
  ): Promise<EnhancedRelationship[]> {
    try {
      if (entities.length < 2) {
        return [] // Need at least 2 entities for relationships
      }

      // Prepare entities context
      const entitiesContext = entities
        .map((e) => `${e.entityId}: ${e.entityName} (${e.entityType})`)
        .join("\n")

      // Prepare prompt
      const prompt = RELATIONSHIP_EXTRACTION_PROMPT.replace(
        "{entities}",
        entitiesContext,
      )
        .replace("{document_id}", document.docId)
        .replace(
          "{document_content}",
          this.truncateContent(document.content, 3000),
        )

      // Call LLM
      const provider = getProviderByModel(this.modelId)
      const response = await provider.converse(
        [{ role: "user", content: [{ text: prompt }] }],
        {
          modelId: this.modelId,
          json: true,
          temperature: 0.1,
          stream: false,
        },
      )

      if (!response.text) {
        Logger.warn(
          `No response from LLM for relationships in document ${document.docId}`,
        )
        return []
      }

      // Parse response
      const parsed = this.parseJsonResponse(response.text)
      if (!parsed?.relationships || !Array.isArray(parsed.relationships)) {
        Logger.warn(
          `Invalid relationship extraction response for document ${document.docId}`,
        )
        return []
      }

      // Validate and process relationships
      const relationships: EnhancedRelationship[] = []
      for (const relData of parsed.relationships) {
        try {
          const relationship = EnhancedRelationshipSchema.parse({
            ...relData,
            sourceDocuments: [document.docId],
            createdAt: Date.now(),
            updatedAt: Date.now(),
            extractedBy: "enhanced-extractor",
          })
          relationships.push(relationship)
        } catch (error) {
          Logger.warn(
            `Invalid relationship data in document ${document.docId}:`,
            relData,
          )
        }
      }

      Logger.debug(
        `Extracted ${relationships.length} relationships from document ${document.docId}`,
      )
      return relationships
    } catch (error) {
      Logger.error(
        error,
        `Error extracting relationships from document ${document.docId}`,
      )
      return []
    }
  }

  /**
   * Merge entity data when the same entity is found in multiple documents
   */
  private mergeEntityData(
    existing: EnhancedEntity,
    newEntity: EnhancedEntity,
  ): void {
    // Merge source documents
    const newDocs = newEntity.sourceDocuments.filter(
      (doc) => !existing.sourceDocuments.includes(doc),
    )
    existing.sourceDocuments.push(...newDocs)

    // Merge summary chunks
    existing.summaryChunks.push(...newEntity.summaryChunks)

    // Merge keywords
    const newKeywords = newEntity.keywords.filter(
      (keyword) => !existing.keywords.includes(keyword),
    )
    existing.keywords.push(...newKeywords)

    // Update importance (take max)
    existing.importance = Math.max(existing.importance, newEntity.importance)

    // Update description if new one is longer or existing is empty
    if (
      !existing.description ||
      (newEntity.description &&
        newEntity.description.length > existing.description.length)
    ) {
      existing.description = newEntity.description
    }

    // Merge metadata
    existing.metadata = { ...existing.metadata, ...newEntity.metadata }

    // Update timestamp
    existing.metadata.updatedAt = Date.now()
  }

  /**
   * Get all entities from previous results
   */
  private getAllEntitiesFromResults(
    results: EnhancedExtractionResult[],
  ): EnhancedEntity[] {
    return results.flatMap((result) => result.entities)
  }

  /**
   * Merge multiple extraction results
   */
  private mergeResults(
    results: EnhancedExtractionResult[],
  ): EnhancedExtractionResult {
    const allEntities: EnhancedEntity[] = []
    const allRelationships: EnhancedRelationship[] = []

    // Merge entities (avoiding duplicates)
    const entityMap = new Map<string, EnhancedEntity>()

    for (const result of results) {
      for (const entity of result.entities) {
        if (entityMap.has(entity.entityId)) {
          const existing = entityMap.get(entity.entityId)!
          this.mergeEntityData(existing, entity)
        } else {
          entityMap.set(entity.entityId, { ...entity })
        }
      }
    }

    allEntities.push(...entityMap.values())

    // Merge relationships (avoiding duplicates)
    const relationshipMap = new Map<string, EnhancedRelationship>()

    for (const result of results) {
      for (const relationship of result.relationships) {
        if (!relationshipMap.has(relationship.relationshipId)) {
          relationshipMap.set(relationship.relationshipId, relationship)
        }
      }
    }

    allRelationships.push(...relationshipMap.values())

    return {
      entities: allEntities,
      relationships: allRelationships,
    }
  }

  /**
   * Convert extracted entities and relationships to Vespa format and send to Vespa
   */
  async saveToVespa(result: EnhancedExtractionResult): Promise<void> {
    Logger.info("Saving extraction results to Vespa")

    try {
      // Save entities
      for (const entity of result.entities) {
        const vespaEntity = this.entityToVespaFormat(entity)
        await this.vespaClient.insert(vespaEntity, {
          namespace: "knowledge_graph",
          schema: "kg_entity" as any,
        })
      }

      // Save relationships
      for (const relationship of result.relationships) {
        const vespaRelationship = this.relationshipToVespaFormat(relationship)
        await this.vespaClient.insert(vespaRelationship, {
          namespace: "knowledge_graph",
          schema: "kg_relationship" as any,
        })
      }

      Logger.info(
        `Successfully saved ${result.entities.length} entities and ${result.relationships.length} relationships to Vespa`,
      )
    } catch (error) {
      Logger.error(error, "Error saving extraction results to Vespa")
      throw error
    }
  }

  /**
   * Convert enhanced entity to Vespa format
   */
  private entityToVespaFormat(entity: EnhancedEntity): any {
    return {
      docId: entity.entityId,
      entityId: entity.entityId,
      entityName: entity.entityName,
      entityType: entity.entityType,
      description: entity.description || "",
      keywords: entity.keywords,
      sourceDocuments: entity.sourceDocuments,
      summaryChunks: entity.summaryChunks,
      importance: entity.importance,
      degree: 0, // Will be calculated later
      createdAt: Date.now(),
      updatedAt: Date.now(),
      extractedBy: "enhanced-extractor",
      confidence: entity.confidence,
      metadata: JSON.stringify(entity.metadata),
    }
  }

  /**
   * Convert enhanced relationship to Vespa format
   */
  private relationshipToVespaFormat(relationship: EnhancedRelationship): any {
    return {
      docId: relationship.relationshipId,
      relationshipId: relationship.relationshipId,
      sourceEntityId: relationship.sourceEntityId,
      targetEntityId: relationship.targetEntityId,
      sourceEntityName: relationship.sourceEntityName,
      targetEntityName: relationship.targetEntityName,
      relationshipType: relationship.relationshipType,
      description: relationship.description || "",
      keywords: relationship.keywords,
      weight: relationship.weight,
      strength: relationship.strength,
      sourceDocuments: relationship.sourceDocuments,
      bidirectional: relationship.bidirectional,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      extractedBy: "enhanced-extractor",
      confidence: relationship.confidence,
      metadata: JSON.stringify(relationship.metadata),
    }
  }

  /**
   * Parse JSON response from LLM with error handling
   */
  private parseJsonResponse(text: string): any {
    try {
      // Try to extract JSON from text
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        throw new Error("No JSON found in response")
      }

      return JSON.parse(jsonMatch[0])
    } catch (error) {
      Logger.error(error, `Failed to parse JSON response: ${text}`)
      return null
    }
  }

  /**
   * Truncate content to fit within token limits
   */
  private truncateContent(content: string, maxLength: number): string {
    if (content.length <= maxLength) {
      return content
    }
    return content.substring(0, maxLength) + "..."
  }

  /**
   * Get extraction statistics
   */
  async getExtractionStats(): Promise<{
    totalEntities: number
    totalRelationships: number
    entitiesByType: Record<string, number>
    relationshipsByType: Record<string, number>
  }> {
    try {
      // Query entities
      const entityResponse = await this.vespaClient.search<VespaSearchResponse>(
        {
          yql: "select * from sources kg_entity where true",
          hits: 0,
        },
      )

      // Query relationships
      const relationshipResponse =
        await this.vespaClient.search<VespaSearchResponse>({
          yql: "select * from sources kg_relationship where true",
          hits: 0,
        })

      return {
        totalEntities: entityResponse.root?.fields?.totalCount || 0,
        totalRelationships: relationshipResponse.root?.fields?.totalCount || 0,
        entitiesByType: {},
        relationshipsByType: {},
      }
    } catch (error) {
      Logger.error(error, "Error getting extraction stats")
      return {
        totalEntities: 0,
        totalRelationships: 0,
        entitiesByType: {},
        relationshipsByType: {},
      }
    }
  }
}
