import { Client } from "@microsoft/microsoft-graph-client"
import type { AuthenticationProvider } from "@microsoft/microsoft-graph-client"
import { retryWithBackoff } from "@/utils"
import { Apps } from "@/shared/types"
import { Readable } from "stream"

// Custom authentication provider for Microsoft Graph
class CustomAuthProvider implements AuthenticationProvider {
  private accessToken: string
  private refreshToken: string
  private clientId: string
  private clientSecret: string

  constructor(
    accessToken: string,
    refreshToken: string,
    clientId: string,
    clientSecret: string,
  ) {
    this.accessToken = accessToken
    this.refreshToken = refreshToken
    this.clientId = clientId
    this.clientSecret = clientSecret
  }

  async getAccessToken(): Promise<string> {
    // For now, return the current access token
    // In a production environment, you'd want to check if it's expired
    // and refresh it if necessary
    return this.accessToken
  }
}

// Microsoft Graph client interface similar to GoogleClient
export interface MicrosoftGraphClient {
  client: Client
  accessToken: string
  refreshToken: string
  clientId: string
  clientSecret: string
}

// Create Microsoft Graph client similar to Google's pattern
export const createMicrosoftGraphClient = (
  accessToken: string,
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): MicrosoftGraphClient => {
  const authProvider = new CustomAuthProvider(
    accessToken,
    refreshToken,
    clientId,
    clientSecret,
  )

  const client = Client.initWithMiddleware({
    authProvider,
    defaultVersion: "v1.0",
  })

  return {
    client,
    accessToken,
    refreshToken,
    clientId,
    clientSecret,
  }
}

// Helper function to make Microsoft Graph API calls with retry logic
export const makeGraphApiCall = async (
  graphClient: MicrosoftGraphClient,
  endpoint: string,
  options?: any,
): Promise<any> => {
  return retryWithBackoff(
    async () => {
      const result = await graphClient.client.api(endpoint).get(options)
      return result
    },
    `Making Microsoft Graph API call to ${endpoint}`,
    Apps.MicrosoftDrive,
  )
}
export const makeGraphApiCallWithHeaders = async (
  graphClient: MicrosoftGraphClient,
  endpoint: string,
  headers: Record<string, string>,
  options?: any,
): Promise<any> => {
  return retryWithBackoff(
    async () => {
      const request = graphClient.client.api(endpoint)

      // Add custom headers
      Object.entries(headers).forEach(([key, value]) => {
        request.header(key, value)
      })

      const result = await request.get(options)
      return result
    },
    `Making Microsoft Graph API call to ${endpoint} with headers`,
    Apps.MicrosoftDrive,
  )
}

// Helper function for paginated requests
export const makePagedGraphApiCall = async (
  graphClient: MicrosoftGraphClient,
  endpoint: string,
  options?: any,
): Promise<any[]> => {
  const results: any[] = []
  let nextLink: string | undefined = endpoint

  while (nextLink) {
    const response: any = await retryWithBackoff(
      async () => {
        if (nextLink!.startsWith("http")) {
          // This is a full URL from @odata.nextLink
          const url = new URL(nextLink!)
          const path = url.pathname + url.search
          return await graphClient.client.api(path).get()
        } else {
          // This is a relative path
          return await graphClient.client.api(nextLink!).get(options)
        }
      },
      `Making paginated Microsoft Graph API call to ${nextLink}`,
      Apps.MicrosoftDrive,
    )

    if (response.value) {
      results.push(...response.value)
    }

    nextLink = response["@odata.nextLink"]
  }

  return results
}

// Download file from Microsoft Graph
export async function downloadFileFromGraph(
  graphClient: Client,
  fileId: string,
): Promise<Buffer> {
  try {
    const response = await graphClient
      .api(`/me/drive/items/${fileId}/content`)
      .get()

    return await streamToBuffer(response);

  } catch (error) {
    throw new Error(`Failed to download file ${fileId}: ${error}`)
  }
}


async function streamToBuffer(stream: any): Promise<Buffer> {
  if (Buffer.isBuffer(stream)) {
    return stream; // already a Buffer
  }

  if (stream instanceof ArrayBuffer) {
    return Buffer.from(stream);
  }

  if (typeof stream === "string") {
    return Buffer.from(stream, "binary");
  }

  // Node.js Readable or Web ReadableStream
  if (stream instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  if (typeof stream.getReader === "function") {
    // Web ReadableStream (Bun / Fetch)
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)));
  }

  throw new Error("Unsupported response type: " + stream?.constructor?.name);
}


// Export types for consistency with Google integration
export type { Client as MicrosoftClient }
