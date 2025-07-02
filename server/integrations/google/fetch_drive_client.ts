import { google } from "googleapis"
import { getConnector } from "@/db/connector"
import { createJwtClient } from "@/integrations/google/utils"
import type { GoogleServiceAccount } from "@/types"
import { db } from "@/db/client" // Assuming db is initialized and exported from here
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Integrations).child({
  module: "fetch-drive-client",
})

async function logAccessToken(
  connectorId: number,
  emailToImpersonate: string,
): Promise<string | null> {
  try {
    Logger.info(
      `Fetching access token for connector ID: ${connectorId} and email: ${emailToImpersonate}`,
    )

    const connector = await getConnector(db, connectorId)

    if (!connector) {
      Logger.error(`Connector not found for connector ID: ${connectorId}`)
      throw new Error(`Connector not found for connector ID: ${connectorId}`)
    }

    if (connector.authType !== "service_account") {
      Logger.error(
        `Connector for connector ID: ${connectorId} is not a service account. AuthType found: ${connector.authType}`,
      )
      throw new Error(
        `Connector for connector ID: ${connectorId} is not a service account. AuthType found: ${connector.authType}`,
      )
    }

    const serviceAccountKey: GoogleServiceAccount = JSON.parse(
      connector.credentials as string,
    )

    const jwtClient = createJwtClient(serviceAccountKey, emailToImpersonate)
    Logger.info("JWT client created successfully.")

    try {
      const accessTokenResponse = await jwtClient.getAccessToken()
      if (accessTokenResponse && accessTokenResponse.token) {
        const token = accessTokenResponse.token
        Logger.info(`Short-lived Access Token (expires in ~1 hour): ${token}`)
        console.log(`COPY THIS ACCESS TOKEN: ${token}`)
        return token
      } else {
        Logger.warn("Could not retrieve access token.")
        return null
      }
    } catch (tokenError) {
      Logger.error("Error retrieving access token:", tokenError)
      return null
    }
  } catch (error) {
    Logger.error("Error in logAccessToken:", error)
    if (error instanceof Error) {
      Logger.error(`Stack trace: ${error.stack}`)
    }
    throw error // Re-throw the error to be caught by the caller
  }
}

// Example usage:
async function main() {
  const CONNECTOR_ID_TO_TEST = 0 // FIXME: Replace with a real connector ID (number)
  const EMAIL_TO_IMPERSONATE = "user@example.com" // FIXME: Replace with a real email to impersonate

  if (
    CONNECTOR_ID_TO_TEST === 0 ||
    EMAIL_TO_IMPERSONATE === "user@example.com"
  ) {
    Logger.warn(
      "Please replace placeholder values for CONNECTOR_ID_TO_TEST and EMAIL_TO_IMPERSONATE before running.",
    )
    return
  }

  try {
    const token = await logAccessToken(
      CONNECTOR_ID_TO_TEST,
      EMAIL_TO_IMPERSONATE,
    )
    if (token) {
      Logger.info("Access token successfully logged to console.")
    } else {
      Logger.error("Failed to obtain and log access token.")
    }
  } catch (error) {
    Logger.error("Failed to execute main function:", error)
  }
}

main().catch((e) => {
  Logger.error("Unhandled error in main execution:", e)
})
