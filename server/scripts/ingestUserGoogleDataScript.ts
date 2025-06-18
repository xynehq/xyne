import { ServiceAccountIngestMoreUsers } from "@/integrations/google"
import { getLogger } from "@/logger"
import { db } from "@/db/client"
import { getConnector } from "@/db/connector"
import { Apps, AuthType } from "@/shared/types"
import { Subsystem } from "@/types"
import {
  serviceAccountConnectorId,
  WHITELISTED_EMAILS,
  ingestDrive,
  ingestEvent,
  ingestMail,
} from "./googleConfig"

const Logger = getLogger(Subsystem.Integrations).child({
  module: "ServiceAccountIngestionScript",
})

const runServiceAccountIngestion = async () => {
  try {
    if (!serviceAccountConnectorId) {
      throw new Error("CONNECTOR_ID environment variable is not set.")
    }

    const connector = await getConnector(db, serviceAccountConnectorId)
    if (!connector) {
      throw new Error(
        `Connector with ID ${serviceAccountConnectorId} not found.`,
      )
    }

    const ingestionPayload = {
      connectorId: connector.externalId,
      emailsToIngest: WHITELISTED_EMAILS?.split(",") || [],
      startDate: "",
      endDate: "",
      insertDriveAndContacts: ingestDrive,
      insertGmail: ingestMail,
      insertCalendar: ingestEvent,
    }

    Logger.info(
      `Starting ingestion for connector ID: ${serviceAccountConnectorId}`,
    )
    await ServiceAccountIngestMoreUsers(ingestionPayload, connector.userId)
    Logger.info(
      `Ingestion completed successfully for connector ID: ${serviceAccountConnectorId}`,
    )
  } catch (error) {
    Logger.error(
      error,
      `Error during service account ingestion: ${(error as Error).message}`,
    )
    process.exit(1)
  }
}

runServiceAccountIngestion()
