import fetch, { type RequestInit } from "node-fetch";

class BitbucketClient {
  private maxRetries: number = 3;
  private retryDelay: number = 1000;
  private baseUrl: string;
  private baseHeaders: Record<string, string>;

  constructor(baseUrl: string, userName: string, appPassword: string) {
    this.baseUrl = baseUrl;
    this.baseHeaders = {
      Accept: "application/json;charset=UTF-8",
      Authorization:
        "Basic " + Buffer.from(`${userName}:${appPassword}`).toString("base64"),
    };
  }

  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    retryCount = 0
  ): Promise<any> {
    try {
      const response = await fetch(url, options);

      if (!response.ok) {
        if (response.status === 401) {
          const errorBody = await response.text();
          console.error("Authentication Error:", errorBody);
        }
        if (response.status === 429 || response.status >= 500) {
          if (retryCount < this.maxRetries) {
            await this.delay(this.retryDelay * Math.pow(2, retryCount));
            return this.fetchWithRetry(url, options, retryCount + 1);
          }
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response.json();
    } catch (error) {
      if (
        retryCount < this.maxRetries &&
        !(error as Error).message.includes("HTTP")
      ) {
        await this.delay(this.retryDelay * Math.pow(2, retryCount));
        return this.fetchWithRetry(url, options, retryCount + 1);
      }
      throw error;
    }
  }

  async getGitBlame(
    projectKey: string,
    repoSlug: string,
    filePath: string,
    startLine: number,
    endLine: number
  ): Promise<any> {
    let url = `${this.baseUrl}/rest/api/latest/projects/${projectKey}/repos/${repoSlug}/browse/${filePath}?blame=true&noContent=true`;
    const limit = endLine - startLine + 1;
    url += `&start=${startLine - 1}&limit=${limit}`;
    console.log(`Fetching git blame from URL: ${url}`);
    const options: RequestInit = {
      method: "GET",
      headers: this.baseHeaders,
    };

    return this.fetchWithRetry(url, options);
  }

  async getCommit(
    projectKey: string,
    repoSlug: string,
    commitId: string
  ): Promise<any> {
    const url = `${this.baseUrl}/rest/api/latest/projects/${projectKey}/repos/${repoSlug}/commits/${commitId}`;
    console.log(`Fetching commit data from URL: ${url}`);
    const options: RequestInit = {
      method: "GET",
      headers: this.baseHeaders,
    };

    return this.fetchWithRetry(url, options);
  }

  async getFileContent(
    projectKey: string,
    repoSlug: string,
    filePath: string
  ): Promise<string> {
    // Try to get structured content with pagination
    const structuredUrl = `${this.baseUrl}/rest/api/latest/projects/${projectKey}/repos/${repoSlug}/browse/${filePath}`;
    // console.log(`Fetching structured file content from URL: ${structuredUrl}`);
    
    let structuredError: any = null;
    
    try {
      let allLines: string[] = [];
      let start = 0;
      let isLastPage = false;
      const pageSize = 2000; // Increase page size
      
      while (!isLastPage) {
        const pagedUrl = `${structuredUrl}?start=${start}&limit=${pageSize}`;
        // console.log(`Fetching page starting at line ${start}, limit ${pageSize}`);
        
        const response = await this.fetchWithRetry(pagedUrl, {
          method: "GET",
          headers: this.baseHeaders,
        });
        
        // Handle the structured response format
        if (response && response.lines && Array.isArray(response.lines)) {
          const extractedLines = response.lines.map((line: any) => {
            if (typeof line === 'object' && line.text !== undefined) {
              return line.text;
            }
            return line || '';
          });
          
          allLines = allLines.concat(extractedLines);
          
          // Check if this is the last page
          isLastPage = response.isLastPage === true || response.lines.length < pageSize;
          start += response.lines.length;
          
          // console.log(`Fetched ${response.lines.length} lines, total so far: ${allLines.length}, isLastPage: ${isLastPage}`);
        } else {
          // If it's a single page string response, return it directly
          if (typeof response === 'string') {
            return response;
          }
          
          throw new Error('Unable to extract file content from structured response');
        }
      }
      
      // console.log(`Total file content retrieved: ${allLines.length} lines`);
      return allLines.join('\n');
      
    } catch (error) {
      structuredError = error;
      // console.log("Structured content fetch failed, trying raw format:", error);
    }

    // Fallback: try raw content
    const rawUrl = `${this.baseUrl}/rest/api/latest/projects/${projectKey}/repos/${repoSlug}/browse/${filePath}?raw`;
    // console.log(`Fetching raw file content from URL: ${rawUrl}`);
    
    try {
      const rawResponse = await fetch(rawUrl, {
        method: "GET",
        headers: this.baseHeaders,
      });
      
      if (rawResponse.ok) {
        return await rawResponse.text();
      }
      
      throw new Error(`Raw fetch failed: HTTP ${rawResponse.status}: ${rawResponse.statusText}`);
    } catch (rawError) {
      throw new Error(`Both structured and raw content fetching failed. Structured error: ${structuredError}. Raw error: ${rawError}`);
    }
  }
}

export default BitbucketClient;
