import { GetDocument } from "@/search/vespa"

async function checkTicket() {
  const ticketId = "458844000265404589"
  const schema = "zoho_ticket"

  console.log(`\nChecking for ticket ${ticketId} in Vespa...`)

  try {
    const ticket = await GetDocument(schema as any, ticketId)
    console.log(`\n✅ SUCCESS! Ticket found in Vespa:`)
    console.log(`   ID: ${ticket.fields?.id}`)
    console.log(`   Ticket Number: ${ticket.fields?.ticketNumber}`)
    console.log(`   Subject: ${ticket.fields?.subject}`)
    console.log(`   Status: ${ticket.fields?.status}`)
    console.log(`   Department ID: ${ticket.fields?.departmentId}`)
    console.log(`   Created Time: ${ticket.fields?.createdTime}`)
  } catch (error: any) {
    console.log(`\n❌ TICKET NOT FOUND IN VESPA`)
    console.log(`   Error: ${error.message}`)
    console.log(`   Ticket ID: ${ticketId}`)
  }
}

checkTicket()
