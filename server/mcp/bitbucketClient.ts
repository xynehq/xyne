import fetch, { type RequestInit } from 'node-fetch';

class BitbucketClient {
  private maxRetries: number = 3;
  private retryDelay: number = 1000;
  private baseUrl: string;
  private baseHeaders: Record<string, string>;

  constructor(baseUrl: string, userName: string, appPassword: string) {
    this.baseUrl = baseUrl;
    this.baseHeaders = {
      'Accept': 'application/json;charset=UTF-8',
      'Authorization': 'Basic ' + Buffer.from(`${userName}:${appPassword}`).toString('base64'),
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
          console.error('Authentication Error:', errorBody);
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
      if (retryCount < this.maxRetries && !(error as Error).message.includes('HTTP')) {
        await this.delay(this.retryDelay * Math.pow(2, retryCount));
        return this.fetchWithRetry(url, options, retryCount + 1);
      }
      throw error;
    }
  }

  async getGitBlame(projectKey: string, repoSlug: string, filePath: string): Promise<any> {
    const url = `${this.baseUrl}/rest/api/latest/projects/${projectKey}/repos/${repoSlug}/browse/${filePath}?blame=true&noContent=true`;
    console.log(`Fetching git blame from URL: ${url}`);
    const options: RequestInit = {
      method: 'GET',
      headers: this.baseHeaders,
    };

    return this.fetchWithRetry(url, options);
  }
}

export default BitbucketClient;
