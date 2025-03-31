import { z } from "zod"
export const fileSchema = "file" // Replace with your actual schema name
export const userSchema = "user"
export const mailSchema = "mail"
export const eventSchema = "event"
export const userQuerySchema = "user_query"
export const mailAttachmentSchema = "mail_attachment"
export type VespaSchema =
  | typeof fileSchema
  | typeof userSchema
  | typeof mailSchema
  | typeof eventSchema
  | typeof userQuerySchema
  | typeof mailAttachmentSchema

// not using @ because of vite of frontend
export enum Apps {
  // includes everything google
  GoogleWorkspace = "google-workspace",
  // more granular
  GoogleDrive = "google-drive",

  Gmail = "gmail",

  Notion = "notion",
  GoogleCalendar = "google-calendar",
}

export enum GooglePeopleEntity {
  Contacts = "Contacts",
  OtherContacts = "OtherContacts",
  AdminDirectory = "AdminDirectory",
}
// the vespa schemas
const Schemas = z.union([
  z.literal(fileSchema),
  z.literal(userSchema),
  z.literal(mailSchema),
  z.literal(eventSchema),
  z.literal(userQuerySchema),
  z.literal(mailAttachmentSchema),
])

export enum MailEntity {
  Email = "mail",
}

export enum CalendarEntity {
  Event = "event",
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
}

export const isMailAttachment = (entity: Entity): boolean =>
  Object.values(MailAttachmentEntity).includes(entity as MailAttachmentEntity)

export const PeopleEntitySchema = z.nativeEnum(GooglePeopleEntity)

export type PeopleEntity = z.infer<typeof PeopleEntitySchema>

export enum NotionEntity {
  Page = "page",
  Database = "database",
}

export const FileEntitySchema = z.nativeEnum(DriveEntity)
export const MailEntitySchema = z.nativeEnum(MailEntity)
export const MailAttachmentEntitySchema = z.nativeEnum(MailAttachmentEntity)
export const EventEntitySchema = z.nativeEnum(CalendarEntity)

const NotionEntitySchema = z.nativeEnum(NotionEntity)

export const entitySchema = z.union([
  PeopleEntitySchema,
  FileEntitySchema,
  NotionEntitySchema,
  MailEntitySchema,
  EventEntitySchema,
  MailAttachmentEntitySchema,
])

export type Entity =
  | PeopleEntity
  | DriveEntity
  | NotionEntity
  | MailEntity
  | CalendarEntity
  | MailAttachmentEntity

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

export type FileMatchFeatures = z.infer<typeof FileMatchFeaturesSchema>
export type MailMatchFeatures = z.infer<typeof MailMatchFeaturesSchema>
export type MailAttachmentMatchFeatures = z.infer<
  typeof MailAttachmentMatchFeaturesSchema
>

export const VespaMatchFeatureSchema = z.union([
  FileMatchFeaturesSchema,
  MailMatchFeaturesSchema,
  MailAttachmentMatchFeaturesSchema,
])

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
    entity: z.nativeEnum(GooglePeopleEntity),
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
  subject: z.string(),
  chunks: z.array(z.string()),
  timestamp: z.number(),
  app: z.nativeEnum(Apps),
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

export const VespaSearchFieldsUnionSchema = z.discriminatedUnion("sddocname", [
  VespaUserSchema,
  VespaFileSearchSchema,
  VespaMailSearchSchema,
  VespaEventSearchSchema,
  VespaUserQueryHGetSchema,
  VespaMailAttachmentSearchSchema,
])

const SearchMatchFeaturesSchema = z.union([
  FileMatchFeaturesSchema,
  UserMatchFeaturesSchema,
  MailMatchFeaturesSchema,
  EventMatchFeaturesSchema,
  MailAttachmentMatchFeaturesSchema,
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
export type VespaEventSearch = z.infer<typeof VespaEventSearchSchema>
export type VespaFile = z.infer<typeof VespaFileSchema>
export type VespaUser = z.infer<typeof VespaUserSchema>
export type VespaUserQueryHistory = z.infer<typeof VespaUserQueryHistorySchema>

export type VespaFileWithDrivePermission = Omit<VespaFile, "permissions"> & {
  permissions: any[]
}

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

const VespaAutocompleteSummarySchema = z.union([
  VespaAutocompleteFileSchema,
  VespaAutocompleteUserSchema,
  VespaAutocompleteMailSchema,
  VespaAutocompleteUserQueryHSchema,
  VespaAutocompleteMailAttachmentSchema,
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

export const MailResponseSchema = VespaMailGetSchema.pick({
  docId: true,
  threadId: true,
  app: true,
  entity: true,
  subject: true,
  from: true,
  relevance: true,
  timestamp: true,
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
