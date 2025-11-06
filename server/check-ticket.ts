import { GetDocument } from "@/search/vespa"

async function checkTicket() {
  const ticketId = "458844000267272050"
  const schema = "zoho_ticket"
  
  console.log(`\nWaiting 3 seconds then checking for ticket...`)
  await new Promise(resolve => setTimeout(resolve, 3000))
  
  try {
    const ticket = await GetDocument(schema as any, ticketId)
    console.log(`\n✅ SUCCESS! Ticket found:`)
    console.log(`   ID: ${ticket.fields?.id}`)
    console.log(`   Ticket Number: ${ticket.fields?.ticketNumber}`)
    console.log(`   Subject: ${ticket.fields?.subject}`)
  } catch (error: any) {
    console.log(`\n❌ FAILED: ${error.message}`)
  }
}

checkTicket()
