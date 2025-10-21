// Shared data store for document management
export class DataStore {
  private static instance: DataStore
  private idToObjMap: Map<string, any> = new Map()
  private isLoaded: boolean = false

  private constructor() {}

  static getInstance(): DataStore {
    if (!DataStore.instance) {
      DataStore.instance = new DataStore()
    }
    return DataStore.instance
  }

  // Load JSONL data into the store
  loadData(jsonlData: string): void {
    console.log("🗄️  Loading data into shared store...")
    try {
      const lines = jsonlData.split("\n").filter(Boolean)
      console.log(`📊 Processing ${lines.length} lines...`)

      let loadedCount = 0
      lines.forEach((line, index) => {
        try {
          const obj = JSON.parse(line)
          const docId = obj.fields?.docId
          if (docId) {
            this.idToObjMap.set(docId, obj)
            loadedCount++
          } else {
            console.warn(`⚠️  Object at line ${index + 1} missing docId`)
          }
        } catch (err) {
          console.error(`❌ Failed to parse JSON at line ${index + 1}:`, err)
          throw err
        }
      })

      this.isLoaded = true
      console.log(
        `✅ Loaded ${loadedCount} documents into store (${this.idToObjMap.size} total)`,
      )
    } catch (err) {
      console.error("❌ Error loading data into store:", err)
      throw err
    }
  }

  // Get documents by their IDs
  getDocuments(docIds: Set<string>): any[] {
    if (!this.isLoaded) {
      throw new Error("Data store not loaded. Call loadData() first.")
    }

    console.log(`🔍 Retrieving ${docIds.size} documents from store...`)
    const documents: any[] = []
    let foundCount = 0

    for (const docId of docIds) {
      const doc = this.idToObjMap.get(docId)
      if (doc) {
        documents.push(doc)
        foundCount++
      } else {
        console.warn(`⚠️  Document not found for ID: ${docId}`)
      }
    }

    console.log(
      `📋 Retrieved ${foundCount}/${docIds.size} documents successfully`,
    )
    return documents
  }

  // Get a single document by ID
  getDocument(docId: string): any | undefined {
    return this.idToObjMap.get(docId)
  }

  // Get all document IDs
  getAllDocIds(): string[] {
    return Array.from(this.idToObjMap.keys())
  }

  // Check if store is loaded
  isDataLoaded(): boolean {
    return this.isLoaded
  }

  // Get store size
  getSize(): number {
    return this.idToObjMap.size
  }

  // Clear the store (for memory cleanup)
  clear(): void {
    console.log("🧹 Clearing data store...")
    this.idToObjMap.clear()
    this.isLoaded = false
    console.log("✅ Data store cleared")
  }
}

// Export interfaces for type safety
export interface GroupMetadata {
  rootId: string
  docIds: Set<string>
  intended_coverage_preference: "low" | "medium" | "high"
  actual_coverage_preference: "low" | "medium" | "high"
  depth: number
  actualSize: number
}
