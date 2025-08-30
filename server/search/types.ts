import { z } from "zod"
export const fileSchema = "file" // Replace with your actual schema name
export const userSchema = "user"

// calendar
export const eventSchema = "event"

// mail
export const mailAttachmentSchema = "mail_attachment"
export const mailSchema = "mail"

// chat
export const chatContainerSchema = "chat_container"
// this is not meant to be searched but we will
// store the data in vespa and fetch it as needed
export const chatTeamSchema = "chat_team"
export const chatMessageSchema = "chat_message"
export const chatUserSchema = "chat_user"
export const chatAttachment = "chat_attachment"
// Previous queries
export const userQuerySchema = "user_query"
export const datasourceSchema = "datasource"
export const dataSourceFileSchema = "datasource_file"
// Knowledge Base feature schemas - contains collections with folders and files
export const KbItemsSchema = "kb_items" // Collection items (folders and files)

export type VespaSchema =
  | typeof fileSchema
  | typeof userSchema
  | typeof mailSchema
  | typeof eventSchema
  | typeof userQuerySchema
  | typeof mailAttachmentSchema
  | typeof chatContainerSchema
  | typeof chatTeamSchema
  | typeof chatMessageSchema
  | typeof chatUserSchema
  | typeof chatAttachment
  | typeof datasourceSchema
  | typeof dataSourceFileSchema
  | typeof KbItemsSchema

// not using @ because of vite of frontend
export enum Apps {
  // includes everything google
  GoogleWorkspace = "google-workspace",
  // more granular
  GoogleDrive = "google-drive",

  Gmail = "gmail",

  // Notion = "notion",  // Notion is not yet supported
  GoogleCalendar = "google-calendar",

  // Microsoft apps (mirroring Google structure)
  MicrosoftDrive = "microsoft-drive",
  MicrosoftOutlook = "microsoft-outlook",
  MicrosoftCalendar = "microsoft-calendar",

  Slack = "slack",

  MCP = "mcp",
  Github = "github",
  Xyne = "xyne",
  DataSource = "data-source",
  KnowledgeBase = "KnowledgeBase",
}

export const isValidApp = (app: string): boolean => {
  return app
    ? Object.values(Apps)
        .map((v) => v.toLowerCase())
        .includes(app.toLowerCase() as Apps)
    : false
}

export const isValidEntity = (entity: string): boolean => {
  const normalizedEntity = entity?.toLowerCase()
  return normalizedEntity
    ? Object.values(DriveEntity)
        .map((v) => v.toLowerCase())
        .includes(normalizedEntity) ||
        Object.values(MailEntity)
          .map((v) => v.toLowerCase())
          .includes(normalizedEntity) ||
        Object.values(CalendarEntity)
          .map((v) => v.toLowerCase())
          .includes(normalizedEntity) ||
        Object.values(MailAttachmentEntity)
          .map((v) => v.toLowerCase())
          .includes(normalizedEntity) ||
        Object.values(GooglePeopleEntity)
          .map((v) => v.toLowerCase())
          .includes(normalizedEntity) ||
        Object.values(MicrosoftPeopleEntity)
          .map((v) => v.toLowerCase())
          .includes(normalizedEntity) ||
        Object.values(SlackEntity)
          .map((v) => v.toLowerCase())
          .includes(normalizedEntity)
    : // Object.values(NotionEntity).map(v => v.toLowerCase()).includes(normalizedEntity)
      false
}

export enum GooglePeopleEntity {
  Contacts = "Contacts",
  OtherContacts = "OtherContacts",
  AdminDirectory = "AdminDirectory",
}

// Microsoft entities (mirroring Google structure)
export enum MicrosoftPeopleEntity {
  Contacts = "Contacts",
  OtherContacts = "OtherContacts",
}

// the vespa schemas
const Schemas = z.union([
  z.literal(fileSchema),
  z.literal(userSchema),
  z.literal(mailSchema),
  z.literal(eventSchema),
  z.literal(userQuerySchema),
  z.literal(mailAttachmentSchema),
  z.literal(chatContainerSchema),
  z.literal(chatTeamSchema),
  z.literal(chatUserSchema),
  z.literal(chatMessageSchema),
  z.literal(datasourceSchema),
  z.literal(dataSourceFileSchema),
  z.literal(KbItemsSchema),
])

export enum MailEntity {
  Email = "mail",
}

export enum CalendarEntity {
  Event = "event",
}

export enum SlackEntity {
  Team = "team",
  User = "user",
  Message = "message",
  Channel = "channel",
  File = "file",
}

export enum DriveEntity {
  Docs = "docs",
  Sheets = "sheets",
  Slides = "slides",
  Presentation = "presentation",
  PDF = "pdf",
  Folder = "folder",
  Misc = "driveFile",
  Drawing = "drawing",
  Form = "form",
  Script = "script",
  Site = "site",
  Map = "map",
  Audio = "audio",
  Video = "video",
  Photo = "photo",
  ThirdPartyApp = "third_party_app",
  Image = "image",
  Zip = "zip",
  WordDocument = "word_document",
  ExcelSpreadsheet = "excel_spreadsheet",
  PowerPointPresentation = "powerpoint_presentation",
  Text = "text",
  CSV = "csv",
}

export enum MailAttachmentEntity {
  PDF = "pdf",
  Sheets = "sheets",
  CSV = "csv",
  WordDocument = "worddocument",
  PowerPointPresentation = "powerpointpresentation",
  Text = "text",
  NotValid = "notvalid",
}
export enum KnowledgeBaseEntity {
  File = "file", // Files within collections
  Folder = "folder", // Folders within collections
  Collection = "collection", // Collections (main containers)
  KnowledgeBase = "knowledgebase", // Legacy alias for collection
}

export const isMailAttachment = (entity: Entity): boolean =>
  Object.values(MailAttachmentEntity).includes(entity as MailAttachmentEntity)

export const PeopleEntitySchema = z.nativeEnum(GooglePeopleEntity)
export const MicrosoftPeopleEntitySchema = z.nativeEnum(MicrosoftPeopleEntity)
export const ChatEntitySchema = z.nativeEnum(SlackEntity)

export type PeopleEntity = z.infer<typeof PeopleEntitySchema>
export type MicrosoftPeopleEntityType = z.infer<
  typeof MicrosoftPeopleEntitySchema
>

export enum NotionEntity {
  Page = "page",
  Database = "database",
}

export const FileEntitySchema = z.nativeEnum(DriveEntity)
export const MailEntitySchema = z.nativeEnum(MailEntity)
export const MailAttachmentEntitySchema = z.nativeEnum(MailAttachmentEntity)
export const EventEntitySchema = z.nativeEnum(CalendarEntity)

const NotionEntitySchema = z.nativeEnum(NotionEntity)

export enum SystemEntity {
  SystemInfo = "system_info",
  UserProfile = "user_profile",
}
export enum DataSourceEntity {
  DataSourceFile = "data_source_file",
}
export const SystemEntitySchema = z.nativeEnum(SystemEntity)
export const DataSourceEntitySchema = z.nativeEnum(DataSourceEntity)
export const entitySchema = z.union([
  SystemEntitySchema,
  PeopleEntitySchema,
  MicrosoftPeopleEntitySchema,
  FileEntitySchema,
  NotionEntitySchema,
  MailEntitySchema,
  EventEntitySchema,
  MailAttachmentEntitySchema,
  ChatEntitySchema,
  DataSourceEntitySchema,
])

export type Entity =
  | SystemEntity
  | PeopleEntity
  | MicrosoftPeopleEntityType
  | DriveEntity
  | NotionEntity
  | MailEntity
  | CalendarEntity
  | MailAttachmentEntity
  | SlackEntity
  | DataSourceEntity

export type WorkspaceEntity = DriveEntity

export const scoredChunk = z.object({
  chunk: z.string(),
  score: z.number(),
  index: z.number(),
})
export type ScoredChunk = z.infer<typeof scoredChunk>

export const defaultVespaFieldsSchema = z.object({
  relevance: z.number(),
  source: z.string(),
  // sddocname: Schemas,
  documentid: z.string(),
})

const SpreadsheetMetadata = z.object({
  spreadsheetId: z.string(),
  totalSheets: z.number(),
})

const Metadata = z.union([z.object({}), SpreadsheetMetadata])

export const VespaFileSchema = z.object({
  docId: z.string(),
  app: z.nativeEnum(Apps),
  entity: FileEntitySchema,
  title: z.string(),
  url: z.string().nullable(),
  parentId: z.string().nullable(),
  chunks: z.array(z.string()),
  owner: z.string().nullable(),
  ownerEmail: z.string().nullable(),
  photoLink: z.string().nullable(),
  permissions: z.array(z.string()),
  mimeType: z.string().nullable(),
  metadata: Metadata,
  createdAt: z.number(),
  updatedAt: z.number(),
})

const chunkScoresSchema = z.object({
  cells: z.record(z.number()),
})
// Match features for file schema
const FileMatchFeaturesSchema = z.object({
  "bm25(title)": z.number().optional(),
  "bm25(chunks)": z.number().optional(),
  "closeness(field, chunk_embeddings)": z.number().optional(),
  chunk_scores: chunkScoresSchema,
})

// Match features for user schema
const UserMatchFeaturesSchema = z.object({
  "bm25(name)": z.number().optional(),
  "bm25(email)": z.number().optional(),
})

// Match features for mail schema
const MailMatchFeaturesSchema = z.object({
  "bm25(subject)": z.number().optional(),
  "bm25(chunks)": z.number().optional(),
  "bm25(attachmentFilenames)": z.number().optional(),
  chunk_scores: chunkScoresSchema,
})

const EventMatchFeaturesSchema = z.object({
  "bm25(name)": z.number().optional(),
  "bm25(description)": z.number().optional(),
  "bm25(attachmentFilenames)": z.number().optional(),
  "bm25(attendeesNames)": z.number().optional(),
})

const MailAttachmentMatchFeaturesSchema = z.object({
  chunk_vector_score: z.number().optional(),
  scaled_bm25_chunks: z.number().optional(),
  scaled_bm25_filename: z.number().optional(),
  chunk_scores: chunkScoresSchema,
})

const ChatMessageMatchFeaturesSchema = z.object({
  vector_score: z.number().optional(),
  combined_nativeRank: z.number().optional(),
  "nativeRank(text)": z.number().optional(),
  "nativeRank(username)": z.number().optional(),
  "nativeRank(name)": z.number().optional(),
})

export type FileMatchFeatures = z.infer<typeof FileMatchFeaturesSchema>
export type MailMatchFeatures = z.infer<typeof MailMatchFeaturesSchema>
export type MailAttachmentMatchFeatures = z.infer<
  typeof MailAttachmentMatchFeaturesSchema
>

const DataSourceFileMatchFeaturesSchema = z.object({
  "bm25(fileName)": z.number().optional(),
  "bm25(chunks)": z.number().optional(),
  "closeness(field, chunk_embeddings)": z.number().optional(),
  chunk_scores: chunkScoresSchema.optional(),
})
export type DataSourceFileMatchFeatures = z.infer<
  typeof DataSourceFileMatchFeaturesSchema
>

export const VespaMatchFeatureSchema = z.union([
  FileMatchFeaturesSchema,
  MailMatchFeaturesSchema,
  MailAttachmentMatchFeaturesSchema,
  DataSourceFileMatchFeaturesSchema,
])

// Base schema for DataSource (for insertion)
export const VespaDataSourceSchemaBase = z.object({
  docId: z.string(),
  name: z.string(),
  createdBy: z.string(),
  createdAt: z.number(), // long
  updatedAt: z.number(), // long
})
export type VespaDataSource = z.infer<typeof VespaDataSourceSchemaBase>

// Search schema for DataSource
export const VespaDataSourceSearchSchema = VespaDataSourceSchemaBase.extend({
  sddocname: z.literal(datasourceSchema),
  matchfeatures: z.any().optional(),
  rankfeatures: z.any().optional(),
}).merge(defaultVespaFieldsSchema)
export type VespaDataSourceSearch = z.infer<typeof VespaDataSourceSearchSchema>

// Base schema for DataSourceFile (for insertion)
export const VespaDataSourceFileSchemaBase = z.object({
  docId: z.string(),
  description: z.string().optional(),
  app: z.literal(Apps.DataSource),
  fileName: z.string().optional(),
  fileSize: z.number().optional(), // long
  chunks: z.array(z.string()),
  image_chunks: z.array(z.string()).optional(), // Added for image descriptions
  chunks_pos: z.array(z.number()).optional(), // Added for text chunk positions
  image_chunks_pos: z.array(z.number()).optional(), // Added for image chunk positions
  uploadedBy: z.string(),
  duration: z.number().optional(), // long
  mimeType: z.string().optional(),
  createdAt: z.number(), // long
  updatedAt: z.number(), // long
  dataSourceRef: z.string(), // reference to datasource docId
  metadata: z.string().optional(), // JSON string
})
export type VespaDataSourceFile = z.infer<typeof VespaDataSourceFileSchemaBase>

// Search schema for DataSourceFile
export const VespaDataSourceFileSearchSchema =
  VespaDataSourceFileSchemaBase.extend({
    sddocname: z.literal(dataSourceFileSchema),
    matchfeatures: DataSourceFileMatchFeaturesSchema,
    rankfeatures: z.any().optional(),
    dataSourceName: z.string().optional(),
  })
    .merge(defaultVespaFieldsSchema)
    .extend({
      chunks_summary: z.array(z.union([z.string(), scoredChunk])).optional(),
      image_chunks_summary: z
        .array(z.union([z.string(), scoredChunk]))
        .optional(),
      chunks_pos_summary: z.array(z.number()).optional(),
      image_chunks_pos_summary: z.array(z.number()).optional(),
    })
export type VespaDataSourceFileSearch = z.infer<
  typeof VespaDataSourceFileSearchSchema
>

// Base schema for KbFile (for insertion)
export const VespaKbFileSchemaBase = z.object({
  docId: z.string(),
  clId: z.string(),
  itemId: z.string(),
  app: z.literal(Apps.KnowledgeBase),
  entity: z.nativeEnum(KnowledgeBaseEntity),
  fileName: z.string(),
  description: z.string(),
  storagePath: z.string(),
  chunks: z.array(z.string()),
  image_chunks: z.array(z.string()),
  chunks_pos: z.array(z.number()),
  image_chunks_pos: z.array(z.number()),
  metadata: z.string(),
  createdBy: z.string(),
  duration: z.number(),
  mimeType: z.string(),
  fileSize: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export type VespaKbFile = z.infer<typeof VespaKbFileSchemaBase>

// KB File Match Features
const KbFileMatchFeaturesSchema = z.object({
  "bm25(fileName)": z.number().optional(),
  "bm25(chunks)": z.number().optional(),
  "closeness(field, chunk_embeddings)": z.number().optional(),
  chunk_scores: chunkScoresSchema.optional(),
})
export type KbFileMatchFeatures = z.infer<typeof KbFileMatchFeaturesSchema>

// Search schema for KbFile
export const VespaKbFileSearchSchema = VespaKbFileSchemaBase.extend({
  sddocname: z.literal(KbItemsSchema),
  matchfeatures: KbFileMatchFeaturesSchema,
  rankfeatures: z.any().optional(),
})
  .merge(defaultVespaFieldsSchema)
  .extend({
    chunks_summary: z.array(z.union([z.string(), scoredChunk])).optional(),
    chunks_pos_summary: z.array(z.number()).optional(),
  })
export type VespaKbFileSearch = z.infer<typeof VespaKbFileSearchSchema>

// Get schema for KbFile
export const VespaKbFileGetSchema = VespaKbFileSchemaBase.merge(
  defaultVespaFieldsSchema,
)
export type VespaKbFileGet = z.infer<typeof VespaKbFileGetSchema>

export const VespaFileSearchSchema = VespaFileSchema.extend({
  sddocname: z.literal(fileSchema),
  matchfeatures: FileMatchFeaturesSchema,
  rankfeatures: z.any().optional(),
})
  .merge(defaultVespaFieldsSchema)
  .extend({
    chunks_summary: z.array(z.union([z.string(), scoredChunk])).optional(),
  })

// basically GetDocument doesn't return sddocname
// in search it's always present
export const VespaFileGetSchema = VespaFileSchema.merge(
  defaultVespaFieldsSchema,
)

export const VespaUserSchema = z
  .object({
    docId: z.string().min(1),
    name: z.string().optional(), //.min(1),
    email: z.string().min(1).email(),
    app: z.nativeEnum(Apps),
    entity: z.union([
      z.nativeEnum(GooglePeopleEntity),
      z.nativeEnum(MicrosoftPeopleEntity),
    ]),
    gender: z.string().optional(),
    photoLink: z.string().optional(),
    aliases: z.array(z.string()).optional(),
    language: z.string().optional(),
    includeInGlobalAddressList: z.boolean().optional(),
    isAdmin: z.boolean().optional(),
    isDelegatedAdmin: z.boolean().optional(),
    suspended: z.boolean().optional(),
    archived: z.boolean().optional(),
    urls: z.array(z.string()).optional(),
    rankfeatures: z.any().optional(),
    orgName: z.string().optional(),
    orgJobTitle: z.string().optional(),
    orgDepartment: z.string().optional(),
    orgLocation: z.string().optional(),
    orgDescription: z.string().optional(),
    creationTime: z.number(),
    lastLoggedIn: z.number().optional(),
    birthday: z.number().optional(),
    occupations: z.array(z.string()).optional(),
    userDefined: z.array(z.string()).optional(),
    customerId: z.string().optional(),
    clientData: z.array(z.string()).optional(),
    // this only exists for contacts
    owner: z.string().optional(),
    sddocname: z.literal(userSchema),
  })
  .merge(defaultVespaFieldsSchema)

// Mail Types
export const AttachmentSchema = z.object({
  fileType: z.string(),
  fileSize: z.number(),
})

export const MailSchema = z.object({
  docId: z.string(),
  threadId: z.string(),
  mailId: z.string().optional(), // Optional for threads
  subject: z.string().default(""), // Default to empty string to avoid zod errors when subject is missing
  chunks: z.array(z.string()),
  timestamp: z.number(),
  app: z.nativeEnum(Apps),
  userMap: z.optional(z.record(z.string())),
  entity: z.nativeEnum(MailEntity),
  permissions: z.array(z.string()),
  from: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  bcc: z.array(z.string()),
  mimeType: z.string(),
  attachmentFilenames: z.array(z.string()),
  attachments: z.array(AttachmentSchema),
  labels: z.array(z.string()),
})

export const VespaMailSchema = MailSchema.extend({
  docId: z.string().min(1),
})

export const MailAttachmentSchema = z.object({
  docId: z.string(),
  mailId: z.string(),
  threadId: z.string(),
  partId: z.number().nullable().optional(),
  app: z.nativeEnum(Apps),
  entity: z.nativeEnum(MailAttachmentEntity),
  chunks: z.array(z.string()),
  timestamp: z.number(),
  permissions: z.array(z.string()),
  filename: z.string(),
  fileType: z.string().nullable().optional(),
  fileSize: z.number().nullable().optional(),
})

export const VespaMailAttachmentSchema = MailAttachmentSchema.extend({})

const EventUser = z.object({
  email: z.string(),
  displayName: z.string(),
})

const EventAtatchment = z.object({
  fileId: z.string(),
  title: z.string(),
  fileUrl: z.string(),
  mimeType: z.string(),
})

export const VespaEventSchema = z.object({
  docId: z.string(),
  name: z.string(),
  description: z.string(),
  url: z.string(),
  status: z.string(),
  location: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  app: z.nativeEnum(Apps),
  entity: z.nativeEnum(CalendarEntity),
  creator: EventUser,
  organizer: EventUser,
  attendees: z.array(EventUser),
  attendeesNames: z.array(z.string()),
  startTime: z.number(),
  endTime: z.number(),
  attachmentFilenames: z.array(z.string()),
  attachments: z.array(EventAtatchment),
  recurrence: z.array(z.string()),
  baseUrl: z.string(),
  joiningLink: z.string(),
  permissions: z.array(z.string()),
  cancelledInstances: z.array(z.string()),
  defaultStartTime: z.boolean(),
})

export const VespaMailSearchSchema = VespaMailSchema.extend({
  sddocname: z.literal("mail"),
  matchfeatures: MailMatchFeaturesSchema,
  rankfeatures: z.any().optional(),
})
  .merge(defaultVespaFieldsSchema)
  .extend({
    // attachment won't have this
    chunks_summary: z.array(z.union([z.string(), scoredChunk])).optional(),
  })

export const VespaMailAttachmentSearchSchema = VespaMailAttachmentSchema.extend(
  {
    sddocname: z.literal("mail_attachment"),
    matchfeatures: MailAttachmentMatchFeaturesSchema,
    rankfeatures: z.any().optional(),
  },
)
  .merge(defaultVespaFieldsSchema)
  .extend({
    chunks_summary: z.array(z.union([z.string(), scoredChunk])).optional(),
  })

export const VespaEventSearchSchema = VespaEventSchema.extend({
  sddocname: z.literal("event"),
  // Assuming events can have rankfeatures
  rankfeatures: z.any().optional(),
}).merge(defaultVespaFieldsSchema)

export const VespaUserQueryHistorySchema = z.object({
  docId: z.string(),
  query_text: z.string(),
  timestamp: z.number(),
  count: z.number(),
})

export const VespaUserQueryHGetSchema = VespaUserQueryHistorySchema.extend({
  sddocname: z.literal("user_query"),
}).merge(defaultVespaFieldsSchema)

export const VespaMailGetSchema = VespaMailSchema.merge(
  defaultVespaFieldsSchema,
)

export const VespaMailAttachmentGetSchema = VespaMailAttachmentSchema.merge(
  defaultVespaFieldsSchema,
)

export const VespaChatMessageSchema = z.object({
  docId: z.string(), // client_msg_id from Slack
  teamId: z.string(), // Slack team ID (e.g., "T05N1EJSE0K")
  channelId: z.string(), // Slack channel ID (e.g., "C123ABC456")
  text: z.string(),
  userId: z.string(), // Slack user ID (e.g., "U032QT45V53")
  app: z.nativeEnum(Apps), // App (e.g., "slack")
  entity: z.nativeEnum(SlackEntity), // Entity (e.g., "message")
  name: z.string(),
  username: z.string(),
  image: z.string(),
  channelName: z.string().optional(), // derived
  isIm: z.boolean().optional(), // derived
  isMpim: z.boolean().optional(), // derived
  isPrivate: z.boolean().optional(), // derived
  permissions: z.array(z.string()).optional(), // derived,
  teamName: z.string().optional(), // derived
  domain: z.string().optional(), // derived
  createdAt: z.number(), // Slack ts (e.g., 1734442791.514519)
  teamRef: z.string(), // vespa id for team
  threadId: z.string().default(""), // Slack thread_ts, null if not in thread
  attachmentIds: z.array(z.string()).default([]), // Slack file IDs (e.g., ["F0857N0FF4N"])
  // reactions: z.array(z.string()), // Commented out in Vespa schema, so excluded
  mentions: z.array(z.string()), // Extracted from text (e.g., ["U032QT45V53"])
  updatedAt: z.number(), // Slack edited.ts (e.g., 1734442538.0), null if not edited
  deletedAt: z.number(),
  metadata: z.string(), // JSON string for subtype, etc. (e.g., "{\"subtype\": null}")
})

export const VespaChatMessageSearchSchema = VespaChatMessageSchema.extend({
  sddocname: z.literal(chatMessageSchema),
  matchfeatures: ChatMessageMatchFeaturesSchema,
  rankfeatures: z.any().optional(),
})
  .merge(defaultVespaFieldsSchema)
  .extend({
    chunks_summary: z.array(z.string()).optional(),
  })

export const VespaChatMessageGetSchema = VespaChatMessageSchema.merge(
  defaultVespaFieldsSchema,
)

export const VespaChatUserSchema = z.object({
  docId: z.string(),
  name: z.string(),
  title: z.string(),
  app: z.nativeEnum(Apps),
  entity: z.nativeEnum(SlackEntity),
  image: z.string(),
  email: z.string(),
  statusText: z.string(),
  tz: z.string(),
  teamId: z.string(),
  deleted: z.boolean(),
  isAdmin: z.boolean(),
  updatedAt: z.number(),
})

export const VespaChatUserGetSchema = z.object({
  id: z.string(),
  pathId: z.string(),
  fields: VespaChatUserSchema,
})
export type ChatUserCore = z.infer<typeof VespaChatUserGetSchema>
export const VespaChatUserSearchSchema = VespaChatUserSchema.extend({
  sddocname: z.literal(chatUserSchema),
}).merge(defaultVespaFieldsSchema)

export const VespaChatContainerSchema = z.object({
  docId: z.string(),
  name: z.string(),
  channelName: z.string(),
  creator: z.string(),
  app: z.nativeEnum(Apps),
  entity: z.nativeEnum(SlackEntity),
  isPrivate: z.boolean(),
  isArchived: z.boolean(),
  isGeneral: z.boolean(),
  isIm: z.boolean(),
  isMpim: z.boolean(),
  domain: z.string().optional(), // derived
  permissions: z.array(z.string()),

  createdAt: z.number(),
  updatedAt: z.number(),
  lastSyncedAt: z.number(),

  topic: z.string(),
  description: z.string(),

  count: z.number().int(),
})

// Schema for search results that includes Vespa fields
export const VespaChatContainerSearchSchema = VespaChatContainerSchema.extend({
  sddocname: z.literal(chatContainerSchema),
}).merge(defaultVespaFieldsSchema)

export const ChatContainerMatchFeaturesSchema = z.object({
  "bm25(name)": z.number().optional(),
  "bm25(topic)": z.number().optional(),
  "bm25(description)": z.number().optional(),
  "closeness(field, chunk_embeddings)": z.number().optional(),
})

export const VespaChatTeamSchema = z.object({
  docId: z.string(),
  name: z.string(),
  app: z.nativeEnum(Apps),
  icon: z.string(),
  url: z.string(),
  domain: z.string(),
  email_domain: z.string(),
  own: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
  count: z.number().int(),
})

export const VespaChatTeamGetSchema = VespaChatTeamSchema.extend({
  sddocname: z.literal(chatTeamSchema),
}).merge(defaultVespaFieldsSchema)

export type VespaChatTeam = z.infer<typeof VespaChatTeamSchema>
export type VespaChatTeamGet = z.infer<typeof VespaChatTeamGetSchema>
export type VespaChatUserType = z.infer<typeof VespaChatUserSchema>
export const VespaSearchFieldsUnionSchema = z.discriminatedUnion("sddocname", [
  VespaUserSchema,
  VespaFileSearchSchema,
  VespaMailSearchSchema,
  VespaEventSearchSchema,
  VespaUserQueryHGetSchema,
  VespaMailAttachmentSearchSchema,
  VespaChatContainerSearchSchema,
  VespaChatUserSearchSchema,
  VespaChatMessageSearchSchema,
  VespaDataSourceSearchSchema,
  VespaDataSourceFileSearchSchema,
  VespaKbFileSearchSchema,
])

// Get schema for DataSourceFile
export const VespaDataSourceFileGetSchema = VespaDataSourceFileSchemaBase.merge(
  defaultVespaFieldsSchema,
)
export type VespaDataSourceFileGet = z.infer<
  typeof VespaDataSourceFileGetSchema
>

const SearchMatchFeaturesSchema = z.union([
  FileMatchFeaturesSchema,
  UserMatchFeaturesSchema,
  MailMatchFeaturesSchema,
  EventMatchFeaturesSchema,
  MailAttachmentMatchFeaturesSchema,
  ChatMessageMatchFeaturesSchema,
  DataSourceFileMatchFeaturesSchema,
  ChatContainerMatchFeaturesSchema,
  KbFileMatchFeaturesSchema,
])

const VespaSearchFieldsSchema = z
  .object({
    matchfeatures: SearchMatchFeaturesSchema,
    sddocname: Schemas,
  })
  .and(VespaSearchFieldsUnionSchema)

export const VespaGetFieldsSchema = z.union([
  VespaUserSchema,
  VespaFileGetSchema,
  VespaMailGetSchema,
  VespaDataSourceFileGetSchema,
  VespaKbFileGetSchema,
])

export const VespaSearchResultsSchema = z.object({
  id: z.string(),
  relevance: z.number(),
  fields: VespaSearchFieldsSchema,
  pathId: z.string().optional(),
})

export type VespaSearchResult = z.infer<typeof VespaSearchResultSchema>
export type VespaSearchResults = z.infer<typeof VespaSearchResultsSchema>

const VespaGetResultSchema = z.object({
  id: z.string(),
  relevance: z.number(),
  fields: VespaSearchFieldsSchema,
  pathId: z.string().optional(),
})

export type VespaGetResult = z.infer<typeof VespaGetResultSchema>

const VespaGroupSchema: z.ZodSchema<VespaGroupType> = z.object({
  id: z.string(),
  relevance: z.number(),
  label: z.string(),
  value: z.string().optional(),
  fields: z
    .object({
      "count()": z.number(),
    })
    .optional(),
  children: z.array(z.lazy(() => VespaGroupSchema)).optional(),
})

type VespaGroupType = {
  id: string
  relevance: number
  label: string
  value?: string
  fields?: {
    "count()": number
  }
  children?: VespaGroupType[] // Recursive type definition
}

const VespaErrorSchema = z.object({
  code: z.number(),
  summary: z.string(),
  source: z.string(),
  message: z.string(),
})

const VespaRootBaseSchema = z.object({
  root: z.object({
    id: z.string(),
    relevance: z.number(),
    fields: z
      .object({
        totalCount: z.number(),
      })
      .optional(),
    coverage: z.object({
      coverage: z.number(),
      documents: z.number(),
      full: z.boolean(),
      nodes: z.number(),
      results: z.number(),
      resultsFull: z.number(),
    }),
    errors: z.array(VespaErrorSchema).optional(),
  }),
  trace: z.any().optional(), // Add optional trace field to the root
})

const VespaSearchResultSchema = z.union([
  VespaSearchResultsSchema,
  VespaGroupSchema,
])

const VespaSearchResponseSchema = VespaRootBaseSchema.extend({
  root: VespaRootBaseSchema.shape.root.extend({
    children: z.array(VespaSearchResultSchema),
  }),
})

export type VespaSearchResponse = z.infer<typeof VespaSearchResponseSchema>

export type VespaFileGet = z.infer<typeof VespaFileGetSchema>
export type VespaFileSearch = z.infer<typeof VespaFileSearchSchema>
export type VespaMailSearch = z.infer<typeof VespaMailSearchSchema>
export type VespaMailAttachmentSearch = z.infer<
  typeof VespaMailAttachmentSearchSchema
>

export type VespaChatMessageSearch = z.infer<
  typeof VespaChatMessageSearchSchema
>
export type VespaEventSearch = z.infer<typeof VespaEventSearchSchema>
export type VespaFile = z.infer<typeof VespaFileSchema>
export type VespaUser = z.infer<typeof VespaUserSchema>
export type VespaUserQueryHistory = z.infer<typeof VespaUserQueryHistorySchema>

export type VespaFileWithDrivePermission = Omit<VespaFile, "permissions"> & {
  permissions: any[]
}

export type Inserts =
  | VespaUser
  | VespaFile
  | VespaMail
  | VespaEvent
  | VespaUserQueryHistory
  | VespaMailAttachment
  | VespaChatContainer
  | VespaChatTeam
  | VespaChatUser
  | VespaChatMessage
  | VespaDataSource
  | VespaDataSourceFile
  | VespaKbFile

const AutocompleteMatchFeaturesSchema = z.union([
  z.object({
    "bm25(title_fuzzy)": z.number(),
  }),
  z.object({
    "bm25(email_fuzzy)": z.number(),
    "bm25(name_fuzzy)": z.number(),
  }),
  z.object({
    "bm25(subject_fuzzy)": z.number(),
  }),
])

const VespaAutocompleteFileSchema = z
  .object({
    docId: z.string(),
    title: z.string(),
    app: z.nativeEnum(Apps),
    entity: entitySchema,
    sddocname: Schemas,
  })
  .merge(defaultVespaFieldsSchema)

const VespaAutocompleteUserSchema = z
  .object({
    docId: z.string(),
    // optional due to contacts
    name: z.string().optional(),
    email: z.string(),
    app: z.nativeEnum(Apps),
    entity: entitySchema,
    photoLink: z.string(),
    sddocname: Schemas,
  })
  .merge(defaultVespaFieldsSchema)

const VespaAutocompleteMailSchema = z
  .object({
    docId: z.string(),
    threadId: z.string(),
    subject: z.string().optional(),
    app: z.nativeEnum(Apps),
    entity: entitySchema,
    sddocname: Schemas,
  })
  .merge(defaultVespaFieldsSchema)

const VespaAutocompleteChatUserSchema = z
  .object({
    docId: z.string(),
    // optional due to contacts
    name: z.string().optional(),
    email: z.string(),
    app: z.nativeEnum(Apps),
    entity: entitySchema,
    image: z.string(),
    sddocname: Schemas,
  })
  .merge(defaultVespaFieldsSchema)

const VespaAutocompleteMailAttachmentSchema = z
  .object({
    docId: z.string(),
    filename: z.string(),
    sddocname: Schemas,
  })
  .merge(defaultVespaFieldsSchema)

const VespaAutocompleteEventSchema = z
  .object({
    docId: z.string(),
    name: z.string().optional(),
    app: z.nativeEnum(Apps),
    entity: entitySchema,
    sddocname: Schemas,
  })
  .merge(defaultVespaFieldsSchema)

const VespaAutocompleteUserQueryHSchema = z
  .object({
    docId: z.string(),
    query_text: z.string(),
    timestamp: z.number().optional(),
    sddocname: Schemas,
  })
  .merge(defaultVespaFieldsSchema)

export const VespaAutocompleteChatContainerSchema = z
  .object({
    docId: z.string(),
    name: z.string(),
    app: z.nativeEnum(Apps),
    sddocname: Schemas,
  })
  .merge(defaultVespaFieldsSchema)

const VespaAutocompleteSummarySchema = z.union([
  VespaAutocompleteFileSchema,
  VespaAutocompleteUserSchema,
  VespaAutocompleteMailSchema,
  VespaAutocompleteUserQueryHSchema,
  VespaAutocompleteMailAttachmentSchema,
  VespaAutocompleteChatContainerSchema,
  VespaAutocompleteChatUserSchema,
])

const VespaAutocompleteFieldsSchema = z
  .object({
    matchfeatures: AutocompleteMatchFeaturesSchema,
    sddocname: Schemas,
  })
  .and(VespaAutocompleteSummarySchema)

export const VespaAutocompleteSchema = z.object({
  id: z.string(),
  relevance: z.number(),
  source: z.string(),
  fields: VespaAutocompleteFieldsSchema,
})

export const VespaAutocompleteResponseSchema = VespaRootBaseSchema.extend({
  root: VespaRootBaseSchema.shape.root.extend({
    children: z.array(VespaAutocompleteSchema),
  }),
})

export type VespaAutocomplete = z.infer<typeof VespaAutocompleteSchema>
export type VespaAutocompleteResponse = z.infer<
  typeof VespaAutocompleteResponseSchema
>
export type VespaAutocompleteFile = z.infer<typeof VespaAutocompleteFileSchema>
export type VespaAutocompleteUser = z.infer<typeof VespaAutocompleteUserSchema>
export type VespaAutocompleteMail = z.infer<typeof VespaAutocompleteMailSchema>
export type VespaAutocompleteMailAttachment = z.infer<
  typeof VespaAutocompleteMailAttachmentSchema
>

export type VespaAutocompleteChatUser = z.infer<
  typeof VespaAutocompleteChatUserSchema
>
export type VespaAutocompleteEvent = z.infer<
  typeof VespaAutocompleteEventSchema
>
export type VespaAutocompleteUserQueryHistory = z.infer<
  typeof VespaAutocompleteUserQueryHSchema
>

export type Mail = z.infer<typeof MailSchema>
export type Attachment = z.infer<typeof AttachmentSchema>

export type VespaMail = z.infer<typeof VespaMailSchema>
export type VespaMailGet = z.infer<typeof VespaMailGetSchema>

export type MailAttachment = z.infer<typeof MailAttachmentSchema>
export type VespaMailAttachment = z.infer<typeof VespaMailAttachmentSchema>

export type VespaEvent = z.infer<typeof VespaEventSchema>

export type VespaChatContainer = z.infer<typeof VespaChatContainerSchema>
export type VespaChatContainerSearch = z.infer<
  typeof VespaChatContainerSearchSchema
>
export type VespaChatUser = z.infer<typeof VespaChatUserSchema>
export type VespaChatMessage = z.infer<typeof VespaChatMessageSchema>
export type VespaChatUserSearch = z.infer<typeof VespaChatUserSearchSchema>
export type VespaAutocompleteChatContainer = z.infer<
  typeof VespaAutocompleteChatContainerSchema
>

export const MailResponseSchema = VespaMailGetSchema.pick({
  docId: true,
  threadId: true,
  app: true,
  entity: true,
  subject: true,
  from: true,
  relevance: true,
  timestamp: true,
  userMap: true,
  mailId: true,
})
  .strip()
  .extend({
    type: z.literal("mail"),
    mimeType: z.string(),
    chunks_summary: z.array(scoredChunk).optional(),
    matchfeatures: z.any().optional(),
    rankfeatures: z.any().optional(),
  })

export const MailAttachmentResponseSchema = VespaMailAttachmentGetSchema.pick({
  docId: true,
  app: true,
  entity: true,
  relevance: true,
  timestamp: true,
  filename: true,
  mailId: true,
  partId: true,
  fileType: true,
})
  .strip()
  .extend({
    type: z.literal("mail_attachment"),
    chunks_summary: z.array(scoredChunk).optional(),
    matchfeatures: z.any().optional(),
    rankfeatures: z.any().optional(),
  })

export const ChatMessageResponseSchema = VespaChatMessageGetSchema.pick({
  docId: true,
  teamId: true,
  channelId: true,
  text: true,
  userId: true,
  app: true,
  entity: true,
  createdAt: true,
  threadId: true,
  image: true,
  name: true,
  domain: true,
  username: true,
  attachmentIds: true,
  mentions: true,
  relevance: true,
  updatedAt: true,
})
  .strip()
  .extend({
    type: z.literal("chat_message"),
    chunks_summary: z.array(z.string()).optional(),
    matchfeatures: z.any().optional(),
    rankfeatures: z.any().optional(),
  })

export const DataSourceFileResponseSchema = VespaDataSourceFileGetSchema.pick({
  docId: true,
  description: true,
  app: true,
  fileName: true,
  fileSize: true,
  uploadedBy: true,
  duration: true,
  mimeType: true,
  createdAt: true,
  updatedAt: true,
  dataSourceRef: true,
  metadata: true,
  relevance: true,
})
  .strip()
  .extend({
    type: z.literal(dataSourceFileSchema), // Using the schema const for the literal
    chunks_summary: z.array(z.union([z.string(), scoredChunk])).optional(),
    matchfeatures: DataSourceFileMatchFeaturesSchema.optional(), // or z.any().optional() if specific match features aren't always needed here
    rankfeatures: z.any().optional(),
  })
export type DataSourceFileResponse = z.infer<
  typeof DataSourceFileResponseSchema
>

export const APP_INTEGRATION_MAPPING: Record<string, Apps> = {
  gmail: Apps.Gmail,
  drive: Apps.GoogleDrive,
  googledrive: Apps.GoogleDrive,
  googlecalendar: Apps.GoogleCalendar,
  // Microsoft mappings (mirroring Google structure)
  outlook: Apps.MicrosoftOutlook,
  microsoftoutlook: Apps.MicrosoftOutlook,
  onedrive: Apps.MicrosoftDrive,
  microsoftdrive: Apps.MicrosoftDrive,
  microsoftcalendar: Apps.MicrosoftCalendar,
  slack: Apps.Slack,
  datasource: Apps.DataSource,
  "google-workspace": Apps.GoogleWorkspace,
  googledocs: Apps.GoogleDrive,
  googlesheets: Apps.GoogleDrive,
  pdf: Apps.GoogleDrive,
}
