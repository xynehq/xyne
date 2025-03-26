import { getConnector } from "@/db/connector"
import type { SelectConnector } from "@/db/schema"
import {
  Apps,
  WhatsAppEntity,
  whatsappMessageSchema,
  whatsappContactSchema,
  whatsappConversationSchema,
  type VespaWhatsAppMessage,
  type VespaWhatsAppContact,
  type VespaWhatsAppConversation,
} from "@/search/types"
import { insert, NAMESPACE } from "@/search/vespa"
import { Subsystem, type SaaSOAuthJob } from "@/types"
import type PgBoss from "pg-boss"
import { db } from "@/db/client"
import { getLogger } from "@/logger"
import { StatType, Tracker } from "@/integrations/tracker"
import { sendWebsocketMessage } from "../metricStream"
import { default as makeWASocket, DisconnectReason, useMultiFileAuthState, makeInMemoryStore } from "@whiskeysockets/baileys"
import type { WASocket } from "@whiskeysockets/baileys"
import { Boom } from "@hapi/boom"
import { proto } from "@whiskeysockets/baileys"
import { generateQR } from "@/integrations/whatsapp/qr"
import * as fs from 'fs'
import * as path from 'path'
import { eq } from "drizzle-orm"
import { connectors } from "@/db/schema"
import { ConnectorStatus } from "@/shared/types"

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

interface WhatsAppStore {
  contacts: {
    all: () => Promise<Record<string, { name?: string }>>
  }
  chats: {
    all: () => Promise<Record<string, { conversationTimestamp?: number; messages?: Record<string, { key: proto.IMessageKey; message: proto.IMessage; messageTimestamp: number }> }>>
    get: (id: string) => Promise<{ messages?: Record<string, { key: proto.IMessageKey; message: proto.IMessage; messageTimestamp: number }> } | undefined>
  }
}

const store = makeInMemoryStore({})
store.readFromFile = () => {}
store.writeToFile = () => {}

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

export const getConversations = async (sock: WASocket): Promise<WhatsAppConversation[]> => {
  const conversations: WhatsAppConversation[] = []
  const chats = await (sock as unknown as { store: WhatsAppStore }).store.chats.all()
  
  for (const [id, chat] of Object.entries(chats)) {
    if (chat.conversationTimestamp) {
      conversations.push({
        id,
        contactId: id.split('@')[0],
        lastMessageTimestamp: chat.conversationTimestamp
      })
    }
  }
  
  return conversations
}

export const getMessages = async (sock: WASocket, conversationId: string): Promise<WhatsAppMessage[]> => {
  const messages: WhatsAppMessage[] = []
  const chat = await (sock as unknown as { store: WhatsAppStore }).store.chats.get(conversationId)
  
  if (chat?.messages) {
    for (const [id, message] of Object.entries(chat.messages)) {
      messages.push({
        key: message.key,
        message: message.message,
        timestamp: message.messageTimestamp
      })
    }
  }
  
  return messages
}

const insertWhatsAppMessage = async (
  email: string,
  message: WhatsAppMessage,
  conversationId: string,
  phoneNumber: string,
  permissions: string[],
) => {
  if (!permissions.length || permissions.indexOf(email) === -1) {
    permissions = permissions.concat(email)
  }

  const messageText = message.message?.conversation || 
                     message.message?.extendedTextMessage?.text || 
                     ''

  return insert(
    {
      docId: message.key.id!,
      phoneNumber,
      text: messageText,
      timestamp: message.timestamp,
      conversationId,
      app: Apps.WhatsApp,
      entity: WhatsAppEntity.Message,
      permissions,
    } as VespaWhatsAppMessage,
    whatsappMessageSchema,
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

  return insert(
    {
      docId: conversation.id,
      phoneNumber,
      contactId: conversation.contactId,
      lastMessageTimestamp: conversation.lastMessageTimestamp,
      app: Apps.WhatsApp,
      entity: WhatsAppEntity.Conversation,
      permissions,
    } as VespaWhatsAppConversation,
    whatsappConversationSchema,
  )
}

export const handleWhatsAppIngestion = async (
  boss: PgBoss,
  job: PgBoss.Job<any>,
) => {
  let sock: WASocket | undefined;
  try {
    Logger.info(`Starting WhatsApp ingestion for job ${job.id}`)
    const data: SaaSOAuthJob = job.data as SaaSOAuthJob
    Logger.info(`Job data: ${JSON.stringify(data, null, 2)}`)
    
    // Clear any existing WhatsApp jobs for this connector
    Logger.info(`Clearing existing WhatsApp jobs`)
    try {
      await boss.purgeQueue('ingestion-SaaS')
      Logger.info('Successfully cleared existing WhatsApp jobs')
    } catch (error) {
      Logger.error(error, 'Error clearing existing WhatsApp jobs')
    }
    
    Logger.info(`Fetching connector with ID: ${data.connectorId}`)
    const connector: SelectConnector = await getConnector(
      db,
      data.connectorId,
    )
    Logger.info(`Found connector: ${JSON.stringify(connector, null, 2)}`)

    const tracker = new Tracker(Apps.WhatsApp)
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
      getMessage: async () => undefined
    })
    Logger.info("WhatsApp socket created")

    // Bind store to socket events before setting up other handlers
    Logger.info("Binding store to socket events")
    store.bind(sock.ev)

    let reconnectAttempts = 0;
    const MAX_RECONNECT_ATTEMPTS = 5;
    const RECONNECT_DELAY = 5000; // 5 seconds

    // Handle QR code generation
    sock.ev.on('connection.update', async (update) => {
      Logger.info(`Connection update received: ${JSON.stringify(update, null, 2)}`)
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

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut && 
                              statusCode !== DisconnectReason.connectionClosed &&
                              reconnectAttempts < MAX_RECONNECT_ATTEMPTS;
        
        Logger.info(`Connection closed. Status: ${statusCode}, Should reconnect: ${shouldReconnect}`)
        
        if (shouldReconnect) {
          reconnectAttempts++;
          Logger.info(`Attempting to reconnect (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`)
          await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY));
          // Restart the entire ingestion process
          Logger.info("Restarting WhatsApp ingestion process")
          await handleWhatsAppIngestion(boss, job)
        } else {
          Logger.error(`Connection terminated (Status: ${statusCode}). Cleaning up...`)
          fs.rmSync(authStatePath, { recursive: true, force: true })
        }
      } else if (connection === 'connecting') {
        Logger.info("Connecting to WhatsApp...")
      } else if (connection === 'open') {
        Logger.info("Connection opened successfully")
        reconnectAttempts = 0; // Reset reconnect attempts on successful connection
        Logger.info("Saving credentials...")
        await saveCreds()
        Logger.info("Credentials saved")
        
        // Update connector status to Connected
        Logger.info("Updating connector status to Connected")
        await db.update(connectors)
          .set({ status: ConnectorStatus.Connected })
          .where(eq(connectors.id, connector.id))
        Logger.info("Connector status updated successfully")
        
        // Start ingestion after successful connection
        Logger.info("Starting WhatsApp data ingestion")
        await startIngestion(sock!, data.email, connector.externalId, tracker)
      }
    })

    // Handle credentials update
    sock.ev.on('creds.update', async () => {
      Logger.info("Credentials updated, saving...")
      await saveCreds()
      Logger.info("Credentials saved successfully")
    })

    // Handle messages
    sock.ev.on('messages.upsert', async (m) => {
      Logger.info(`New message received: ${JSON.stringify(m, null, 2)}`)
    })

    // Handle contacts
    sock.ev.on('contacts.update', async (contacts) => {
      Logger.info(`Contacts updated: ${JSON.stringify(contacts, null, 2)}`)
    })

    // Handle chats
    sock.ev.on('chats.upsert', async (chats) => {
      Logger.info(`Chats updated: ${JSON.stringify(chats, null, 2)}`)
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
      Logger.info(`Sending progress update - Progress: ${progress}%, Stats: ${JSON.stringify(userStats)}`)
      sendWebsocketMessage(
        JSON.stringify({
          progress,
          userStats,
        }),
        connectorId,
      )
    }, 4000)

    // Get and insert contacts
    Logger.info("Fetching WhatsApp contacts")
    const contacts = await getContacts(sock)
    Logger.info(`Found ${contacts.length} contacts`)
    for (const contact of contacts) {
      await insertWhatsAppContact(email, contact, [email])
      tracker.updateUserStats(email, StatType.WhatsApp_Contact, 1)
      // Send immediate update after each contact
      sendWebsocketMessage(
        JSON.stringify({
          progress: tracker.getProgress(),
          userStats: tracker.getOAuthProgress().userStats,
        }),
        connectorId,
      )
    }

    // Get and insert conversations
    Logger.info("Fetching WhatsApp conversations")
    const conversations = await getConversations(sock)
    Logger.info(`Found ${conversations.length} conversations`)
    for (const conversation of conversations) {
      await insertWhatsAppConversation(email, conversation, conversation.contactId, [email])
      tracker.updateUserStats(email, StatType.WhatsApp_Conversation, 1)
      // Send immediate update after each conversation
      sendWebsocketMessage(
        JSON.stringify({
          progress: tracker.getProgress(),
          userStats: tracker.getOAuthProgress().userStats,
        }),
        connectorId,
      )

      // Get and insert messages for each conversation
      Logger.info(`Fetching messages for conversation ${conversation.id}`)
      const messages = await getMessages(sock, conversation.id)
      Logger.info(`Found ${messages.length} messages`)
      for (const message of messages) {
        await insertWhatsAppMessage(email, message, conversation.id, conversation.contactId, [email])
        tracker.updateUserStats(email, StatType.WhatsApp_Message, 1)
        // Send immediate update after each message
        sendWebsocketMessage(
          JSON.stringify({
            progress: tracker.getProgress(),
            userStats: tracker.getOAuthProgress().userStats,
          }),
          connectorId,
        )
      }
    }

    // Mark ingestion as complete
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