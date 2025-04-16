import { getConnector } from "@/db/connector"
import type { SelectConnector } from "@/db/schema"
import {
  Apps,
  WhatsAppEntity,
  whatsappContactSchema,
  chatContainerSchema,
  chatMessageSchema,
  type VespaWhatsAppContact,
  type VespaChatContainer,
  type VespaChatMessage,
} from "@/search/types"
import { insert, NAMESPACE, GetDocument } from "@/search/vespa"
import { Subsystem, type SaaSOAuthJob } from "@/types"
import type PgBoss from "pg-boss"
import { db } from "@/db/client"
import { getLogger } from "@/logger"
import { StatType, Tracker } from "@/integrations/tracker"
import { sendWebsocketMessage } from "../metricStream"
import {
  default as makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  makeInMemoryStore,
} from "@whiskeysockets/baileys"
import type { WASocket } from "@whiskeysockets/baileys"
import { Boom } from "@hapi/boom"
import { proto } from "@whiskeysockets/baileys"
import { generateQR } from "@/integrations/whatsapp/qr"
import * as fs from "fs"
import * as path from "path"
import { eq } from "drizzle-orm"
import { connectors } from "@/db/schema"
import { AuthType, ConnectorStatus } from "@/shared/types"

const Logger = getLogger(Subsystem.Integrations).child({ module: "whatsapp" })

interface WhatsAppMessage {
  key: proto.IMessageKey
  message: proto.IMessage
  timestamp: number
}

interface WhatsAppContact {
  id: string
  name: string
  phoneNumber: string
}

interface WhatsAppConversation {
  id: string
  contactId: string
  lastMessageTimestamp: number
}

interface WhatsAppGroup {
  id: string
  subject: string
  creation: any // allow Long type
  owner?: string
  desc?: string
  participants: {
    id: string
    admin?: string
    isSuperAdmin?: boolean
  }[]
}

interface WhatsAppStore {
  contacts: {
    all: () => Promise<Record<string, { name?: string }>>
  }
  chats: {
    all: () => Promise<
      Record<
        string,
        {
          conversationTimestamp?: number
          messages?: Record<
            string,
            {
              key: proto.IMessageKey
              message: proto.IMessage
              messageTimestamp: number
            }
          >
        }
      >
    >
    get: (id: string) => Promise<
      | {
          messages?: Record<
            string,
            {
              key: proto.IMessageKey
              message: proto.IMessage
              messageTimestamp: number
            }
          >
        }
      | undefined
    >
  }
}

const store = makeInMemoryStore({})
store.readFromFile = () => {}
store.writeToFile = () => {}

// Commenting out contacts functionality for now
/*
export const getContacts = async (sock: WASocket): Promise<WhatsAppContact[]> => {
  const contacts: WhatsAppContact[] = []
  const contactsList = await (sock as unknown as { store: WhatsAppStore }).store.contacts.all()
  
  for (const [id, contact] of Object.entries(contactsList)) {
    if (contact.name) {
      contacts.push({
        id,
        name: contact.name,
        phoneNumber: id.split('@')[0]
      })
    }
  }
  
  return contacts
}
*/

export const getConversations = async (
  sock: WASocket,
): Promise<WhatsAppConversation[]> => {
  const conversations: WhatsAppConversation[] = []
  try {
    // Wait for store to be ready
    await new Promise((resolve) => setTimeout(resolve, 1000))

    // Check if store exists and has chats
    if (!sock || !(sock as any).store || !(sock as any).store.chats) {
      Logger.info(
        "Store or chats not initialized yet, returning empty conversations",
      )
      return []
    }

    const chats = await (
      sock as unknown as { store: WhatsAppStore }
    ).store.chats.all()
    Logger.info(`Retrieved chats from store: ${JSON.stringify(chats, null, 2)}`)

    for (const [id, chat] of Object.entries(chats)) {
      if (chat.conversationTimestamp) {
        conversations.push({
          id,
          contactId: id.split("@")[0],
          lastMessageTimestamp: chat.conversationTimestamp,
        })
      }
    }
  } catch (error) {
    Logger.error(error, "Error getting conversations from store")
    return []
  }

  return conversations
}

export const getMessages = async (
  sock: WASocket,
  conversationId: string,
): Promise<WhatsAppMessage[]> => {
  const messages: WhatsAppMessage[] = []
  try {
    // Wait for store to be ready
    await new Promise((resolve) => setTimeout(resolve, 1000))

    // Check if store exists and has chats
    if (!sock || !(sock as any).store || !(sock as any).store.chats) {
      Logger.info(
        "Store or chats not initialized yet, returning empty messages",
      )
      return []
    }

    const chat = await (
      sock as unknown as { store: WhatsAppStore }
    ).store.chats.get(conversationId)
    Logger.info(
      `Retrieved chat from store for conversation ${conversationId}: ${JSON.stringify(chat, null, 2)}`,
    )

    if (chat?.messages) {
      for (const [id, message] of Object.entries(chat.messages)) {
        messages.push({
          key: message.key,
          message: message.message,
          timestamp: message.messageTimestamp,
        })
      }
    }
  } catch (error) {
    Logger.error(
      error,
      `Error getting messages from store for conversation ${conversationId}`,
    )
    return []
  }

  return messages
}

/**
 * Fetch profile picture with timeout and error handling
 */
const safeProfilePictureUrl = async (
  sock: WASocket | undefined,
  jid: string,
  type: "image" | "preview" = "image",
  timeoutMs: number = 10000,
): Promise<string | undefined> => {
  if (!sock) return undefined

  try {
    // Set up a promise that will automatically timeout
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    const pictureUrl = await Promise.race([
      sock.profilePictureUrl(jid, type),
      new Promise<string>((_, reject) => {
        setTimeout(
          () => reject(new Error("Profile picture fetch timeout")),
          timeoutMs,
        )
      }),
    ])

    clearTimeout(timeoutId)
    return pictureUrl
  } catch (error) {
    Logger.warn(`Failed to fetch profile picture for ${jid}: ${error}`)
    return undefined
  }
}

const insertWhatsAppMessage = async (
  email: string,
  message: WhatsAppMessage,
  conversationId: string,
  phoneNumber: string,
  permissions: string[],
  pictureUrl: string | undefined,
) => {
  if (!permissions.length || permissions.indexOf(email) === -1) {
    permissions = permissions.concat(email)
  }

  const messageText =
    message.message?.conversation ||
    message.message?.extendedTextMessage?.text ||
    ""
  if (messageText == "") return
  const now = Date.now()
  Logger.info(`Inserting WhatsApp message: ${messageText}`)

  return insert(
    // @ts-ignore
    {
      docId: message.key.id!,
      teamId: conversationId,
      channelId: conversationId,
      text: messageText,
      name: message.key.participant,
      username: phoneNumber,
      image: pictureUrl || "",
      userId: message.key.participant || phoneNumber,
      app: Apps.WhatsApp,
      entity: WhatsAppEntity.Message,
      createdAt: message.timestamp,
      updatedAt: now,
      threadId: "",
      attachmentIds: [],
      permissions,
      mentions: [],
      metadata: JSON.stringify({ type: "whatsapp_message" }),
    } as VespaChatMessage,
    chatMessageSchema,
  )
}

const insertWhatsAppContact = async (
  email: string,
  contact: WhatsAppContact,
  permissions: string[],
) => {
  if (!permissions.length || permissions.indexOf(email) === -1) {
    permissions = permissions.concat(email)
  }

  return insert(
    {
      docId: contact.id,
      phoneNumber: contact.phoneNumber,
      name: contact.name,
      app: Apps.WhatsApp,
      entity: WhatsAppEntity.Contact,
      permissions,
    } as VespaWhatsAppContact,
    whatsappContactSchema,
  )
}

const insertWhatsAppConversation = async (
  email: string,
  conversation: WhatsAppConversation,
  phoneNumber: string,
  permissions: string[],
) => {
  if (!permissions.length || permissions.indexOf(email) === -1) {
    permissions = permissions.concat(email)
  }

  const now = Date.now()
  return insert(
    {
      docId: conversation.id,
      name: phoneNumber, // Using phone number as name for direct messages
      teamId: conversation.id, // Using conversation ID as team ID
      creator: phoneNumber, // Using phone number as creator
      app: Apps.WhatsApp,
      isIm: true, // This is a direct message
      isMpim: false,
      createdAt: conversation.lastMessageTimestamp,
      updatedAt: now,
      description: `Chat with ${phoneNumber}`,
      count: 2, // Direct message has 2 participants
      isPrivate: false,
      isArchived: false,
      isGeneral: false,
      topic: `Chat with ${phoneNumber}`,
    } as VespaChatContainer,
    chatContainerSchema,
  )
}

const insertWhatsAppGroup = async (
  email: string,
  group: WhatsAppGroup,
  permissions: string[],
) => {
  if (!permissions.length || permissions.indexOf(email) === -1) {
    permissions = permissions.concat(email)
  }

  const now = Date.now()
  return insert(
    {
      docId: group.id,
      name: group.subject,
      teamId: group.id,
      creator: group.owner || "",
      app: Apps.WhatsApp,
      isIm: false,
      isMpim: true,
      createdAt: parseInt(String(group.creation), 10),
      updatedAt: now,
      description: group.desc || "",
      count: group.participants.length,
      isPrivate: false,
      isArchived: false,
      isGeneral: false,
      topic: group.desc || "",
    } as VespaChatContainer,
    chatContainerSchema,
  )
}

/**
 * Verifies if a document exists in Vespa by its ID and schema type
 * @param docId Document ID to check
 * @param schema Schema type (e.g., chatMessageSchema)
 * @returns Promise<boolean> true if document exists, false otherwise
 */
const verifyVespaPush = async (
  docId: string,
  schema: string,
): Promise<boolean> => {
  try {
    Logger.info(
      `Verifying document exists in Vespa: ${docId} (schema: ${schema})`,
    )
    // Cast schema to VespaSchema type to satisfy type checking
    const result = await GetDocument(schema as any, docId)

    if (result && result.fields && result.fields.docId === docId) {
      Logger.info(`Document ${docId} found in Vespa`)
      return true
    } else {
      Logger.info(`Document ${docId} not found in Vespa`)
      return false
    }
  } catch (error) {
    Logger.error(error, `Error verifying document ${docId} in Vespa`)
    return false
  }
}

/**
 * Helper function to insert data into Vespa and verify it was pushed successfully
 * @param docId Document ID
 * @param schema Schema type
 * @param insertFn The insert function to call
 * @returns Promise<boolean> true if insert and verification succeeded
 */
const insertAndVerify = async (
  docId: string,
  schema: string,
  insertFn: () => Promise<any>,
  maxRetries = 3,
): Promise<boolean> => {
  let retries = 0

  while (retries < maxRetries) {
    try {
      // Attempt to insert the document
      await insertFn()

      // Wait a moment for Vespa to process the document
      await new Promise((resolve) => setTimeout(resolve, 500))

      // Verify the document exists
      const exists = await verifyVespaPush(docId, schema)
      if (exists) {
        return true
      }

      Logger.info(
        `Document ${docId} verification failed, retrying (${retries + 1}/${maxRetries})...`,
      )
      retries++
    } catch (error) {
      Logger.error(error, `Error inserting document ${docId}`)
      retries++
    }
  }

  Logger.error(
    `Failed to insert and verify document ${docId} after ${maxRetries} attempts`,
  )
  return false
}

export const handleWhatsAppIngestion = async (
  boss: PgBoss,
  job: PgBoss.Job<any>,
) => {
  let sock: WASocket | undefined
  try {
    Logger.info(`Starting WhatsApp ingestion for job ${job.id}`)
    const data: SaaSOAuthJob = job.data as SaaSOAuthJob
    Logger.info(`Job data: ${JSON.stringify(data, null, 2)}`)

    // Clear any existing WhatsApp jobs for this connector
    Logger.info(`Clearing existing WhatsApp jobs`)
    try {
      await boss.purgeQueue("ingestion-SaaS")
      Logger.info("Successfully cleared existing WhatsApp jobs")
    } catch (error) {
      Logger.error(error, "Error clearing existing WhatsApp jobs")
    }

    Logger.info(`Fetching connector with ID: ${data.connectorId}`)
    const connector: SelectConnector = await getConnector(db, data.connectorId)
    Logger.info(`Found connector: ${JSON.stringify(connector, null, 2)}`)

    const tracker = new Tracker(Apps.WhatsApp, AuthType.Custom)
    // Initialize user stats immediately
    tracker.updateUserStats(data.email, StatType.WhatsApp_Message, 0)

    const authStatePath = `auth_info_${data.email}`
    Logger.info(`Using auth state path: ${authStatePath}`)

    // Check if auth state exists and try to validate it
    if (fs.existsSync(authStatePath)) {
      try {
        Logger.info("Found existing auth state, attempting to validate...")
        const { state } = await useMultiFileAuthState(authStatePath)
        if (!state || !state.creds || !state.creds.me) {
          Logger.info("Auth state exists but is invalid, removing...")
          fs.rmSync(authStatePath, { recursive: true, force: true })
        }
      } catch (error) {
        Logger.error(error, "Error validating existing auth state, removing...")
        fs.rmSync(authStatePath, { recursive: true, force: true })
      }
    }

    // Create auth directory if it doesn't exist
    if (!fs.existsSync(authStatePath)) {
      Logger.info(`Creating auth directory: ${authStatePath}`)
      fs.mkdirSync(authStatePath, { recursive: true })
    }

    Logger.info("Getting auth state...")
    const { state, saveCreds } = await useMultiFileAuthState(authStatePath)
    Logger.info("Auth state loaded successfully")

    Logger.info("Creating WhatsApp socket with config...")
    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      qrTimeout: 60000,
      connectTimeoutMs: 60000,
      retryRequestDelayMs: 250,
      logger: Logger as any,
      keepAliveIntervalMs: 10000,
      emitOwnEvents: true,
      markOnlineOnConnect: false,
      defaultQueryTimeoutMs: 60000,
      customUploadHosts: [],
      getMessage: async () => undefined,
    })
    Logger.info("WhatsApp socket created")

    // Bind store to socket events before setting up other handlers
    Logger.info("Binding store to socket events")
    store.bind(sock.ev)

    // Wait for store to be ready
    await new Promise((resolve) => setTimeout(resolve, 1000))

    let reconnectAttempts = 0
    const MAX_RECONNECT_ATTEMPTS = 5
    const RECONNECT_DELAY = 5000 // 5 seconds

    // Handle QR code generation
    sock.ev.on("connection.update", async (update) => {
      Logger.info(
        `Connection update received: ${JSON.stringify(update, null, 2)}`,
      )
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        Logger.info("Generating QR code")
        const qrCode = await generateQR(qr)
        Logger.info("QR code generated, sending via websocket")
        sendWebsocketMessage(
          JSON.stringify({
            qrCode,
            progress: 0,
            userStats: tracker.getOAuthProgress().userStats,
          }),
          connector.externalId,
        )
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
        const shouldReconnect =
          statusCode !== DisconnectReason.loggedOut &&
          statusCode !== DisconnectReason.connectionClosed &&
          reconnectAttempts < MAX_RECONNECT_ATTEMPTS

        Logger.info(
          `Connection closed. Status: ${statusCode}, Should reconnect: ${shouldReconnect}`,
        )

        if (shouldReconnect) {
          reconnectAttempts++
          Logger.info(
            `Attempting to reconnect (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`,
          )
          await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY))
          // Restart the entire ingestion process
          Logger.info("Restarting WhatsApp ingestion process")
          await handleWhatsAppIngestion(boss, job)
        } else {
          Logger.error(
            `Connection terminated (Status: ${statusCode}). Cleaning up...`,
          )
          fs.rmSync(authStatePath, { recursive: true, force: true })
        }
      } else if (connection === "connecting") {
        Logger.info("Connecting to WhatsApp...")
      } else if (connection === "open") {
        Logger.info("Connection opened successfully")
        reconnectAttempts = 0 // Reset reconnect attempts on successful connection
        Logger.info("Saving credentials...")
        await saveCreds()
        Logger.info("Credentials saved")

        // Update connector status to Connected
        Logger.info("Updating connector status to Connected")
        await db
          .update(connectors)
          .set({ status: ConnectorStatus.Connected })
          .where(eq(connectors.id, connector.id))
        Logger.info("Connector status updated successfully")

        // Start ingestion after successful connection
        Logger.info("Starting WhatsApp data ingestion")
        await startIngestion(sock!, data.email, connector.externalId, tracker)
      }
    })

    // Handle credentials update
    sock.ev.on("creds.update", async () => {
      Logger.info("Credentials updated, saving...")
      await saveCreds()
      Logger.info("Credentials saved successfully")
    })

    // Handle messages
    sock.ev.on("messages.upsert", async (m) => {
      Logger.info(`New message received: ${JSON.stringify(m, null, 2)}`)

      try {
        if (m.type === "append" || m.type === "notify") {
          for (const msg of m.messages) {
            if (msg.key && msg.message) {
              Logger.info(`msg`)
              Logger.info(msg)
              Logger.info(`msg`)
              const conversationId = msg.key.remoteJid || ""
              const phoneNumber = conversationId.split("@")[0]

              const whatsappMessage: WhatsAppMessage = {
                key: msg.key,
                message: msg.message,
                timestamp:
                  typeof msg.messageTimestamp === "number"
                    ? msg.messageTimestamp
                    : Number(msg.messageTimestamp),
              }

              let pictureUrl: string | undefined
              try {
                Logger.info("Started fetching profile picture")
                pictureUrl = await safeProfilePictureUrl(
                  sock,
                  (msg.key.participant as string) ||
                    (msg.key.remoteJid as string),
                )
              } catch (error) {
                Logger.warn(`Error fetching profile picture: ${error}`)
                // Continue without the picture URL
              }

              Logger.info(
                `Inserting message into Vespa: ${JSON.stringify(whatsappMessage, null, 2)}`,
              )
              const messageId = msg.key.id!
              const success = await insertAndVerify(
                messageId,
                chatMessageSchema,
                () =>
                  insertWhatsAppMessage(
                    data.email,
                    whatsappMessage,
                    conversationId,
                    phoneNumber,
                    [data.email],
                    pictureUrl,
                  ),
              )

              if (success) {
                Logger.info(`Message successfully pushed to Vesp ${messageId}`)
                // Update tracker
                tracker.updateUserStats(
                  data.email,
                  StatType.WhatsApp_Message,
                  1,
                )

                // Log tracker stats to verify they're being updated
                const beforeStats =
                  tracker.getOAuthProgress().userStats[data.email]
                Logger.info(
                  `WhatsApp message stats AFTER update: ${JSON.stringify(beforeStats)}`,
                )

                // Send immediate WebSocket update to reflect the new message count
                const progress = tracker.getProgress()
                const userStats = tracker.getOAuthProgress().userStats
                Logger.info(
                  `Sending immediate update after message insertion - Stats: ${JSON.stringify(userStats)}`,
                )
                sendWebsocketMessage(
                  JSON.stringify({
                    progress,
                    userStats,
                  }),
                  connector.externalId,
                )
              } else {
                Logger.error(`Failed to push message ${messageId} to Vespa`)
              }
            }
          }
        }
      } catch (error) {
        Logger.error(error, "Error processing new message")
      }
    })

    // Handle contacts
    sock.ev.on("contacts.update", async (contacts) => {
      Logger.info(`Contacts updated: ${JSON.stringify(contacts, null, 2)}`)

      try {
        for (const contact of contacts) {
          if (contact.id && (contact.name || contact.notify)) {
            const phoneNumber = contact.id.split("@")[0]

            const whatsappContact: WhatsAppContact = {
              id: contact.id,
              name: contact.name || contact.notify || phoneNumber,
              phoneNumber,
            }

            Logger.info(
              `Inserting contact into Vespa: ${JSON.stringify(whatsappContact, null, 2)}`,
            )
            const success = await insertAndVerify(
              contact.id,
              whatsappContactSchema,
              () =>
                insertWhatsAppContact(data.email, whatsappContact, [
                  data.email,
                ]),
            )

            if (success) {
              Logger.info(
                `Contact successfully pushed to Vespa ${contact.name}`,
              )
              // Update tracker
              tracker.updateUserStats(data.email, StatType.WhatsApp_Contact, 1)

              // Send immediate WebSocket update to reflect the new contact count
              const progress = tracker.getProgress()
              const userStats = tracker.getOAuthProgress().userStats
              Logger.info(
                `Sending immediate update after contact insertion - Stats: ${JSON.stringify(userStats)}`,
              )
              sendWebsocketMessage(
                JSON.stringify({
                  progress,
                  userStats,
                }),
                connector.externalId,
              )
            } else {
              Logger.error(`Failed to push contact ${contact.id} to Vespa`)
            }
          }
        }
      } catch (error) {
        Logger.error(error, "Error processing contacts update")
      }
    })

    // Handle chats
    sock.ev.on("chats.upsert", async (chats) => {
      Logger.info(`Chats updated: ${JSON.stringify(chats, null, 2)}`)

      try {
        for (const chat of chats) {
          if (chat.id) {
            const phoneNumber = chat.id.split("@")[0]

            const whatsappConversation: WhatsAppConversation = {
              id: chat.id,
              contactId: phoneNumber,
              lastMessageTimestamp:
                typeof chat.conversationTimestamp === "number"
                  ? chat.conversationTimestamp
                  : parseInt(String(chat.conversationTimestamp), 10),
            }

            Logger.info(
              `Inserting conversation into Vespa: ${JSON.stringify(whatsappConversation, null, 2)}`,
            )
            const success = await insertAndVerify(
              chat.id,
              chatContainerSchema,
              () =>
                insertWhatsAppConversation(
                  data.email,
                  whatsappConversation,
                  phoneNumber,
                  [data.email],
                ),
            )

            if (success) {
              Logger.info(
                `Conversation successfully pushed to Vespa ${chat.name}`,
              )
              // Update tracker
              tracker.updateUserStats(
                data.email,
                StatType.WhatsApp_Conversation,
                1,
              )

              // Send immediate WebSocket update to reflect the new conversation count
              const progress = tracker.getProgress()
              const userStats = tracker.getOAuthProgress().userStats
              Logger.info(
                `Sending immediate update after conversation insertion - Stats: ${JSON.stringify(userStats)}`,
              )
              sendWebsocketMessage(
                JSON.stringify({
                  progress,
                  userStats,
                }),
                connector.externalId,
              )
            } else {
              Logger.error(`Failed to push conversation ${chat.id} to Vespa`)
            }
          }
        }
      } catch (error) {
        Logger.error(error, "Error processing chats update")
      }
    })
  } catch (error) {
    Logger.error(error, "Error in WhatsApp ingestion")
    // Clean up on error
    if (sock) {
      try {
        await sock.end(undefined)
      } catch (cleanupError) {
        Logger.error(cleanupError, "Error during socket cleanup")
      }
    }
    throw error
  }
}

const startIngestion = async (
  sock: WASocket,
  email: string,
  connectorId: string,
  tracker: Tracker,
) => {
  try {
    Logger.info(`Starting WhatsApp data ingestion for ${email}`)

    // Set up progress tracking interval
    const interval = setInterval(() => {
      const progress = tracker.getProgress()
      const userStats = tracker.getOAuthProgress().userStats
      Logger.info(
        `Sending progress update - Progress: ${progress}%, Stats: ${JSON.stringify(userStats)}`,
      )
      sendWebsocketMessage(
        JSON.stringify({
          progress,
          userStats,
        }),
        connectorId,
      )
    }, 4000)

    // Get and insert conversations
    Logger.info("Fetching WhatsApp conversations")
    const conversations = await getConversations(sock)
    Logger.info(`Found ${conversations.length} conversations`)

    // Insert conversations into Vespa
    for (const conversation of conversations) {
      const phoneNumber = conversation.contactId
      Logger.info(
        `Inserting conversation into Vespa: ${JSON.stringify(conversation, null, 2)}`,
      )
      const success = await insertAndVerify(
        conversation.id,
        chatContainerSchema,
        () =>
          insertWhatsAppConversation(email, conversation, phoneNumber, [email]),
      )

      if (success) {
        Logger.info(
          `Conversation successfully pushed to Vespa ${conversation.id}`,
        )
        // Update tracker
        tracker.updateUserStats(email, StatType.WhatsApp_Conversation, 1)
      } else {
        Logger.error(`Failed to push conversation ${conversation.id} to Vespa`)
      }
    }

    // Fetch and insert groups
    Logger.info("Fetching WhatsApp groups")
    try {
      const groupsData = await sock.groupFetchAllParticipating()

      Logger.info(`Retrieved groups data: ${Object.keys(groupsData).length}`)

      const groups = Object.values(groupsData).map((group: any) => ({
        id: group.id,
        subject: group.subject,
        creation: parseInt(String(group.creation), 10),
        owner: group.owner,
        desc: group.desc,
        participants: group.participants.map((p: any) => ({
          id: p.id,
          admin: p.admin,
          isSuperAdmin: p.isSuperAdmin,
        })),
      }))

      Logger.info(`Found ${groups.length} groups`)

      // Insert groups into Vespa
      for (const group of groups) {
        Logger.info(
          `Inserting group into Vespa: ${JSON.stringify(group, null, 2)}`,
        )
        const success = await insertAndVerify(
          group.id,
          chatContainerSchema,
          () => insertWhatsAppGroup(email, group as WhatsAppGroup, [email]),
        )

        if (success) {
          Logger.info(`Group successfully pushed to Vespa ${group.subject}`)
          // Update stats
          tracker.updateUserStats(email, StatType.WhatsApp_Group, 1)

          // Send immediate WebSocket update to reflect the new group
          const progress = tracker.getProgress()
          const userStats = tracker.getOAuthProgress().userStats
          Logger.info(
            `Sending immediate update after group insertion - Stats: ${JSON.stringify(userStats)}`,
          )
          sendWebsocketMessage(
            JSON.stringify({
              progress,
              userStats,
            }),
            connectorId,
          )
        } else {
          Logger.error(`Failed to push group ${group.id} to Vespa`)
        }
      }

      // Update stats
      tracker.updateUserStats(email, StatType.WhatsApp_Group, groups.length)
    } catch (error) {
      Logger.error(error, "Error fetching and inserting groups")
    }

    // Update progress based on connection status
    if (conversations.length === 0) {
      Logger.info("No conversations found, but connection is successful")
      // Update stats to show we're connected but no data yet
      tracker.updateUserStats(email, StatType.WhatsApp_Conversation, 0)
      tracker.updateUserStats(email, StatType.WhatsApp_Message, 0)
      tracker.updateUserStats(email, StatType.WhatsApp_Group, 0)
    }

    // Mark ingestion as complete since we've established connection
    tracker.markUserComplete(email)
    Logger.info("WhatsApp data ingestion completed")

    // Send final update
    sendWebsocketMessage(
      JSON.stringify({
        progress: 100,
        userStats: tracker.getOAuthProgress().userStats,
      }),
      connectorId,
    )

    // Clear interval after completion
    setTimeout(() => {
      clearInterval(interval)
    }, 8000)
  } catch (error) {
    Logger.error(error, "Error in WhatsApp ingestion process")
    throw error
  }
}
