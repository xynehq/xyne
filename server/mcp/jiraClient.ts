import fetch, { type RequestInit } from 'node-fetch';

class JiraClient {
  private maxRetries: number = 3;
  private retryDelay: number = 1000;
  private baseUrl: string;
  private authHeader: string;

  constructor(baseUrl: string, email: string, apiToken: string) {
    this.baseUrl = baseUrl;
    this.authHeader = 'Basic ' + Buffer.from(`${email}:${apiToken}`).toString('base64');
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

  async getIssue(issueKey: string): Promise<any> {
    const url = `${this.baseUrl}/rest/api/3/issue/${issueKey}`;
    const options: RequestInit = {
      method: 'GET',
      headers: {
        'Authorization': this.authHeader,
        'Accept': 'application/json',
      },
    };

    return this.fetchWithRetry(url, options);
  }
}

export default JiraClient;
