import { searchVespa } from "@/search/vespa"

async function testCreditQuery() {
  console.log("\n🔍 Testing Zoho Desk query: department = Credit (no status filter)\n")
  
  const appFilters = {
    "zoho-desk": [{
      id: 1,
      departmentName: ["Credit"]
      // No status filter
    }]
  }
  
  const params = {
    workspaces: ["ws_clvama90i0001lf6gkac39apu"],
    schemas: ["zoho_ticket"],
    query: "Credit",
    appFilters,
    alpha: 0.5,
    limit: 5,
    offset: 0,
    email: "mohd.shoaib@juspay.in"
  }
  
  console.log("📋 Query Parameters:")
  console.log(JSON.stringify(params, null, 2))
  
  try {
    const results = await searchVespa(params as any)
    
    console.log(`\n✅ Query executed successfully!`)
    console.log(`   Total hits: ${results.totalCount}`)
    console.log(`   Documents returned: ${results.documents.length}`)
    
    if (results.documents.length > 0) {
      console.log(`\n📄 First ticket:`)
      const ticket = results.documents[0]
      console.log(`   ID: ${ticket.id}`)
      console.log(`   Ticket Number: ${ticket.ticketNumber}`)
      console.log(`   Subject: ${ticket.subject}`)
      console.log(`   Department: ${ticket.departmentName}`)
      console.log(`   Status: ${ticket.status}`)
    } else {
      console.log(`\n⚠️  No tickets found in Vespa`)
      console.log(`   This means either:`)
      console.log(`   1. No tickets have been ingested yet`)
      console.log(`   2. No tickets match department "Credit"`)
    }
    
  } catch (error: any) {
    console.log(`\n❌ Query failed: ${error.message}`)
  }
}

testCreditQuery()
