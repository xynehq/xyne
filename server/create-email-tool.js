import fs from "fs"

const scriptContent = fs.readFileSync(
  "/Users/yash.daga/repo/xyne/server/llm-email-script.py",
  "utf-8",
)

const toolData = {
  type: "email",
  value: scriptContent,
  config: {
    recipient: "yash.daga@juspay.in",
    from_email: "aman.asrani@juspay.in",
    content_type: "html",
  },
  createdBy: "system",
}

console.log(JSON.stringify(toolData, null, 2))
