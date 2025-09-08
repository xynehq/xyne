import fs from "fs"

const scriptContent = fs.readFileSync(
  "/Users/yash.daga/repo/xyne/server/llm-analysis-script.py",
  "utf-8",
)

const toolData = {
  type: "python_script",
  value: scriptContent,
  config: {
    timeout: 600,
    description: "LLM-powered document analysis using OpenAI GPT",
  },
  createdBy: "system",
}

console.log(JSON.stringify(toolData, null, 2))
