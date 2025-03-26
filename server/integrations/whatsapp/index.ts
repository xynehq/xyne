import { getOAuthConnectorWithCredentials } from "@/db/connector"
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
  job: PgBoss.Job<any>,
) => {
  try {
    const data: SaaSOAuthJob = job.data as SaaSOAuthJob
    const connector: SelectConnector = await getOAuthConnectorWithCredentials(
      db,
      data.connectorId,
    )

    const tracker = new Tracker(Apps.WhatsApp)
    const authStatePath = `auth_info_${data.email}`
    const { state, saveCreds } = await useMultiFileAuthState(authStatePath)
    
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      qrTimeout: 60000,
      connectTimeoutMs: 60000,
      retryRequestDelayMs: 250,
    })

    // Handle QR code generation
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        const qrCode = await generateQR(qr)
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
        const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut
        if (shouldReconnect) {
          handleWhatsAppIngestion(job)
        }
      } else if (connection === 'open') {
        saveCreds()
        // Start ingestion after successful connection
        await startIngestion(sock, data.email, connector.externalId, tracker)
      }
    })

    // Handle store updates
    store.bind(sock.ev)

  } catch (error) {
    Logger.error(error, "Error in WhatsApp ingestion")
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
    // Set up progress tracking interval
    const interval = setInterval(() => {
      sendWebsocketMessage(
        JSON.stringify({
          progress: tracker.getProgress(),
          userStats: tracker.getOAuthProgress().userStats,
        }),
        connectorId,
      )
    }, 4000)

    // Get and insert contacts
    const contacts = await getContacts(sock)
    for (const contact of contacts) {
      await insertWhatsAppContact(email, contact, [email])
      tracker.updateUserStats(email, StatType.WhatsApp_Contact, 1)
    }

    // Get and insert conversations
    const conversations = await getConversations(sock)
    for (const conversation of conversations) {
      await insertWhatsAppConversation(email, conversation, conversation.contactId, [email])
      tracker.updateUserStats(email, StatType.WhatsApp_Conversation, 1)

      // Get and insert messages for each conversation
      const messages = await getMessages(sock, conversation.id)
      for (const message of messages) {
        await insertWhatsAppMessage(email, message, conversation.id, conversation.contactId, [email])
        tracker.updateUserStats(email, StatType.WhatsApp_Message, 1)
      }
    }

    // Clear interval after completion
    setTimeout(() => {
      clearInterval(interval)
    }, 8000)

  } catch (error) {
    Logger.error(error, "Error in WhatsApp ingestion process")
    throw error
  }
} 