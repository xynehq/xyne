import { db } from "@/db/client"
import { connectors } from "@/db/schema"
import { eq } from "drizzle-orm"
import { ZohoDeskClient } from "@/integrations/zoho/client"

async function downloadAttachment() {
  const results = await db
    .select()
    .from(connectors)
    .where(eq(connectors.app, "zoho-desk"))
    .limit(1)

  const connector = results[0]
  if (!connector) {
    console.log("No Zoho Desk connector found")
    return
  }

  const credentials = JSON.parse(connector.credentials as string)
  
  const client = new ZohoDeskClient({
    orgId: credentials.orgId || "",
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    refreshToken: credentials.refreshToken,
  })

  const url = "https://desk.zoho.com/api/v1/tickets/458844000263860317/threads/458844000264135441/attachments/458844000264135446/content"
  
  console.log("Downloading attachment from Zoho...")
  console.log("URL:", url)
  
  const buffer = await client.downloadAttachmentFromUrl(url)
  
  console.log("Downloaded successfully!")
  console.log("Size:", buffer.length, "bytes")
  console.log("First 100 bytes as text:", buffer.toString('utf8', 0, Math.min(100, buffer.length)))
  
  const fs = await import('fs/promises')
  await fs.writeFile('/tmp/zoho-attachment.png', buffer)
  console.log("Saved to: /tmp/zoho-attachment.png")
}

downloadAttachment()
