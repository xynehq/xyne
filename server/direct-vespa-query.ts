async function queryVespaDirect() {
  console.log("\n🎯 Direct Vespa YQL Query\n")
  
  const yql = `
    SELECT * FROM zoho_ticket
    WHERE
      departmentName contains "Credit"
      AND workspaceExternalId = "ws_clvama90i0001lf6gkac39apu"
    LIMIT 5
  `.trim().replace(/\s+/g, ' ')
  
  console.log("📝 YQL Query:")
  console.log(yql)
  console.log()
  
  const vespaUrl = "http://localhost:8080/search/"
  const params = new URLSearchParams({
    yql: yql,
    timeout: "10s"
  })
  
  console.log("🔗 Vespa URL: " + vespaUrl + "?" + params + "\n")
  
  try {
    const response = await fetch(vespaUrl + "?" + params)
    const data = await response.json()

    console.log("✅ Response received!")
    console.log("\n📦 Full Response:")
    console.log(JSON.stringify(data, null, 2))

    if (data.root && data.root.coverage) {
      console.log("\n📊 Coverage: " + data.root.coverage.coverage + "%")
      console.log("   Documents: " + data.root.coverage.documents)
    }

    if (data.root && data.root.children && data.root.children.length > 0) {
      console.log("\n📄 Found " + data.root.children.length + " tickets:\n")

      data.root.children.forEach((child: any, idx: number) => {
        const fields = child.fields
        console.log("   " + (idx + 1) + ". Ticket #" + fields.ticketNumber)
        console.log("      Subject: " + fields.subject)
        console.log("      Department: " + fields.departmentName)
        console.log("      Status: " + fields.status)
        console.log("      ID: " + fields.id)
        console.log()
      })
    } else {
      console.log("\n⚠️  No tickets found")
    }

  } catch (error: any) {
    console.error("\n❌ Failed: " + error.message)
    console.error(error)
  }
}

queryVespaDirect()
