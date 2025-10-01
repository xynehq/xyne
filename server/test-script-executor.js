import { executeScript, ScriptLanguage } from "./workflowScriptExecutorTool.ts"

async function testScriptExecutor() {
  console.log("Testing Script Executor Tool...\n")

  const testInput = {
    name: "John Doe",
    age: 30,
    city: "New York",
  }

  const testConfig = {
    theme: "dark",
    language: "en",
  }

  // Test Python
  console.log("=== Testing Python ===")
  const pythonScript = `
import os
print(os.listdir())
print(inputData["name"])
with open("tmp/export/test.txt","w") as f:
  f.write("hello world")
return inputData`

  try {
    const pythonResult = await executeScript({
      type: "restricted",
      language: ScriptLanguage.Python,
      script: pythonScript,
      input: testInput,
      config: testConfig,
    })

    console.log("Python Result:")
    console.log("Success:", pythonResult.success)
    console.log("Output:", pythonResult.output)
    console.log("Console Logs:", pythonResult.consoleLogs)
    console.log("Error:", pythonResult.error)
    console.log("Exit Code:", pythonResult.exitCode)
  } catch (error) {
    console.error("Python test failed:", error)
  }

  console.log("\n=== Testing JavaScript ===")
  const jsScript = `console.log(inputData.name);
return inputData;`

  try {
    const jsResult = await executeScript({
      type: "restricted",
      language: ScriptLanguage.JavaScript,
      script: jsScript,
      input: testInput,
      config: testConfig,
    })

    console.log("JavaScript Result:")
    console.log("Success:", jsResult.success)
    console.log("Output:", jsResult.output)
    console.log("Console Logs:", jsResult.consoleLogs)
    console.log("Error:", jsResult.error)
    console.log("Exit Code:", jsResult.exitCode)
  } catch (error) {
    console.error("JavaScript test failed:", error)
  }

  console.log("\n=== Testing R ===")
  const rScript = `print(inputData$name)
return(inputData)`

  try {
    const rResult = await executeScript({
      type: "restricted",
      language: ScriptLanguage.R,
      script: rScript,
      input: testInput,
      config: testConfig,
    })

    console.log("R Result:")
    console.log("Success:", rResult.success)
    console.log("Output:", rResult.output)
    console.log("Console Logs:", rResult.consoleLogs)
    console.log("Error:", rResult.error)
    console.log("Exit Code:", rResult.exitCode)
  } catch (error) {
    console.error("R test failed:", error)
  }
}

// Run the test
testScriptExecutor().catch(console.error)
