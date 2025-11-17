import { DeleteDocument } from "./search/vespa"

async function clearAllZohoTickets() {
  let totalDeleted = 0
  let hasMore = true
  
  while (hasMore) {
    // Fetch batch of document IDs
    const response = await fetch(
      `http://localhost:8080/search/?yql=select%20id%20from%20zoho_ticket%20where%20true%20limit%20100`
    )
    
    const data = await response.json()
    const docs = data.root?.children || []
    
    if (docs.length === 0) {
      hasMore = false
      break
    }
    
    console.log(`Deleting ${docs.length} documents...`)
    
    // Delete each document
    for (const doc of docs) {
      const docId = doc.fields.id
      try {
        await DeleteDocument("zoho_ticket" as any, docId)
        totalDeleted++
        if (totalDeleted % 10 === 0) {
          console.log(`Deleted ${totalDeleted} documents so far...`)
        }
      } catch (error) {
        console.error(`Failed to delete ${docId}:`, error)
      }
    }
  }
  
  console.log(`✅ Total deleted: ${totalDeleted} documents`)
}

clearAllZohoTickets().catch(console.error)
