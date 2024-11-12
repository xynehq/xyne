import { z } from "zod"
export const fileSchema = "file" // Replace with your actual schema name
export const userSchema = "user"
export const mailSchema = "mail"
export const eventSchema = "event"
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

export const PeopleEntitySchema = z.nativeEnum(GooglePeopleEntity)

export type PeopleEntity = z.infer<typeof PeopleEntitySchema>

export enum NotionEntity {
  Page = "page",
  Database = "database",
}

export const FileEntitySchema = z.nativeEnum(DriveEntity)
export const MailEntitySchema = z.nativeEnum(MailEntity)

const NotionEntitySchema = z.nativeEnum(NotionEntity)

export const entitySchema = z.union([
  PeopleEntitySchema,
  FileEntitySchema,
  NotionEntitySchema,
  MailEntitySchema,
])

export type Entity = PeopleEntity | DriveEntity | NotionEntity | MailEntity

export type WorkspaceEntity = DriveEntity

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

export const VespaFileSearchSchema = VespaFileSchema.extend({
  sddocname: z.literal(fileSchema),
})
  .merge(defaultVespaFieldsSchema)
  .extend({
    chunks_summary: z.array(z.string()),
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
    langauge: z.string().optional(),
    includeInGlobalAddressList: z.boolean().optional(),
    isAdmin: z.boolean().optional(),
    isDelegatedAdmin: z.boolean().optional(),
    suspended: z.boolean().optional(),
    archived: z.boolean().optional(),
    urls: z.array(z.string()).optional(),
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
  email: z.string(),
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
})

export const VespaMailSearchSchema = VespaMailSchema.extend({
  sddocname: z.literal("mail"),
})
  .merge(defaultVespaFieldsSchema)
  .extend({
    // attachment won't have this
    chunks_summary: z.array(z.string()).optional(),
  })

export const VespaEventSearchSchema = VespaEventSchema.extend({
  sddocname: z.literal("event"),
}).merge(defaultVespaFieldsSchema)

export const VespaMailGetSchema = VespaMailSchema.merge(
  defaultVespaFieldsSchema,
)

export const VespaSearchFieldsUnionSchema = z.discriminatedUnion("sddocname", [
  VespaUserSchema,
  VespaFileSearchSchema,
  VespaMailSearchSchema,
  VespaEventSearchSchema,
])

// Match features for file schema
const FileMatchFeaturesSchema = z.object({
  "bm25(title)": z.number().optional(),
  "bm25(chunks)": z.number().optional(),
  "closeness(field, chunk_embeddings)": z.number().optional(),
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
})

const EventMatchFeaturesSchema = z.object({
  "bm25(name)": z.number().optional(),
  "bm25(description)": z.number().optional(),
  "bm25(attachmentFilenames)": z.number().optional(),
  "bm25(attendeesNames)": z.number().optional(),
})

const SearchMatchFeaturesSchema = z.union([
  FileMatchFeaturesSchema,
  UserMatchFeaturesSchema,
  MailMatchFeaturesSchema,
  EventMatchFeaturesSchema,
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

export type VespaSearchResults = z.infer<typeof VespaSearchResultSchema>

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
})

const VespaSearchResultSchema = z.union([
  VespaSearchResultsSchema,
  VespaGroupSchema,
])
export type VespaSearchResult = z.infer<typeof VespaSearchResultSchema>

const VespaSearchResponseSchema = VespaRootBaseSchema.extend({
  root: VespaRootBaseSchema.shape.root.extend({
    children: z.array(VespaSearchResultSchema),
  }),
})

export type VespaSearchResponse = z.infer<typeof VespaSearchResponseSchema>

export type VespaFileGet = z.infer<typeof VespaFileGetSchema>
export type VespaFileSearch = z.infer<typeof VespaFileSearchSchema>
export type VespaMailSearch = z.infer<typeof VespaMailSearchSchema>
export type VespaFile = z.infer<typeof VespaFileSchema>
export type VespaUser = z.infer<typeof VespaUserSchema>

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

const VespaAutocompleteSummarySchema = z.union([
  VespaAutocompleteFileSchema,
  VespaAutocompleteUserSchema,
  VespaAutocompleteMailSchema,
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

export type Mail = z.infer<typeof MailSchema>
export type Attachment = z.infer<typeof AttachmentSchema>

export type VespaMail = z.infer<typeof VespaMailSchema>
export type VespaMailGet = z.infer<typeof VespaMailGetSchema>

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
    chunks_summary: z.array(z.string()).optional(),
  })
