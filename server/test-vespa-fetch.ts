import { GetDocument } from "@/search/vespa"

const ticketId = "458844000267272050"
const schema = "zoho_ticket"

console.log(`\n🔍 Testing Vespa fetch for ticket: ${ticketId}`)
console.log(`   Schema: ${schema}`)
console.log("")

GetDocument(schema as any, ticketId)
  .then((ticket) => {
    console.log("✅ SUCCESS: Ticket found in Vespa!")
    console.log("")
    console.log("Ticket Data:")
    console.log(JSON.stringify(ticket, null, 2))
    console.log("")
    process.exit(0)
  })
  .catch((error) => {
    console.log("❌ ERROR: Failed to fetch ticket")
    console.log("")
    console.log("Error Message:", error.message)
    console.log("Error Type:", error.constructor.name)
    console.log("")
    if (error.stack) {
      console.log("Stack Trace:")
      console.log(error.stack)
    }
    console.log("")
    process.exit(1)
  })
