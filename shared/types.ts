//@ts-ignore
import type { AppRoutes, WsApp } from "@/server"

export enum Apps {
    // includes everything google
    GoogleWorkspace = "google-workspace",
    // more granular
    GoogleDrive = "google-drive"
}

export type AppType = typeof AppRoutes
export type WebSocketApp = typeof WsApp

export interface FileResponse {
    docId: string,
    title: string,
    chunk: string,
    chunkIndex: number,
    url: string,
    app: string,
    entity: string,
    mimeType: string,
    photoLink: string,
    owner: string,
    ownerEmail: string,
    chunks_summary: string[]
}

export enum AuthType {
    OAuth = 'oauth',
    ServiceAccount = 'service_account',
    // where there is a custom JSON
    // we store all the key information
    // needed for end to end encryption
    Custom = 'custom',
    ApiKey = 'api_key'
}

export enum ConnectorStatus {
    Connected = 'connected',
    // Pending = 'pending',
    Connecting = 'connecting',
    Failed = 'failed',
    // for oauth we will default to this
    NotConnected = 'not-connected'
}

export enum SyncJobStatus {
    // never ran
    NotStarted = 'NotStarted',
    // Ongoing
    Started = 'Started',
    // last status failed
    Failed = 'Failed',
    // last status was good
    Successful = 'Successful'
}


export enum Subsystem {
    // SERVER SIDE LOGGING
    server = 'Server',
    auth = 'Auth',
    cleanup = 'Cleanup',
    cronjob = 'Cronjob',
    ingest = 'Ingets',
    integrations = 'Server/Integrations',
    search = 'Server/Search',
    db = 'Server/Db',
    api = 'Server/Api',
    notion = 'Server/Notion_Integration',
    utils = 'Server/Utils',
    queue= 'Server/Queue',

    // FRONTEND SIDE LOGGING 
    client = 'CLient',
    oauth = 'Client/Oauth',
    admin = 'Client/Admin',
}

export enum OperationType {
    sub = 'SUBSYSTEM'
}

export enum OperationStatus {
    success = 'SUCCESS',
    failure = 'FAILURE',
    pendings = 'PENDING',
    cancelled = 'CANCELLED',
}

export type additionalMessage = Partial<{
  STATUS: OperationStatus;
  OPERATION_TYPE: OperationType;
  TIME_TAKEN: number;
}>;