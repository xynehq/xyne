import * as readline from "readline"

const { GoogleGenerativeAI } = require("@google/generative-ai");

const API_KEY=process.env.GEMINI_API_KEY!
const genAI = new GoogleGenerativeAI("AIzaSyApacgZCZGUV5iYbgr6ZSH026OuwCnW2Mc");
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

const prompt = "Start by greeting the user, then follow with introducing yourself, your name, model, creators, purpose of existence and then proceed to ask and answer the questions. When something seems confusing show your thought process and reasoning too";

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
})

async function initPrompt() {
    const systemPrompt = prompt;
          try {
      const result = await model.generateContent(systemPrompt);
      console.log("\nAI: " + result.response.text() + "\n");
    } catch (error) {
      console.error("Error generating initial response:", error);
    }
    askQuestion(); // Start user input loop
}

async function askQuestion() {
    rl.question("Ask me something (type 'q' or 'quit' to exit): ", async (input) => {
      if (input.toLowerCase() === "q" || input.toLowerCase() === "quit") {
        console.log("Exiting...");
        rl.close();
        return;
      }
  
      try {
        const result = await model.generateContent(input);
        console.log("\nAI: " + result.response.text() + "\n");
      } catch (error) {
        console.error("Error generating response:", error);
      }
  
      askQuestion(); // Ask again
    });
}

initPrompt();
// const result = await model.generateContent(prompt);
// console.log(result.response.text());