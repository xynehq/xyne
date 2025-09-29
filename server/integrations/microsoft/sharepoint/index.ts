import { Tracker, StatType } from "@/integrations/tracker"
import { insertWithRetry } from "@/search/vespa"
import { DriveEntity, fileSchema } from "@xyne/vespa-ts"
import { Apps } from "@/shared/types"
import { makeGraphApiCall, type MicrosoftGraphClient } from "../client"
import { getEntityFromMimeType,loggerWithChild, getFilePermissionsSharepoint, processFileContent } from "../utils"
import type { Drive, DriveItem, Site } from "@microsoft/microsoft-graph-types"
import type { drive_v3 } from "googleapis"

// Function to discover all SharePoint sites
export const discoverSharePointSites = async (
  client: MicrosoftGraphClient,
  userEmail: string,
): Promise<Array<Site>> => {
  try {
    loggerWithChild({ email: userEmail }).info(
      "Discovering SharePoint sites...",
    )

    const sites: Array<Site> = []

    // Get all sites the service account has access to
    let nextLink: string | undefined =
      "/sites?$select=id,name,webUrl,displayName"

    while (nextLink) {
      const response = await makeGraphApiCall(client, nextLink)

      if (response.value && Array.isArray(response.value)) {
        for (const site of response.value) {
          sites.push(site as Site)
        }
      }

      nextLink = response["@odata.nextLink"]
    }

    return sites
  } catch (error) {
    loggerWithChild({ email: userEmail }).error(
      error,
      `Failed to discover SharePoint sites: ${error}`,
    )
    throw error
  }
}

// Function to discover all drives for each site
export const discoverSiteDrives = async (
  client: MicrosoftGraphClient,
  sites: Array<Site>,
  userEmail: string,
): Promise<Array<Drive>> => {
  try {
    loggerWithChild({ email: userEmail }).info(
      "Discovering drives for each site...",
    )

    const siteDrives: Array<Drive> = []

    for (const site of sites) {
      try {
        loggerWithChild({ email: userEmail }).info(
          `Discovering drives for site: ${site.name} (${site.id})`,
        )

        // Get all drives for this site
        const response = await makeGraphApiCall(
          client,
          `/sites/${site.id}/drives?$select=id,name,driveType,webUrl,sharepointIds`,
        )

        if (response.value && Array.isArray(response.value)) {
          for (const drive of response.value) {
            try {
              siteDrives.push(drive as Drive)

              loggerWithChild({ email: userEmail }).info(
                `Found Drive: ${drive.name} (${drive.id}) from site ${site.name}`,
              )
            } catch (error) {
              loggerWithChild({ email: userEmail }).warn(
                `Drive ${drive.name} in site ${site.name} does not support delta sync, skipping: ${error}`,
              )
            }
          }
        }
      } catch (error) {
        loggerWithChild({ email: userEmail }).error(
          error,
          `Failed to get drives for site ${site.name}: ${error}`,
        )
        // Continue with other sites even if one fails
      }
    }

    loggerWithChild({ email: userEmail }).info(
      `Discovered ${siteDrives.length} drives across ${sites.length} sites`,
    )

    return siteDrives
  } catch (error) {
    loggerWithChild({ email: userEmail }).error(
      error,
      `Failed to discover site drives: ${error}`,
    )
    throw error
  }
}

// Function to process each drive and collect delta tokens
export const processSiteDrives = async (
  client: MicrosoftGraphClient,
  siteDrives: Array<Drive>,
  userEmail: string,
  tracker?: Tracker,
): Promise<Record<string, string>> => {
  try {
    loggerWithChild({ email: userEmail }).info(
      `Processing ${siteDrives.length} drives for initial sync and delta token collection`,
    )

    const deltaLinks: Record<string, string> = {}

    let totalFiles = 0

    for (const siteDrive of siteDrives) {
      try {
        if (!siteDrive.sharePointIds?.siteId || !siteDrive.id) {
          loggerWithChild({ email: userEmail }).warn(
            `Skipping drive ${siteDrive.name} - missing sharePointIds or id`,
          )
          continue
        }
        loggerWithChild({ email: userEmail }).info(
          `Processing drive: ${siteDrive.name} from site: ${siteDrive.name}`,
        )

        let deltaLink = ""
        let driveFileCount = 0

        // Use delta API for initial sync to get all files and the delta token
        let nextLink: string | undefined =
          `/sites/${siteDrive.sharePointIds?.siteId}/drives/${siteDrive.id}/root/delta?$select=id,name,size,createdDateTime,lastModifiedDateTime,webUrl,file,folder,parentReference,createdBy,lastModifiedBy,@microsoft.graph.downloadUrl,deleted`

        while (nextLink) {
          const response = await makeGraphApiCall(client, nextLink)

          if (response.value && Array.isArray(response.value)) {
            for (const item of response.value) {
              try {
                let permissions: string[] = []
                if (siteDrive.id) {
                  permissions = await getFilePermissionsSharepoint(
                    client,
                    item.id,
                    siteDrive.id,
                  )
                }

                const fileToBeIngested = {
                  title: item.name ?? "",
                  url: item.webUrl ?? "",
                  app: Apps.MicrosoftSharepoint,
                  docId: item.id,
                  parentId: item.parentReference?.id ?? null,
                  owner: item.createdBy?.user?.displayName ?? userEmail,
                  photoLink: "",
                  ownerEmail: userEmail,
                  entity: getEntityFromMimeType(item.file?.mimeType),
                  chunks: await processFileContent(client, item, userEmail),
                  permissions,
                  mimeType: item.file?.mimeType ?? "application/octet-stream",
                  metadata: JSON.stringify({
                    size: item.size,
                    downloadUrl: item["@microsoft.graph.downloadUrl"],
                    siteId: siteDrive.sharePointIds?.siteId,
                    driveId: siteDrive.id,
                    driveName: siteDrive.name,
                    driveType: siteDrive.driveType,
                    parentId: item.parentReference?.id ?? "",
                    parentPath: item.parentReference?.path ?? "/",
                    eTag: item.eTag ?? "",
                  }),
                  createdAt: new Date(item.createdDateTime).getTime(),
                  updatedAt: new Date(item.lastModifiedDateTime).getTime(),
                }

                await insertWithRetry(fileToBeIngested, fileSchema)
                tracker?.updateUserStats(userEmail, StatType.Drive, 1)
                driveFileCount++
                totalFiles++

                if (driveFileCount % 100 === 0) {
                  loggerWithChild({ email: userEmail }).info(
                    `Processed ${driveFileCount} files from drive: ${siteDrive.name}`,
                  )
                }
              } catch (error) {
                loggerWithChild({ email: userEmail }).error(
                  error,
                  `Error processing file ${item.id} from drive ${siteDrive.name}: ${(error as Error).message}`,
                )
              }
            }
          }

          // Check for pagination and delta token
          if (response["@odata.nextLink"]) {
            nextLink = response["@odata.nextLink"]
          } else {
            // Final response should contain delta token
            deltaLink = response["@odata.deltaLink"] || ""
            nextLink = undefined
          }
        }

        // Store the delta token for this drive
        if (deltaLink && siteDrive.id) {
          deltaLinks[`${siteDrive.sharePointIds?.siteId}::${siteDrive.id}`] =
            deltaLink

          loggerWithChild({ email: userEmail }).info(
            `Stored delta token for drive ${siteDrive.name} (${siteDrive.id}): processed ${driveFileCount} files`,
          )
        } else {
          loggerWithChild({ email: userEmail }).warn(
            `No delta token received for drive ${siteDrive.name} (${siteDrive.id})`,
          )
        }
      } catch (error) {
        loggerWithChild({ email: userEmail }).error(
          error,
          `Error processing drive ${siteDrive.name} from site ${siteDrive.sharePointIds?.siteId}: ${(error as Error).message}`,
        )
      }
    }

    loggerWithChild({ email: userEmail }).info(
      `Completed processing ${siteDrives.length} drives. Total files processed: ${totalFiles}. Delta tokens collected for ${Object.keys(deltaLinks).length} drives.`,
    )

    return deltaLinks
  } catch (error) {
    loggerWithChild({ email: userEmail }).error(
      error,
      `Failed to process site drives: ${error}`,
    )
    throw error
  }
}
