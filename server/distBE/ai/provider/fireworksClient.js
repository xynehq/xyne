class Fireworks {
    apiKey;
    timeout;
    maxRetries;
    baseUrl;
    constructor({ apiKey, timeout = 4 * 60 * 1000, maxRetries = 10, }) {
        this.apiKey = apiKey;
        this.timeout = timeout;
        this.maxRetries = maxRetries;
        this.baseUrl = "https://api.fireworks.ai/inference/v1/chat/completions";
    }
    async _makeRequest(messages, options = {}) {
        const defaultOptions = {
            model: "accounts/fireworks/models/deepseek-r1",
            max_tokens: 20480,
            top_p: 1,
            top_k: 40,
            presence_penalty: 0,
            frequency_penalty: 0,
            temperature: 0.6,
            stream: false,
        };
        const requestOptions = {
            ...defaultOptions,
            ...options,
            messages,
        };
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);
        try {
            return await fetch(this.baseUrl, {
                method: "POST",
                headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${this.apiKey}`,
                },
                body: JSON.stringify(requestOptions),
                signal: controller.signal,
            });
        }
        finally {
            clearTimeout(timeoutId);
        }
    }
    // Non-streaming API call
    async complete(messages, options = {}) {
        let retries = 0;
        while (retries < this.maxRetries) {
            try {
                const response = await this._makeRequest(messages, {
                    ...options,
                    stream: false,
                });
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                const data = await response.json();
                return data;
            }
            catch (error) {
                retries++;
                if (retries === this.maxRetries) {
                    throw error;
                }
                await new Promise((resolve) => setTimeout(resolve, Math.pow(2, retries) * 1000));
            }
        }
        throw new Error("Max retries exceeded");
    }
    // Generator-based streaming API
    async *streamComplete(messages, options = {}) {
        let retries = 0;
        while (retries < this.maxRetries) {
            try {
                const response = await this._makeRequest(messages, {
                    ...options,
                    stream: true,
                });
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) {
                        break;
                    }
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n\n");
                    for (let i = 0; i < lines.length - 1; i++) {
                        const line = lines[i].trim();
                        if (line.startsWith("data: ")) {
                            const jsonData = line.slice(6);
                            if (jsonData === "[DONE]") {
                                return;
                            }
                            try {
                                const parsedData = JSON.parse(jsonData);
                                const content = parsedData.choices[0]?.delta?.content;
                                if (content) {
                                    yield content;
                                }
                            }
                            catch (error) {
                                console.error("Error parsing JSON:", error);
                            }
                        }
                    }
                    buffer = lines[lines.length - 1];
                }
                return;
            }
            catch (error) {
                retries++;
                if (retries === this.maxRetries) {
                    throw error;
                }
                await new Promise((resolve) => setTimeout(resolve, Math.pow(2, retries) * 1000));
            }
        }
    }
}
// Example usage with types
async function example() {
    // Initialize with types
    const fireworks = new Fireworks({
        apiKey: "your-api-key",
        timeout: 4 * 60 * 1000,
        maxRetries: 10,
    });
    // Non-streaming with types
    const messages = [{ role: "user", content: "Hello!" }];
    const options = {
        temperature: 0.8,
        max_tokens: 1000,
    };
    try {
        // Non-streaming call
        const response = await fireworks.complete(messages, options);
        console.log("Complete response:", response);
        // Streaming call
        for await (const chunk of fireworks.streamComplete(messages, options)) {
            console.log("Chunk:", chunk);
        }
    }
    catch (error) {
        console.error("Error:", error);
    }
}
export { Fireworks };
