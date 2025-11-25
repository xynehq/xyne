import { Apps, fileSchema } from "@xyne/vespa-ts/types"
import type { TxnOrClient } from "@/types"
import { AuthType, ConnectorStatus } from "@/shared/types"
import { getConnectorByAppAndEmailId } from "@/db/connector"
import { getAppSyncJobsByEmail } from "@/db/syncJob"
import config from "@/config"
import type { SelectPublicAgent } from "@/db/schema/agents"
import { ifDocumentsExistInChatContainer, getDocumentOrNull } from "@/search/vespa"
import { isAppSelectionMap, parseAppSelections } from "./utils"
import type { VespaFile } from "@xyne/vespa-ts/types"
import type {
  ResourceAccessItem,
  ResourceAccessSummary,
} from "./tool-schemas"
import {
  buildKnowledgeBaseCollectionSelections,
  KnowledgeBaseScope,
} from "@/api/chat/knowledgeBaseSelections"

export type UserConnectorState = {
  slackConnected: boolean
  googleDriveSynced: boolean
  gmailSynced: boolean
  googleCalendarSynced: boolean
  googleWorkspaceSynced: boolean
  microsoftDriveSynced: boolean
  microsoftSharepointSynced: boolean
  microsoftOutlookSynced: boolean
  microsoftCalendarSynced: boolean
  githubConnected: boolean
}

export function createEmptyConnectorState(): UserConnectorState {
  return {
    slackConnected: false,
    googleDriveSynced: false,
    gmailSynced: false,
    googleCalendarSynced: false,
    googleWorkspaceSynced: false,
    microsoftDriveSynced: false,
    microsoftSharepointSynced: false,
    microsoftOutlookSynced: false,
    microsoftCalendarSynced: false,
    githubConnected: false,
  }
}

type ResourceItem = ResourceAccessItem

type ResourceItemsResult = {
  available: ResourceItem[]
  missing: ResourceItem[]
}

const RUNTIME_CHECK_APPS = new Set<Apps>([
  Apps.Gmail,
  Apps.GoogleCalendar,
  Apps.GoogleWorkspace,
  Apps.MicrosoftOutlook,
  Apps.MicrosoftCalendar,
])

const DRIVE_LIKE_APPS = new Set<Apps>([
  Apps.GoogleDrive,
  Apps.MicrosoftDrive,
  Apps.MicrosoftSharepoint,
])

export async function getUserConnectorState(
  trx: TxnOrClient,
  userEmail: string,
): Promise<UserConnectorState> {
  const [
    slackConnected,
    googleDriveSynced,
    gmailSynced,
    googleCalendarSynced,
    googleWorkspaceSynced,
    microsoftDriveSynced,
    microsoftSharepointSynced,
    microsoftOutlookSynced,
    microsoftCalendarSynced,
    githubConnected,
  ] = await Promise.all([
    hasConnector(trx, Apps.Slack, userEmail),
    hasSyncJob(trx, Apps.GoogleDrive, userEmail),
    hasSyncJob(trx, Apps.Gmail, userEmail),
    hasSyncJob(trx, Apps.GoogleCalendar, userEmail),
    hasSyncJob(trx, Apps.GoogleWorkspace, userEmail),
    hasConnector(trx, Apps.MicrosoftDrive, userEmail),
    hasConnector(trx, Apps.MicrosoftSharepoint, userEmail),
    hasConnector(trx, Apps.MicrosoftOutlook, userEmail),
    hasConnector(trx, Apps.MicrosoftCalendar, userEmail),
    hasConnector(trx, Apps.Github, userEmail),
  ])

  return {
    slackConnected,
    googleDriveSynced,
    gmailSynced,
    googleCalendarSynced,
    googleWorkspaceSynced,
    microsoftDriveSynced,
    microsoftSharepointSynced,
    microsoftOutlookSynced,
    microsoftCalendarSynced,
    githubConnected,
  }
}

export async function evaluateAgentResourceAccess(params: {
  agent: SelectPublicAgent
  userEmail: string
  connectorState: UserConnectorState
}): Promise<ResourceAccessSummary[]> {
  const { agent, userEmail, connectorState } = params

  const {
    selectedApps,
    selectedItems: selectionMap,
  } = extractAgentSelections(agent)

  const summaries: ResourceAccessSummary[] = []

  for (const app of selectedApps) {
    const gateStatus = getConnectorGateStatus(app, connectorState)
    const itemIds = dedupe(selectionMap[app] || [])

    if (!gateStatus.available) {
      summaries.push({
        app,
        status: "missing",
        note: gateStatus.reason,
      })
      continue
    }

    if (itemIds.length && app === Apps.Slack && connectorState.slackConnected) {
      const { available, missing } = await evaluateSlackChannels(
        userEmail,
        itemIds,
      )
      summaries.push({
        app,
        status: deriveStatus(available.length, missing.length),
        availableItems: available,
        missingItems: missing,
      })
      continue
    }

    if (itemIds.length && DRIVE_LIKE_APPS.has(app)) {
      const { available, missing } = await evaluateDriveLikeItems(
        userEmail,
        itemIds,
      )
      summaries.push({
        app,
        status: deriveStatus(available.length, missing.length),
        availableItems: available,
        missingItems: missing,
      })
      continue
    }

    if (app === Apps.KnowledgeBase) {
      const kbSelections = await buildKnowledgeBaseCollectionSelections({
        scope: KnowledgeBaseScope.AgentScoped,
        email: userEmail,
        selectedItems: selectionMap,
      })
      const hasCollections = kbSelections.length > 0
      summaries.push({
        app,
        status: hasCollections ? "available" : "missing",
        availableItems: hasCollections
          ? (selectionMap[app] || []).map((id) => ({ id }))
          : undefined,
        note: hasCollections
          ? undefined
          : "No permitted knowledge base collections configured for this agent.",
      })
      continue
    }

    const status = RUNTIME_CHECK_APPS.has(app) ? "check_at_usage" : "available"
    summaries.push({
      app,
      status,
      note:
        status === "check_at_usage"
          ? "Connector linked; data availability validated when the tool runs."
          : undefined,
    })
  }

  return summaries
}

function extractAgentSelections(agent: SelectPublicAgent): {
  selectedApps: Apps[]
  selectedItems: Record<Apps, string[]>
} {
  const appsSet = new Set<Apps>()
  const items: Record<Apps, string[]> = {} as Record<Apps, string[]>

  const integrations = agent.appIntegrations
  if (!integrations) {
    return { selectedApps: [], selectedItems: {} as Record<Apps, string[]> }
  }

  if (isAppSelectionMap(integrations)) {
    const { selectedApps, selectedItems } = parseAppSelections(integrations)
    selectedApps.forEach((app) => appsSet.add(app))
    for (const [app, ids] of Object.entries(selectedItems)) {
      if (!ids?.length) continue
      const key = app as Apps
      items[key] = dedupe(ids)
    }
    return { selectedApps: Array.from(appsSet), selectedItems: items }
  }

  if (Array.isArray(integrations)) {
    integrations.forEach((entry) => {
      const normalized = normalizeApp(entry)
      if (normalized) {
        appsSet.add(normalized)
      }
    })
  }

  if (Array.isArray(agent.docIds) && agent.docIds.length > 0) {
    const driveDocMap: Record<Apps, string[]> = {} as Record<Apps, string[]>
    for (const record of agent.docIds) {
      if (!record) continue
      if (typeof record === "string") {
        appendDocId(driveDocMap, Apps.GoogleDrive, record)
        continue
      }
      const rawDocId = (record as any).docId
      if (!rawDocId) continue
      const docApp = normalizeApp(String((record as any).app || "googledrive"))
      if (!docApp || !DRIVE_LIKE_APPS.has(docApp)) {
        continue
      }
      appendDocId(driveDocMap, docApp, rawDocId)
    }
    for (const [appKey, docIds] of Object.entries(driveDocMap)) {
      const app = appKey as Apps
      const deduped = dedupe(docIds)
      if (!deduped.length) continue
      appsSet.add(app)
      if (items[app]) {
        items[app] = dedupe([...items[app], ...deduped])
      } else {
        items[app] = deduped
      }
    }
  }

  return { selectedApps: Array.from(appsSet), selectedItems: items }

  function appendDocId(
    bucket: Record<Apps, string[]>,
    app: Apps,
    docId: string,
  ) {
    if (!bucket[app]) {
      bucket[app] = []
    }
    bucket[app]!.push(docId)
  }
}

function normalizeApp(value: string): Apps | null {
  const normalized = value.toLowerCase()
  switch (normalized) {
    case "googledrive":
    case "googlesheets":
    case "googleslides":
    case "googledocs":
      return Apps.GoogleDrive
    case "gmail":
      return Apps.Gmail
    case "googlecalendar":
      return Apps.GoogleCalendar
    case "google-workspace":
      return Apps.GoogleWorkspace
    case "slack":
      return Apps.Slack
    case "github":
      return Apps.Github
    case "microsoftdrive":
      return Apps.MicrosoftDrive
    case "microsoftsharepoint":
      return Apps.MicrosoftSharepoint
    case "microsoftoutlook":
      return Apps.MicrosoftOutlook
    case "microsoftcalendar":
      return Apps.MicrosoftCalendar
    default:
      return null
  }
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function getConnectorGateStatus(
  app: Apps,
  state: UserConnectorState,
): { available: boolean; reason?: string } {
  switch (app) {
    case Apps.GoogleDrive:
      return state.googleDriveSynced
        ? { available: true }
        : {
            available: false,
            reason: "Google Drive is not connected for this user.",
          }
    case Apps.Gmail:
      return state.gmailSynced
        ? { available: true }
        : { available: false, reason: "Gmail is not connected for this user." }
    case Apps.GoogleCalendar:
      return state.googleCalendarSynced
        ? { available: true }
        : {
            available: false,
            reason: "Google Calendar is not connected for this user.",
          }
    case Apps.GoogleWorkspace:
      return state.googleWorkspaceSynced
        ? { available: true }
        : {
            available: false,
            reason: "Google Workspace directory is not connected for this user.",
          }
    case Apps.MicrosoftDrive:
      return state.microsoftDriveSynced
        ? { available: true }
        : {
            available: false,
            reason: "Microsoft Drive is not connected for this user.",
          }
    case Apps.MicrosoftSharepoint:
      return state.microsoftSharepointSynced
        ? { available: true }
        : {
            available: false,
            reason: "Microsoft SharePoint is not connected for this user.",
          }
    case Apps.MicrosoftOutlook:
      return state.microsoftOutlookSynced
        ? { available: true }
        : {
            available: false,
            reason: "Microsoft Outlook is not connected for this user.",
          }
    case Apps.MicrosoftCalendar:
      return state.microsoftCalendarSynced
        ? { available: true }
        : {
            available: false,
            reason: "Microsoft Calendar is not connected for this user.",
          }
    case Apps.Slack:
      return state.slackConnected
        ? { available: true }
        : {
            available: false,
            reason: "Slack connector not linked for this user.",
          }
    case Apps.Github:
      return state.githubConnected
        ? { available: true }
        : {
            available: false,
            reason: "GitHub connector not linked for this user.",
          }
    default:
      return { available: true }
  }
}

async function evaluateSlackChannels(
  userEmail: string,
  channelIds: string[],
): Promise<ResourceItemsResult> {
  if (!channelIds.length) {
    return { available: [], missing: [] }
  }

  const existenceMap = await ifDocumentsExistInChatContainer(channelIds)
  const available: ResourceItem[] = []
  const missing: ResourceItem[] = []

  for (const channelId of channelIds) {
    const info = existenceMap[channelId]
    const item: ResourceItem = { id: channelId, type: "channel" }
    if (!info?.exists) {
      missing.push(item)
      continue
    }
    if (info.permissions?.includes(userEmail)) {
      available.push(item)
    } else {
      missing.push(item)
    }
  }

  return { available, missing }
}

async function evaluateDriveLikeItems(
  userEmail: string,
  docIds: string[],
): Promise<ResourceItemsResult> {
  if (!docIds.length) {
    return { available: [], missing: [] }
  }

  const available: ResourceItem[] = []
  const missing: ResourceItem[] = []

  await Promise.all(
    docIds.map(async (docId) => {
      try {
        const doc = await getDocumentOrNull(fileSchema, docId)
        if (!doc?.fields) {
          missing.push({ id: docId, type: "file" })
          return
        }
        const fields = doc.fields as VespaFile
        const permissions = fields.permissions || []
        const item: ResourceItem = {
          id: docId,
          label: fields.title || fields.fileName || docId,
          type: fields.entity || "file",
        }
        if (permissions.includes(userEmail)) {
          available.push(item)
        } else {
          missing.push(item)
        }
      } catch {
        missing.push({ id: docId, type: "file" })
      }
    }),
  )

  return { available, missing }
}

function deriveStatus(
  availableCount: number,
  missingCount: number,
): ResourceAccessSummary["status"] {
  if (availableCount > 0 && missingCount === 0) {
    return "available"
  }
  if (availableCount > 0 && missingCount > 0) {
    return "partial"
  }
  return "missing"
}

async function hasConnector(
  trx: TxnOrClient,
  app: Apps,
  email: string,
): Promise<boolean> {
  try {
    const connector = await getConnectorByAppAndEmailId(
      trx,
      app,
      AuthType.OAuth,
      email,
    )
    return connector.status === ConnectorStatus.Connected
  } catch {
    return false
  }
}

async function hasSyncJob(
  trx: TxnOrClient,
  app: Apps,
  email: string,
): Promise<boolean> {
  try {
    const jobs = await getAppSyncJobsByEmail(
      trx,
      app,
      config.CurrentAuthType,
      email,
    )
    return jobs.length > 0
  } catch {
    return false
  }
}
