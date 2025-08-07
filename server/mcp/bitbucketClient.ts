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
    // Input validation
    if (!url || typeof url !== 'string') {
      throw new Error('Invalid URL provided to fetchWithRetry')
    }
    if (!options || typeof options !== 'object') {
      throw new Error('Invalid options provided to fetchWithRetry')
    }

    try {
      const response = await fetch(url, options);

      if (!response.ok) {
        let errorMessage = `HTTP ${response.status}: ${response.statusText}`
        let errorDetails = ''
        
        try {
          errorDetails = await response.text()
        } catch (textError) {
          console.warn('Failed to read error response body:', textError)
        }

        if (response.status === 401) {
          console.error(`Authentication Error for URL ${url}:`, errorDetails)
          throw new Error(`Authentication failed: ${errorMessage}`)
        }
        
        if (response.status === 403) {
          console.error(`Access denied for URL ${url}:`, errorDetails)
          throw new Error(`Access denied: ${errorMessage}`)
        }
        
        if (response.status === 404) {
          console.error(`Resource not found for URL ${url}:`, errorDetails)
          throw new Error(`Resource not found: ${errorMessage}`)
        }
        
        if (response.status === 429 || response.status >= 500) {
          if (retryCount < this.maxRetries) {
            console.warn(`Retrying request to ${url} (attempt ${retryCount + 1}/${this.maxRetries}) due to: ${errorMessage}`)
            await this.delay(this.retryDelay * Math.pow(2, retryCount));
            return this.fetchWithRetry(url, options, retryCount + 1);
          }
          throw new Error(`Request failed after ${this.maxRetries} retries: ${errorMessage}`)
        }
        
        throw new Error(`Request failed: ${errorMessage}${errorDetails ? ` - ${errorDetails}` : ''}`)
      }

      return response.json();
    } catch (error) {
      if (
        retryCount < this.maxRetries &&
        !(error as Error).message.includes("HTTP") &&
        !(error as Error).message.includes("Authentication") &&
        !(error as Error).message.includes("Access denied") &&
        !(error as Error).message.includes("Resource not found")
      ) {
        console.warn(`Network error, retrying ${url} (attempt ${retryCount + 1}/${this.maxRetries}):`, (error as Error).message)
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
    // Input validation
    if (!projectKey || typeof projectKey !== 'string') {
      throw new Error('Invalid projectKey: must be a non-empty string')
    }
    if (!repoSlug || typeof repoSlug !== 'string') {
      throw new Error('Invalid repoSlug: must be a non-empty string')
    }
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('Invalid filePath: must be a non-empty string')
    }
    if (!Number.isInteger(startLine) || startLine < 1) {
      throw new Error('Invalid startLine: must be a positive integer')
    }
    if (!Number.isInteger(endLine) || endLine < 1) {
      throw new Error('Invalid endLine: must be a positive integer')
    }
    if (startLine > endLine) {
      throw new Error(`Invalid range: startLine (${startLine}) must be <= endLine (${endLine})`)
    }

    try {
      let url = `${this.baseUrl}/rest/api/latest/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repoSlug)}/browse/${filePath}?blame=true&noContent=true`;
      const limit = endLine - startLine + 1;
      url += `&start=${startLine - 1}&limit=${limit}`;
      console.log(`Fetching git blame from URL: ${url}`);
      
      const options: RequestInit = {
        method: "GET",
        headers: this.baseHeaders,
      };

      return await this.fetchWithRetry(url, options);
    } catch (error) {
      console.error(`Failed to get git blame for ${projectKey}/${repoSlug}/${filePath} lines ${startLine}-${endLine}:`, error)
      throw new Error(`Git blame request failed: ${(error as Error).message}`)
    }
  }

  async getCommit(
    projectKey: string,
    repoSlug: string,
    commitId: string
  ): Promise<any> {
    // Input validation
    if (!projectKey || typeof projectKey !== 'string') {
      throw new Error('Invalid projectKey: must be a non-empty string')
    }
    if (!repoSlug || typeof repoSlug !== 'string') {
      throw new Error('Invalid repoSlug: must be a non-empty string')
    }
    if (!commitId || typeof commitId !== 'string') {
      throw new Error('Invalid commitId: must be a non-empty string')
    }

    try {
      const url = `${this.baseUrl}/rest/api/latest/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repoSlug)}/commits/${encodeURIComponent(commitId)}`;
      console.log(`Fetching commit data from URL: ${url}`);
      
      const options: RequestInit = {
        method: "GET",
        headers: this.baseHeaders,
      };

      return await this.fetchWithRetry(url, options);
    } catch (error) {
      console.error(`Failed to get commit ${commitId} from ${projectKey}/${repoSlug}:`, error)
      throw new Error(`Commit request failed: ${(error as Error).message}`)
    }
  }

  async getFileContent(
    projectKey: string,
    repoSlug: string,
    filePath: string
  ): Promise<string> {
    // Input validation
    if (!projectKey || typeof projectKey !== 'string') {
      throw new Error('Invalid projectKey: must be a non-empty string')
    }
    if (!repoSlug || typeof repoSlug !== 'string') {
      throw new Error('Invalid repoSlug: must be a non-empty string')
    }
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('Invalid filePath: must be a non-empty string')
    }

    try {
      // Try to get structured content with pagination
      const structuredUrl = `${this.baseUrl}/rest/api/latest/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repoSlug)}/browse/${filePath}`;
      
      let structuredError: any = null;
    
      try {
        let allLines: string[] = [];
        let start = 0;
        let isLastPage = false;
        const pageSize = 2000; // Increase page size
        
        while (!isLastPage) {
          const pagedUrl = `${structuredUrl}?start=${start}&limit=${pageSize}`;
          
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
          } else {
            // If it's a single page string response, return it directly
            if (typeof response === 'string') {
              return response;
            }
            
            throw new Error('Unable to extract file content from structured response');
          }
        }
        
        return allLines.join('\n');
        
      } catch (error) {
        structuredError = error;
        console.warn(`Structured content fetch failed for ${projectKey}/${repoSlug}/${filePath}, trying raw format:`, error);
      }

      // Fallback: try raw content
      const rawUrl = `${this.baseUrl}/rest/api/latest/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repoSlug)}/browse/${filePath}?raw`;
      
      try {
        const rawResponse = await fetch(rawUrl, {
          method: "GET",
          headers: this.baseHeaders,
        });
        
        if (!rawResponse.ok) {
          throw new Error(`Raw fetch failed: HTTP ${rawResponse.status}: ${rawResponse.statusText}`);
        }
        
        return await rawResponse.text();
      } catch (rawError) {
        console.error(`Both structured and raw content fetching failed for ${projectKey}/${repoSlug}/${filePath}`)
        console.error(`Structured error:`, structuredError)
        console.error(`Raw error:`, rawError)
        throw new Error(`Failed to fetch file content: Both structured and raw methods failed. Last error: ${(rawError as Error).message}`);
      }
    } catch (error) {
      console.error(`Failed to get file content for ${projectKey}/${repoSlug}/${filePath}:`, error)
      throw new Error(`File content request failed: ${(error as Error).message}`)
    }
  }

  async getPullRequestsAsReviewer(params: {
    avatarSize?: number;
    order?: string;
    start?: number;
    limit?: number;
    state?: string;
  }): Promise<any> {
    const {
      avatarSize = 48,
      order = "participant_status",
      start = 0,
      limit = 25,
      state = "OPEN"
    } = params;

    try {
      const url = `${this.baseUrl}/rest/ui/latest/dashboard/pull-requests?avatarSize=${avatarSize}&order=${encodeURIComponent(order)}&start=${start}&limit=${limit}&state=${state}&role=REVIEWER`;
      console.log(`Fetching pull requests as reviewer from URL: ${url}`);
      
      const options: RequestInit = {
        method: "GET",
        headers: {
          ...this.baseHeaders,
          'accept': 'application/json, text/javascript, */*; q=0.01',
          'accept-language': 'en-US,en;q=0.9',
          'cache-control': 'no-cache',
          'content-type': 'application/json',
          'pragma': 'no-cache',
          'priority': 'u=1, i',
          'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"macOS"',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin',
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
          'x-requested-with': 'XMLHttpRequest'
        },
      };

      return await this.fetchWithRetry(url, options);
    } catch (error) {
      console.error(`Failed to get pull requests as reviewer:`, error)
      throw new Error(`Pull requests as reviewer request failed: ${(error as Error).message}`)
    }
  }

  async getPullRequestsAsAuthor(params: {
    avatarSize?: number;
    order?: string;
    start?: number;
    limit?: number;
    state?: string;
  }): Promise<any> {
    const {
      avatarSize = 48,
      order = "participant_status",
      start = 0,
      limit = 25,
      state = "OPEN"
    } = params;

    try {
      const url = `${this.baseUrl}/rest/ui/latest/dashboard/pull-requests?avatarSize=${avatarSize}&order=${encodeURIComponent(order)}&start=${start}&limit=${limit}&state=${state}&role=AUTHOR`;
      console.log(`Fetching pull requests as author from URL: ${url}`);
      
      const options: RequestInit = {
        method: "GET",
        headers: {
          ...this.baseHeaders,
          'accept': 'application/json, text/javascript, */*; q=0.01',
          'accept-language': 'en-US,en;q=0.9',
          'cache-control': 'no-cache',
          'content-type': 'application/json',
          'pragma': 'no-cache',
          'priority': 'u=1, i',
          'sec-ch-ua': '"Not;A=Brand";v="99", "Google Chrome";v="139", "Chromium";v="139"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"macOS"',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin',
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
          'x-requested-with': 'XMLHttpRequest'
        },
      };

      return await this.fetchWithRetry(url, options);
    } catch (error) {
      console.error(`Failed to get pull requests as author:`, error)
      throw new Error(`Pull requests as author request failed: ${(error as Error).message}`)
    }
  }

  async getPullRequestActivities(params: {
    projectKey: string;
    repoSlug: string;
    pullRequestId: number;
    avatarSize?: number;
    start?: number;
    limit?: number;
    markup?: boolean;
  }): Promise<any> {
    const {
      projectKey,
      repoSlug,
      pullRequestId,
      avatarSize = 48,
      start = 0,
      limit = 25,
      markup = true
    } = params;

    // Input validation
    if (!projectKey || typeof projectKey !== 'string') {
      throw new Error('Invalid projectKey: must be a non-empty string')
    }
    if (!repoSlug || typeof repoSlug !== 'string') {
      throw new Error('Invalid repoSlug: must be a non-empty string')
    }
    if (!Number.isInteger(pullRequestId) || pullRequestId < 1) {
      throw new Error('Invalid pullRequestId: must be a positive integer')
    }

    try {
      const url = `${this.baseUrl}/rest/api/latest/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repoSlug)}/pull-requests/${pullRequestId}/activities?avatarSize=${avatarSize}&start=${start}&limit=${limit}&markup=${markup}`;
      console.log(`Fetching pull request activities from URL: ${url}`);
      
      const options: RequestInit = {
        method: "GET",
        headers: {
          ...this.baseHeaders,
          'accept': 'application/json, text/javascript, */*; q=0.01',
          'accept-language': 'en-US,en;q=0.9',
          'cache-control': 'no-cache',
          'content-type': 'application/json',
          'pragma': 'no-cache',
          'priority': 'u=1, i',
          'sec-ch-ua': '"Not;A=Brand";v="99", "Google Chrome";v="139", "Chromium";v="139"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"macOS"',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin',
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
          'x-requested-with': 'XMLHttpRequest'
        },
      };

      return await this.fetchWithRetry(url, options);
    } catch (error) {
      console.error(`Failed to get pull request activities for ${projectKey}/${repoSlug}/pull-requests/${pullRequestId}:`, error)
      throw new Error(`Pull request activities request failed: ${(error as Error).message}`)
    }
  }
}

export default BitbucketClient;
