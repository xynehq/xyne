import fs from "fs"

const scriptContent = fs.readFileSync(
  "/Users/user.name/repo/xyne/server/llm-email-script.py",
  "utf-8",
)

const toolData = {
  type: "email",
  value: scriptContent,
  config: {
    recipient: "avirupsinha10@gmail.com",
    from_email: "no-reply@xyne.io",
    content_type: "html",
  },
  createdBy: "system",
}

console.log(JSON.stringify(toolData, null, 2))
