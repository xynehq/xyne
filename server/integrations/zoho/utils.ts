import { getConnectorByAppAndEmailId } from "@/db/connector"
import { Apps, AuthType, ConnectorStatus } from "@/shared/types"
import type { TxnOrClient } from "@/types"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { getAppSyncJobsByEmail } from "@/db/syncJob"
import config from "@/config"

const Logger = getLogger(Subsystem.Integrations).child({ module: "zoho-utils" })

/**
 * Fetches permission IDs for Zoho Desk (department IDs) for the given user email.
 * This is used for permission filtering in Zoho Desk queries.
 *
 * @param trx Database transaction or client
 * @param email User email
 * @returns Array of permission IDs (department IDs for Zoho) or undefined if not found
 */
export async function fetchZohoPermissionIds(
  trx: TxnOrClient,
  email: string,
): Promise<string[] | undefined> {
  try {
    const zohoConnector = await getConnectorByAppAndEmailId(
      trx,
      Apps.ZohoDesk,
      AuthType.OAuth,
      email,
    )

    if (zohoConnector?.oauthCredentials) {
      try {
        const credentials = JSON.parse(zohoConnector.oauthCredentials as string)
        if (credentials.departmentIds && credentials.departmentIds.length > 0) {
          return credentials.departmentIds
        }
      } catch (parseError) {
        Logger.warn(
          `⚠️ Could not parse oauthCredentials for ${email}`,
          parseError,
        )
      }
    }
  } catch (error) {
    Logger.error(
      `❌ Could not fetch Zoho connector details for ${email}`,
      error,
    )
  }

  return undefined
}

/**
 * Check if user has Zoho Desk connected and active.
 *
 * @param trx Database transaction or client
 * @param email User email
 * @returns True if Zoho Desk is connected, false otherwise
 */
export async function isZohoDeskConnected(
  trx: TxnOrClient,
  email: string,
): Promise<boolean> {
  try {
    const zohoConnector = await getConnectorByAppAndEmailId(
      trx,
      Apps.ZohoDesk,
      AuthType.OAuth,
      email,
    )
    return Boolean(
      zohoConnector && zohoConnector.status === ConnectorStatus.Connected,
    )
  } catch (error) {
    return false
  }
}

/**
 * Get list of all connected apps for a user.
 * This is used to conditionally show app options in LLM prompts and
 * exclude disconnected apps from search group counts.
 *
 * @param trx Database transaction or client
 * @param email User email
 * @returns Array of connected Apps
 */
export async function getConnectedApps(
  trx: TxnOrClient,
  email: string,
): Promise<Apps[]> {
  const connectedApps: Apps[] = []

  // Check Slack
  try {
    const slackConnector = await getConnectorByAppAndEmailId(
      trx,
      Apps.Slack,
      AuthType.OAuth,
      email,
    )
    if (slackConnector && slackConnector.status === ConnectorStatus.Connected) {
      connectedApps.push(Apps.Slack)
    }
  } catch (error) {
    Logger.debug({ err: error, email }, "Slack not connected")
  }

  // Check Google apps (Drive, Gmail, Calendar)
  try {
    const [driveConnector, gmailConnector, calendarConnector] =
      await Promise.all([
        getAppSyncJobsByEmail(
          trx,
          Apps.GoogleDrive,
          config.CurrentAuthType,
          email,
        ),
        getAppSyncJobsByEmail(trx, Apps.Gmail, config.CurrentAuthType, email),
        getAppSyncJobsByEmail(
          trx,
          Apps.GoogleCalendar,
          config.CurrentAuthType,
          email,
        ),
      ])

    if (driveConnector && driveConnector.length > 0) {
      connectedApps.push(Apps.GoogleDrive)
    }
    if (gmailConnector && gmailConnector.length > 0) {
      connectedApps.push(Apps.Gmail)
    }
    if (calendarConnector && calendarConnector.length > 0) {
      connectedApps.push(Apps.GoogleCalendar)
    }
  } catch (error) {
    Logger.debug(
      { err: error, email },
      "Error fetching Google apps connection status",
    )
  }

  // Check Zoho Desk
  try {
    const zohoDeskConnector = await getConnectorByAppAndEmailId(
      trx,
      Apps.ZohoDesk,
      AuthType.OAuth,
      email,
    )
    if (
      zohoDeskConnector &&
      zohoDeskConnector.status === ConnectorStatus.Connected
    ) {
      connectedApps.push(Apps.ZohoDesk)
    }
  } catch (error) {
    Logger.debug({ err: error, email }, "Zoho Desk not connected")
  }

  return connectedApps
}
