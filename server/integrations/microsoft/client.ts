import { Client } from "@microsoft/microsoft-graph-client"
import type { AuthenticationProvider } from "@microsoft/microsoft-graph-client"
import { retryWithBackoff } from "@/utils"
import { Apps } from "@/shared/types"
import { Readable } from "stream"

// Simple authentication provider for Microsoft Graph
// Token refresh is handled at the connector level in server/db/connector.ts
class CustomAuthProvider implements AuthenticationProvider {
  private accessToken: string

  constructor(accessToken: string) {
    this.accessToken = accessToken
  }

  async getAccessToken(): Promise<string> {
    return this.accessToken
  }
}

// Microsoft Graph client interface similar to GoogleClient
export interface MicrosoftGraphClient {
  client: Client
  accessToken: string
  refreshToken?: string // Only for delegated clients
  tenantId?: string // Only for service clients
  clientId: string
  clientSecret: string
  betaClient: Client
  // Helper methods to get updated tokens after refresh
  getCurrentTokens(): {
    accessToken: string
    refreshToken?: string
    expiresAt?: Date
  }
}

export const updateMicrosoftGraphClient = (
  graphClient: MicrosoftGraphClient,
  accessToken: string,
  refreshToken?: string,
) => {
  graphClient.accessToken = accessToken
  if (refreshToken) graphClient.refreshToken = refreshToken

  const authProvider = new CustomAuthProvider(accessToken)

  graphClient.client = Client.initWithMiddleware({
    authProvider,
    defaultVersion: "v1.0",
  })
  graphClient.betaClient = Client.initWithMiddleware({
    authProvider,
    defaultVersion: "beta",
  })
}

// Create Microsoft Graph client similar to Google's pattern
export const createMicrosoftGraphClient = (
  accessToken: string,
  clientId: string,
  clientSecret: string,
  refreshToken?: string,
  tenantId?: string,
  tokenExpiresAt?: Date,
): MicrosoftGraphClient => {
  const authProvider = new CustomAuthProvider(accessToken)

  const client = Client.initWithMiddleware({
    authProvider,
    defaultVersion: "v1.0",
  })
  const betaClient = Client.initWithMiddleware({
    authProvider,
    defaultVersion: "beta",
  })

  return {
    client,
    accessToken,
    refreshToken,
    tenantId,
    clientId,
    clientSecret,
    betaClient,
    getCurrentTokens() {
      return {
        accessToken,
        refreshToken,
        expiresAt: tokenExpiresAt,
      }
    },
  }
}

// Helper function to make Microsoft Graph API calls with retry logic
export const makeGraphApiCall = async (
  graphClient: MicrosoftGraphClient,
  endpoint: string,
): Promise<any> => {
  return retryWithBackoff(
    async () => {
      const result = await graphClient.client.api(endpoint).get()
      return result
    },
    `Making Microsoft Graph API call to ${endpoint}`,
    Apps.MicrosoftDrive,
    1,
    graphClient,
  )
}
export const makeBetaGraphApiCall = async (
  graphClient: MicrosoftGraphClient,
  endpoint: string,
  options?: any,
): Promise<any> => {
  return retryWithBackoff(
    async () => {
      const result = await graphClient.betaClient.api(endpoint).get(options)
      return result
    },
    `Making Microsoft Graph API call to ${endpoint}`,
    Apps.MicrosoftDrive,
    1,
    graphClient,
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
    1,
    graphClient,
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
      1,
      graphClient,
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
  graphClient: MicrosoftGraphClient,
  fileId: string,
  driveId?: string,
): Promise<Buffer> {
  try {
    let endpoint: string

    if (driveId) endpoint = `drives/${driveId}/items/${fileId}/content`
    else endpoint = `me/drive/items/${fileId}/content`

    const response = await makeGraphApiCall(graphClient, endpoint)
    return await streamToBuffer(response)
  } catch (error) {
    throw new Error(`Failed to download file ${fileId}: ${error}`)
  }
}

async function streamToBuffer(stream: any): Promise<Buffer> {
  if (Buffer.isBuffer(stream)) {
    return stream // already a Buffer
  }

  if (stream instanceof ArrayBuffer) {
    return Buffer.from(stream)
  }

  if (typeof stream === "string") {
    return Buffer.from(stream, "binary")
  }

  // Node.js Readable or Web ReadableStream
  if (stream instanceof Readable) {
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    return Buffer.concat(chunks as any)
  }

  if (typeof stream.getReader === "function") {
    // Web ReadableStream (Bun / Fetch)
    const reader = stream.getReader()
    const chunks: Buffer[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks as any)
  }

  throw new Error("Unsupported response type: " + stream?.constructor?.name)
}

// Export types for consistency with Google integration
export type { Client as MicrosoftClient }
