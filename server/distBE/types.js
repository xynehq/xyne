import config from "./config.js";
import { z } from "zod";
import { Apps, AuthType } from "./shared/types.js";
import { JWT } from "google-auth-library";
// type GoogleContacts = people_v1.Schema$Person
// type WorkspaceDirectoryUser = admin_directory_v1.Schema$User
// People graph of google workspace
// type GoogleWorkspacePeople = WorkspaceDirectoryUser | GoogleContacts
// type PeopleData = GoogleWorkspacePeople
const baseSearchSchema = z.object({
    query: z.string(),
    groupCount: z
        .union([z.string(), z.undefined(), z.null()])
        .transform((x) => (x ? x === "true" : false))
        .pipe(z.boolean())
        .optional(),
    offset: z
        .union([z.string(), z.undefined(), z.null()])
        .transform((x) => Number(x ?? 0))
        .pipe(z.number().min(0))
        .optional(),
    page: z
        .union([z.string(), z.undefined(), z.null()])
        .transform((x) => Number(x ?? config.page))
        .pipe(z.number())
        .optional(),
    app: z.nativeEnum(Apps).optional(),
    entity: z.string().min(1).optional(),
    lastUpdated: z.string().default("anytime"),
    isQueryTyped: z.preprocess((val) => val === "true", z.boolean()).optional(),
});
export const searchSchema = baseSearchSchema.refine((data) => (data.app && data.entity) || (!data.app && !data.entity), {
    message: "app and entity must be provided together",
    path: ["app", "entity"],
});
export const answerSchema = z.object({
    query: z.string(),
    app: z.nativeEnum(Apps).optional(),
    entity: z.string().min(1).optional(),
});
export const searchQuerySchema = baseSearchSchema.extend({
    permissions: z.array(z.string()),
});
export const oauthStartQuerySchema = z.object({
    app: z.nativeEnum(Apps),
});
export const addServiceConnectionSchema = z.object({
    "service-key": z.any(),
    app: z.nativeEnum(Apps),
    email: z.string(),
});
export const createOAuthProvider = z.object({
    clientId: z.string(),
    clientSecret: z.string(),
    scopes: z.array(z.string()),
    app: z.nativeEnum(Apps),
});
// Define an enum for connection types
export var ConnectorType;
(function (ConnectorType) {
    // Google, Notion, Github
    ConnectorType["SaaS"] = "SaaS";
    // DuckDB, Postgres, MySQL
    ConnectorType["Database"] = "Database";
    // Weather api?
    ConnectorType["API"] = "Api";
    // Manually uploaded data like pdf
    ConnectorType["File"] = "File";
    // Where we can scrape and crawl
    ConnectorType["Website"] = "Website";
})(ConnectorType || (ConnectorType = {}));
export var SyncCron;
(function (SyncCron) {
    // Sync based on a token provided by the external API
    // Used to track changes since the last sync via change token.
    SyncCron["ChangeToken"] = "ChangeToken";
    // Sync based on querying the API with a last updated or modified timestamp.
    // Useful when the API allows fetching updated data since a specific time.
    SyncCron["Partial"] = "Partial";
    // Perform a full data sync by fetching everything and
    // applying filters like modifiedAt/updatedAt internally.
    SyncCron["FullSync"] = "FullSync";
})(SyncCron || (SyncCron = {}));
// history id was getting removed if we just use union
// and do parse of selectSyncJobSchema
// Define ChangeToken schema
const DefaultTokenSchema = z.object({
    type: z.literal("default"),
    token: z.string(),
    lastSyncedAt: z.coerce.date(),
});
// Google Drive and Contact change token
// clubbing drive, contact and other contact tokens
const GoogleDriveChangeTokenSchema = z.object({
    type: z.literal("googleDriveChangeToken"),
    driveToken: z.string(),
    contactsToken: z.string(),
    otherContactsToken: z.string(),
    lastSyncedAt: z.coerce.date(),
});
const GmailChangeTokenSchema = z.object({
    type: z.literal("gmailChangeToken"),
    historyId: z.string(),
    lastSyncedAt: z.coerce.date(),
});
const CalendarEventsChangeTokenSchema = z.object({
    type: z.literal("calendarEventsChangeToken"),
    calendarEventsToken: z.string(),
    lastSyncedAt: z.coerce.date(),
});
const ChangeTokenSchema = z.discriminatedUnion("type", [
    DefaultTokenSchema,
    GoogleDriveChangeTokenSchema,
    GmailChangeTokenSchema,
    CalendarEventsChangeTokenSchema,
]);
// Define UpdatedAtVal schema
const UpdatedAtValSchema = z.object({
    type: z.literal("updatedAt"),
    updatedAt: z.coerce.date(),
});
// Define Config schema (either ChangeToken or UpdatedAtVal)
export const SyncConfigSchema = z.union([ChangeTokenSchema, UpdatedAtValSchema]);
var Google;
(function (Google) {
    Google.DriveFileSchema = z.object({
        id: z.string().nullable(),
        webViewLink: z.string().nullable(),
        createdTime: z.string().nullable(),
        modifiedTime: z.string().nullable(),
        name: z.string().nullable(),
        owners: z
            .array(z.object({
            displayName: z.string().optional(),
            emailAddress: z.string().optional(),
            kind: z.string().optional(),
            me: z.boolean().optional(),
            permissionId: z.string().optional(),
            photoLink: z.string().optional(),
        }))
            .optional(),
        fileExtension: z.string().nullable(),
        mimeType: z.string().nullable(),
        permissions: z
            .array(z.object({
            id: z.string(),
            type: z.string(),
            emailAddress: z.string().nullable(),
        }))
            .nullable(),
    });
})(Google || (Google = {}));
export var MessageTypes;
(function (MessageTypes) {
    MessageTypes["JwtParams"] = "JwtParams";
})(MessageTypes || (MessageTypes = {}));
export var WorkerResponseTypes;
(function (WorkerResponseTypes) {
    WorkerResponseTypes["Stats"] = "Stats";
    WorkerResponseTypes["HistoryId"] = "HistoryId";
})(WorkerResponseTypes || (WorkerResponseTypes = {}));
export var Subsystem;
(function (Subsystem) {
    Subsystem["Server"] = "Server";
    Subsystem["Auth"] = "Auth";
    Subsystem["Cronjob"] = "Cronjob";
    Subsystem["Ingest"] = "Ingest";
    Subsystem["Integrations"] = "Integrations";
    Subsystem["Search"] = "Search";
    Subsystem["Vespa"] = "Vespa";
    Subsystem["Db"] = "Db";
    Subsystem["Api"] = "Api";
    Subsystem["Chat"] = "Chat";
    Subsystem["Utils"] = "Utils";
    Subsystem["Queue"] = "Queue";
    Subsystem["Eval"] = "Eval";
    Subsystem["AI"] = "AI";
})(Subsystem || (Subsystem = {}));
export var OperationStatus;
(function (OperationStatus) {
    OperationStatus["Success"] = "Success";
    OperationStatus["Failure"] = "Failure";
    OperationStatus["Pendings"] = "Pending";
    OperationStatus["Cancelled"] = "Cancelled";
})(OperationStatus || (OperationStatus = {}));
export var MessageRole;
(function (MessageRole) {
    MessageRole["System"] = "system";
    MessageRole["User"] = "user";
    MessageRole["Assistant"] = "assistant";
})(MessageRole || (MessageRole = {}));
export const AnswerWithCitationsSchema = z.object({
    answer: z.string(),
    citations: z.array(z.number()),
});
