import type { Apps } from "@/shared/types"

// TODO: add more default error messages

enum DbOp {
  Create = "Create",
  READ = "Read",
  Update = "Update",
  Delete = "Delete",
}

enum Model {
  Connectors = "connectors",
  Providers = "providers",
  Users = "users",
}

// Define a base error options type
type BaseErrorOpts = {
  message?: string
  cause?: Error
  fn?: any
}

type ErrorOpts = {
  cause?: Error
  // call ErrorStack on it
  fn?: Function
}

type DbErrorOpts = BaseErrorOpts & {
  model: Model
  dbOp: DbOp
}

class DbError extends Error {
  constructor({ message, model, dbOp, cause }: DbErrorOpts) {
    super(`${message}: for model ${model} and op: ${dbOp}`, { cause })
    Error.captureStackTrace(this, this.constructor)
  }
}

enum VespaDbOp {
  Search = "Search",
}

type Op = VespaDbOp | DbOp

type VespaErrorOpts = BaseErrorOpts & {
  sources: string // or enum type
  op: Op
  docId?: string
}

type VespaErrorOptsSansOp = Omit<VespaErrorOpts, "op">

class VespaError extends Error {
  constructor({ message, sources, op, docId, cause }: VespaErrorOpts) {
    let fullMessage = `${message}: for source ${sources} and op: ${op}`
    if (docId) fullMessage += ` for docId: ${docId}`
    super(fullMessage, { cause })
    Error.captureStackTrace(this, this.constructor)
  }
}

enum IntegrationOp {}

type IntegrationErrorOpts = BaseErrorOpts & {
  integration: Apps // assuming Apps is an enum type
  entity: any
  op?: IntegrationOp
  docId?: string
  jobId?: string
}

type IntegrationErrorPartialMsgOpts = Omit<IntegrationErrorOpts, "message"> &
  Partial<Pick<IntegrationErrorOpts, "message">> &
  ErrorOpts

class IntegrationsError extends Error {
  constructor({
    message,
    integration,
    entity,
    op,
    docId,
    jobId,
    cause,
  }: IntegrationErrorOpts) {
    let fullMessage = `${message}: for integration ${integration} ${entity} and op: ${op}`
    if (docId) fullMessage += ` for docId: ${docId}`
    if (jobId) fullMessage += ` and jobId: ${jobId}`
    super(fullMessage, { cause })
    Error.captureStackTrace(this, this.constructor)
  }
}

// InitialisationError
export class InitialisationError extends Error {
  constructor(errOpts: errorOpts) {
    let { message, cause } = errOpts
    if (!message) {
      message = "Error while initialising the server"
    }
    super(message, { cause })
    this.name = this.constructor.name
  }
}

type errorOpts = { message?: string; cause?: Error }
// AuthRedirectionError
export class AuthRedirectError extends Error {
  constructor(errOpts: errorOpts) {
    let { message, cause } = errOpts
    if (!message) {
      message = "Error while auth redirection"
    }
    super(message, { cause })
    this.name = this.constructor.name
  }
}

// vespa/ErrorUpdatingDocument
export class ErrorUpdatingDocument extends VespaError {
  constructor(vespaErrOpts: VespaErrorOptsSansOp) {
    super({ ...vespaErrOpts, op: DbOp.Update })
    this.name = this.constructor.name
  }
}

// vespa/ErrorPerformingSearch
export class ErrorPerformingSearch extends VespaError {
  constructor(vespaErrOpts: VespaErrorOptsSansOp) {
    super({ ...vespaErrOpts, op: VespaDbOp.Search })
    this.name = this.constructor.name
  }
}

// vespa/ErrorGettingDocument
export class ErrorGettingDocument extends VespaError {
  constructor(vespaErrOpts: VespaErrorOptsSansOp) {
    super({ ...vespaErrOpts, op: DbOp.READ })
    this.name = this.constructor.name
  }
}

// vespa/ErrorDeletingDocuments
export class ErrorDeletingDocuments extends VespaError {
  constructor(errorOpts: VespaErrorOptsSansOp) {
    super({ ...errorOpts, op: DbOp.READ })
    this.name = this.constructor.name
  }
}

type vespaErrorOpts = Omit<VespaErrorOpts, "message"> &
  Partial<Pick<VespaErrorOpts, "message">>
// search/vespa/ErrorInsertingDocument
export class ErrorInsertingDocument extends VespaError {
  constructor(vespaErrOpts: VespaErrorOptsSansOp) {
    let { message, cause } = vespaErrOpts
    if (!message) {
      message = `Error inserting document`
    }
    super({ ...vespaErrOpts, message, cause, op: DbOp.Create })
    this.name = this.constructor.name
  }
}

// search/vespa/ErrorRetrievingDocuments
export class ErrorRetrievingDocuments extends VespaError {
  constructor(vespaErrOpts: VespaErrorOptsSansOp) {
    let { message, cause } = vespaErrOpts
    if (!message) {
      message = "Error retrieving documents"
    }
    super({ ...vespaErrOpts, message, cause, op: DbOp.READ })
    this.name = this.constructor.name
  }
}

// integrations/MissingDocumentWithId
export class MissingDocumentWithId extends IntegrationsError {
  constructor(integrationErrOpts: IntegrationErrorPartialMsgOpts) {
    let { message } = integrationErrOpts
    if (!message) {
      message = `Could not get document`
    }
    super({ ...integrationErrOpts, message })
    this.name = this.constructor.name
  }
}

// integrations/CouldNotFinishJobSuccessfully
export class CouldNotFinishJobSuccessfully extends IntegrationsError {
  constructor(integrationErrOpts: IntegrationErrorPartialMsgOpts) {
    let { message } = integrationErrOpts
    if (!message) {
      message = "Could not finish job successfully"
    }
    super({ ...integrationErrOpts, message })
    this.name = this.constructor.name
  }
}

export class UserListingError extends IntegrationsError {
  constructor(integrationErrOpts: IntegrationErrorPartialMsgOpts) {
    let { message } = integrationErrOpts
    if (!message) {
      message = `Error listing users`
    }
    super({ ...integrationErrOpts, message })
    this.name = this.constructor.name
  }
}

export class ContactListingError extends IntegrationsError {
  constructor(integrationErrOpts: IntegrationErrorPartialMsgOpts) {
    let { message } = integrationErrOpts
    if (!message) {
      message = `Could not list contact`
    }
    super({ ...integrationErrOpts, message })
    this.name = this.constructor.name
  }
}

export class ContactMappingError extends IntegrationsError {
  constructor(integrationErrOpts: IntegrationErrorPartialMsgOpts) {
    let { message } = integrationErrOpts
    if (!message) {
      message = `Could not map contact to vespa schema`
    }
    super({ ...integrationErrOpts, message })
    this.name = this.constructor.name
  }
}

// integrations/UnableToCompleteSyncJob
export class SyncJobFailed extends IntegrationsError {
  constructor(integrationErrOpts: IntegrationErrorPartialMsgOpts) {
    let { message } = integrationErrOpts
    if (!message) {
      message = `Could not successfully complete sync job`
    }
    super({ ...integrationErrOpts, message })
    this.name = this.constructor.name
  }
}

export class EmailParsingError extends IntegrationsError {
  constructor(integrationErrOpts: IntegrationErrorPartialMsgOpts) {
    let { message } = integrationErrOpts
    if (!message) {
      message = `Could not parse email`
    }
    super({ ...integrationErrOpts, message })
    this.name = this.constructor.name
  }
}

// db/connectors/MissingOauthConnectorCredentials
export class MissingOauthConnectorCredentialsError extends DbError {
  constructor(errOpts: BaseErrorOpts) {
    let { message, cause } = errOpts
    if (!message) {
      message = `Severe: OAuth connector credentials are not present`
    }
    super({ message, model: Model.Connectors, dbOp: DbOp.READ })
    this.name = this.constructor.name
  }
}

// db/connectors/UnableToUpdateConnector
export class UpdateConnectorFailed extends DbError {
  constructor(message: string) {
    super({ message, model: Model.Connectors, dbOp: DbOp.Update })
    this.name = this.constructor.name
  }
}

// db/connectors/UnableToFetchProvider
export class FetchProviderFailed extends DbError {
  constructor({ message, cause }: BaseErrorOpts) {
    super({ message, model: Model.Providers, dbOp: DbOp.Update, cause })
    this.name = this.constructor.name
  }
}

// db/connectors/NoOauthConnectorFound
export class NoOauthConnectorFound extends DbError {
  constructor({ message, cause }: BaseErrorOpts) {
    super({ message, model: Model.Connectors, dbOp: DbOp.Create, cause })
    this.name = this.constructor.name
  }
}

// db/connectors/NoConnectorsFound
export class NoConnectorsFound extends DbError {
  constructor({ message, cause }: BaseErrorOpts) {
    super({ message, model: Model.Connectors, dbOp: DbOp.READ, cause })
    this.name = this.constructor.name
  }
}

// db/connectors/ConnectionInsertionError
export class ConnectionInsertionError extends DbError {
  constructor({ message, cause }: BaseErrorOpts) {
    super({ message, model: Model.Connectors, dbOp: DbOp.Create, cause })
    this.name = this.constructor.name
  }
}

// api/oauth/OauthCallbackError
export class OAuthCallbackError extends Error {
  constructor({ message, cause }: BaseErrorOpts) {
    super(`${message || "Error while executing oauth callback"}`, { cause })
    this.name = this.constructor.name
  }
}

// api/admin/NoUserFound
export class NoUserFound extends DbError {
  constructor({ message, cause }: BaseErrorOpts) {
    super({ message, model: Model.Users, dbOp: DbOp.READ, cause })
    this.name = "NoUserFound"
  }
}

// api/admin/AddServiceConnectionError
export class AddServiceConnectionError extends DbError {
  constructor({ message, cause }: BaseErrorOpts) {
    super({ message, model: Model.Connectors, dbOp: DbOp.Create, cause })
    this.name = this.constructor.name
  }
}

// api/admin/ConnectorNotCreated
export class ConnectorNotCreated extends DbError {
  constructor({ message, cause }: BaseErrorOpts) {
    super({ message, model: Model.Connectors, dbOp: DbOp.READ, cause })
    this.name = this.constructor.name
  }
}

export class DownloadDocumentError extends IntegrationsError {
  constructor(integrationErrOpts: IntegrationErrorPartialMsgOpts) {
    let { message } = integrationErrOpts
    if (!message) {
      message = `Error while downloading document`
    }
    super({ ...integrationErrOpts, message })
    this.name = this.constructor.name
  }
}

export class DeleteDocumentError extends IntegrationsError {
  constructor(integrationErrOpts: IntegrationErrorPartialMsgOpts) {
    let { message } = integrationErrOpts
    if (!message) {
      message = `Error while deleting document`
    }
    super({ ...integrationErrOpts, message })
    this.name = this.constructor.name
  }
}

export class CalendarEventsListingError extends IntegrationsError {
  constructor(integrationErrOpts: IntegrationErrorPartialMsgOpts) {
    let { message } = integrationErrOpts
    if (!message) {
      message = `Could not list calendar events`
    }
    super({ ...integrationErrOpts, message })
    this.name = this.constructor.name
  }
}
