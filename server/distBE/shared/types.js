import {
  entitySchema,
  VespaFileSchema,
  VespaUserSchema,
  Apps,
  mailSchema,
  userSchema,
  fileSchema,
  MailResponseSchema,
  eventSchema,
  VespaEventSchema,
  userQuerySchema,
  MailAttachmentResponseSchema,
  mailAttachmentSchema,
} from "../search/types.js"
export {
  GooglePeopleEntity,
  DriveEntity,
  NotionEntity,
  CalendarEntity,
  MailAttachmentEntity,
  Apps,
  isMailAttachment,
} from "../search/types.js"
import { z } from "zod";
export var AuthType;
(function (AuthType) {
    AuthType["OAuth"] = "oauth";
    AuthType["ServiceAccount"] = "service_account";
    // where there is a custom JSON
    // we store all the key information
    // needed for end to end encryption
    AuthType["Custom"] = "custom";
    AuthType["ApiKey"] = "api_key";
})(AuthType || (AuthType = {}));
export var ConnectorStatus;
(function (ConnectorStatus) {
    ConnectorStatus["Connected"] = "connected";
    // Pending = 'pending',
    ConnectorStatus["Connecting"] = "connecting";
    ConnectorStatus["Failed"] = "failed";
    // for oauth we will default to this
    ConnectorStatus["NotConnected"] = "not-connected";
})(ConnectorStatus || (ConnectorStatus = {}));
export var SyncJobStatus;
(function (SyncJobStatus) {
    // never ran
    SyncJobStatus["NotStarted"] = "NotStarted";
    // Ongoing
    SyncJobStatus["Started"] = "Started";
    // last status failed
    SyncJobStatus["Failed"] = "Failed";
    // last status was good
    SyncJobStatus["Successful"] = "Successful";
})(SyncJobStatus || (SyncJobStatus = {}));
export var OpenAIError;
(function (OpenAIError) {
    OpenAIError["RateLimitError"] = "rate_limit_exceeded";
    OpenAIError["InvalidAPIKey"] = "invalid_api_key";
})(OpenAIError || (OpenAIError = {}));
export const AutocompleteFileSchema = z
    .object({
    type: z.literal(fileSchema),
    relevance: z.number(),
    title: z.string(),
    app: z.nativeEnum(Apps),
    entity: entitySchema,
})
    .strip();
export const AutocompleteUserSchema = z
    .object({
    type: z.literal(userSchema),
    relevance: z.number(),
    // optional due to contacts
    name: z.string().optional(),
    email: z.string(),
    app: z.nativeEnum(Apps),
    entity: entitySchema,
    photoLink: z.string().optional(),
})
    .strip();
export const AutocompleteUserQueryHSchema = z
    .object({
    type: z.literal(userQuerySchema),
    docId: z.string(),
    query_text: z.string(),
    timestamp: z.number().optional(),
})
    .strip();
export const AutocompleteMailSchema = z
    .object({
    type: z.literal(mailSchema),
    relevance: z.number(),
    // optional due to contacts
    subject: z.string().optional(),
    app: z.nativeEnum(Apps),
    entity: entitySchema,
    threadId: z.string().optional(),
    docId: z.string(),
})
    .strip();
export const AutocompleteMailAttachmentSchema = z
    .object({
    type: z.literal(mailAttachmentSchema),
    relevance: z.number(),
    app: z.nativeEnum(Apps),
    entity: entitySchema,
    filename: z.string(),
    docId: z.string(),
})
    .strip();
export const AutocompleteEventSchema = z
    .object({
    type: z.literal(eventSchema),
    relevance: z.number(),
    name: z.string().optional(),
    app: z.nativeEnum(Apps),
    entity: entitySchema,
    docId: z.string(),
})
    .strip();
const AutocompleteSchema = z.discriminatedUnion("type", [
    AutocompleteFileSchema,
    AutocompleteUserSchema,
    AutocompleteMailSchema,
    AutocompleteEventSchema,
    AutocompleteUserQueryHSchema,
    AutocompleteMailAttachmentSchema,
]);
export const AutocompleteResultsSchema = z.object({
    results: z.array(AutocompleteSchema),
});
// search result
export const FileResponseSchema = VespaFileSchema.pick({
    docId: true,
    title: true,
    url: true,
    app: true,
    entity: true,
    owner: true,
    ownerEmail: true,
    photoLink: true,
    updatedAt: true,
})
    .extend({
    type: z.literal(fileSchema),
    chunk: z.string().optional(),
    chunkIndex: z.number().optional(),
    mimeType: z.string(),
    chunks_summary: z.array(z.string()).optional(),
    relevance: z.number(),
})
    .strip();
export const EventResponseSchema = VespaEventSchema.pick({
    docId: true,
    name: true,
    url: true,
    app: true,
    entity: true,
    updatedAt: true,
})
    .extend({
    type: z.literal(eventSchema),
    relevance: z.number(),
    description: z.string().optional(),
    attendeesNames: z.array(z.string()).optional(),
})
    .strip();
export const UserResponseSchema = VespaUserSchema.pick({
    name: true,
    email: true,
    app: true,
    entity: true,
    photoLink: true,
})
    .strip()
    .extend({
    type: z.literal(userSchema),
    relevance: z.number(),
});
// Search Response Schema
export const SearchResultsSchema = z.discriminatedUnion("type", [
    UserResponseSchema,
    FileResponseSchema,
    MailResponseSchema,
    EventResponseSchema,
    MailAttachmentResponseSchema,
]);
export const SearchResponseSchema = z.object({
    count: z.number(),
    results: z.array(SearchResultsSchema),
    groupCount: z.any(),
});
export const AnswerResponseSchema = z.object({});
// kept it minimal to prevent
// unnecessary data transfer
export var AnswerSSEvents;
(function (AnswerSSEvents) {
    AnswerSSEvents["Start"] = "s";
    AnswerSSEvents["AnswerUpdate"] = "u";
    AnswerSSEvents["End"] = "e";
})(AnswerSSEvents || (AnswerSSEvents = {}));
export var ChatSSEvents;
(function (ChatSSEvents) {
    ChatSSEvents["ResponseMetadata"] = "rm";
    ChatSSEvents["Start"] = "s";
    ChatSSEvents["ResponseUpdate"] = "u";
    ChatSSEvents["End"] = "e";
    ChatSSEvents["ChatTitleUpdate"] = "ct";
    ChatSSEvents["CitationsUpdate"] = "cu";
    ChatSSEvents["Reasoning"] = "rz";
    ChatSSEvents["Error"] = "er";
})(ChatSSEvents || (ChatSSEvents = {}));
const messageMetadataSchema = z.object({
    chatId: z.string(),
    messageId: z.string(),
});
// very rudimentary
export var UserRole;
(function (UserRole) {
    UserRole["User"] = "User";
    UserRole["TeamLeader"] = "TeamLeader";
    UserRole["Admin"] = "Admin";
    UserRole["SuperAdmin"] = "SuperAdmin";
})(UserRole || (UserRole = {}));
