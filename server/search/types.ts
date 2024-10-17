import { z } from "zod"
// not using @ because of vite of frontend

export enum Apps {
  // includes everything google
  GoogleWorkspace = "google-workspace",
  // more granular
  GoogleDrive = "google-drive",

  Notion = "notion",
}

export enum GooglePeopleEntity {
  Contacts = "Contacts",
  OtherContacts = "OtherContacts",
  AdminDirectory = "AdminDirectory",
}
// the vespa schemas
const Schemas = z.union([z.literal("file"), z.literal("user")])

export enum DriveEntity {
  Docs = "docs",
  Sheets = "sheets",
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

const NotionEntitySchema = z.nativeEnum(NotionEntity)

export const entitySchema = z.union([
  PeopleEntitySchema,
  FileEntitySchema,
  NotionEntitySchema,
])

export type Entity = PeopleEntity | DriveEntity | NotionEntity

export type WorkspaceEntity = DriveEntity

export const defaultVespaFieldsSchema = z.object({
  relevance: z.number(),
  source: z.string(),
  // sddocname: Schemas,
  documentid: z.string(),
})

export const VespaFileSchema = z
  .object({
    docId: z.string(),
    app: z.nativeEnum(Apps),
    entity: FileEntitySchema,
    title: z.string(),
    url: z.string().nullable(),
    // we don't want zod to validate this for perf reason
    chunks: z.array(z.string()),
    owner: z.string().nullable(),
    ownerEmail: z.string().nullable(),
    photoLink: z.string().nullable(),
    permissions: z.array(z.string()),
    mimeType: z.string().nullable(),
    sddocname: z.literal("file"),
  })
  .merge(defaultVespaFieldsSchema)

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
    sddocname: z.literal("user"),
  })
  .merge(defaultVespaFieldsSchema)

export const VespaFieldsSchema = z.discriminatedUnion("sddocname", [
  VespaUserSchema,
  VespaFileSchema,
])

const VespaResultSchema = z.object({
  id: z.string(),
  relevance: z.number(),
  fields: VespaFieldsSchema,
  pathId: z.string().optional(),
})

export type VespaResult = z.infer<typeof VespaResultSchema>

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
  }),
})

const VespaSearchResultSchema = z.union([VespaResultSchema, VespaGroupSchema])
export type VespaSearchResult = z.infer<typeof VespaSearchResultSchema>

const VespaSearchResponseSchema = VespaRootBaseSchema.extend({
  root: VespaRootBaseSchema.shape.root.extend({
    children: z.array(VespaSearchResultSchema),
  }),
})

export type VespaSearchResponse = z.infer<typeof VespaSearchResponseSchema>

export type VespaFile = z.infer<typeof VespaFileSchema>
export type VespaUser = z.infer<typeof VespaUserSchema>

export type VespaFileWithDrivePermission = Omit<VespaFile, "permissions"> & {
  permissions: any[]
}

const MatchFeaturesSchema = z.union([
  z.object({
    "bm25(title_fuzzy)": z.number(),
  }),
  z.object({
    "bm25(email_fuzzy)": z.number(),
    "bm25(name_fuzzy)": z.number(),
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

const VespaAutocompleteSummarySchema = z.union([
  VespaAutocompleteFileSchema,
  VespaAutocompleteUserSchema,
])

const VespaAutocompleteFieldsSchema = z
  .object({
    matchfeatures: MatchFeaturesSchema,
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
