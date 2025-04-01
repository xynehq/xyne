// TODO: add more default error messages
var DbOp;
(function (DbOp) {
    DbOp["Create"] = "Create";
    DbOp["READ"] = "Read";
    DbOp["Update"] = "Update";
    DbOp["Delete"] = "Delete";
})(DbOp || (DbOp = {}));
var Model;
(function (Model) {
    Model["Connectors"] = "connectors";
    Model["Providers"] = "providers";
    Model["Users"] = "users";
})(Model || (Model = {}));
class DbError extends Error {
    constructor({ message, model, dbOp, cause }) {
        super(`${message}: for model ${model} and op: ${dbOp}`, { cause });
        Error.captureStackTrace(this, this.constructor);
    }
}
var VespaDbOp;
(function (VespaDbOp) {
    VespaDbOp["Search"] = "Search";
})(VespaDbOp || (VespaDbOp = {}));
class VespaError extends Error {
    constructor({ message, sources, op, docId, cause }) {
        let fullMessage = `${message}: for source ${sources} and op: ${op}`;
        if (docId)
            fullMessage += ` for docId: ${docId}`;
        super(fullMessage, { cause });
        Error.captureStackTrace(this, this.constructor);
    }
}
var IntegrationOp;
(function (IntegrationOp) {
})(IntegrationOp || (IntegrationOp = {}));
class IntegrationsError extends Error {
    constructor({ message, integration, entity, op, docId, jobId, cause, }) {
        let fullMessage = `${message}: for integration ${integration} ${entity} and op: ${op}`;
        if (docId)
            fullMessage += ` for docId: ${docId}`;
        if (jobId)
            fullMessage += ` and jobId: ${jobId}`;
        super(fullMessage, { cause });
        Error.captureStackTrace(this, this.constructor);
    }
}
// InitialisationError
export class InitialisationError extends Error {
    constructor(errOpts) {
        let { message, cause } = errOpts;
        if (!message) {
            message = "Error while initialising the server";
        }
        super(message, { cause });
        this.name = this.constructor.name;
    }
}
// AuthRedirectionError
export class AuthRedirectError extends Error {
    constructor(errOpts) {
        let { message, cause } = errOpts;
        if (!message) {
            message = "Error while auth redirection";
        }
        super(message, { cause });
        this.name = this.constructor.name;
    }
}
// vespa/ErrorUpdatingDocument
export class ErrorUpdatingDocument extends VespaError {
    constructor(vespaErrOpts) {
        super({ ...vespaErrOpts, op: DbOp.Update });
        this.name = this.constructor.name;
    }
}
// vespa/ErrorPerformingSearch
export class ErrorPerformingSearch extends VespaError {
    constructor(vespaErrOpts) {
        super({ ...vespaErrOpts, op: VespaDbOp.Search });
        this.name = this.constructor.name;
    }
}
// vespa/ErrorGettingDocument
export class ErrorGettingDocument extends VespaError {
    constructor(vespaErrOpts) {
        super({ ...vespaErrOpts, op: DbOp.READ });
        this.name = this.constructor.name;
    }
}
// vespa/ErrorDeletingDocuments
export class ErrorDeletingDocuments extends VespaError {
    constructor(errorOpts) {
        super({ ...errorOpts, op: DbOp.READ });
        this.name = this.constructor.name;
    }
}
// search/vespa/ErrorInsertingDocument
export class ErrorInsertingDocument extends VespaError {
    constructor(vespaErrOpts) {
        let { message, cause } = vespaErrOpts;
        if (!message) {
            message = `Error inserting document`;
        }
        super({ ...vespaErrOpts, message, cause, op: DbOp.Create });
        this.name = this.constructor.name;
    }
}
// search/vespa/ErrorRetrievingDocuments
export class ErrorRetrievingDocuments extends VespaError {
    constructor(vespaErrOpts) {
        let { message, cause } = vespaErrOpts;
        if (!message) {
            message = "Error retrieving documents";
        }
        super({ ...vespaErrOpts, message, cause, op: DbOp.READ });
        this.name = this.constructor.name;
    }
}
// integrations/MissingDocumentWithId
export class MissingDocumentWithId extends IntegrationsError {
    constructor(integrationErrOpts) {
        let { message } = integrationErrOpts;
        if (!message) {
            message = `Could not get document`;
        }
        super({ ...integrationErrOpts, message });
        this.name = this.constructor.name;
    }
}
// integrations/CouldNotFinishJobSuccessfully
export class CouldNotFinishJobSuccessfully extends IntegrationsError {
    constructor(integrationErrOpts) {
        let { message } = integrationErrOpts;
        if (!message) {
            message = "Could not finish job successfully";
        }
        super({ ...integrationErrOpts, message });
        this.name = this.constructor.name;
    }
}
export class UserListingError extends IntegrationsError {
    constructor(integrationErrOpts) {
        let { message } = integrationErrOpts;
        if (!message) {
            message = `Error listing users`;
        }
        super({ ...integrationErrOpts, message });
        this.name = this.constructor.name;
    }
}
export class ContactListingError extends IntegrationsError {
    constructor(integrationErrOpts) {
        let { message } = integrationErrOpts;
        if (!message) {
            message = `Could not list contact`;
        }
        super({ ...integrationErrOpts, message });
        this.name = this.constructor.name;
    }
}
export class ContactMappingError extends IntegrationsError {
    constructor(integrationErrOpts) {
        let { message } = integrationErrOpts;
        if (!message) {
            message = `Could not map contact to vespa schema`;
        }
        super({ ...integrationErrOpts, message });
        this.name = this.constructor.name;
    }
}
// integrations/UnableToCompleteSyncJob
export class SyncJobFailed extends IntegrationsError {
    constructor(integrationErrOpts) {
        let { message } = integrationErrOpts;
        if (!message) {
            message = `Could not successfully complete sync job`;
        }
        super({ ...integrationErrOpts, message });
        this.name = this.constructor.name;
    }
}
export class EmailParsingError extends IntegrationsError {
    constructor(integrationErrOpts) {
        let { message } = integrationErrOpts;
        if (!message) {
            message = `Could not parse email`;
        }
        super({ ...integrationErrOpts, message });
        this.name = this.constructor.name;
    }
}
// db/connectors/MissingOauthConnectorCredentials
export class MissingOauthConnectorCredentialsError extends DbError {
    constructor(errOpts) {
        let { message, cause } = errOpts;
        if (!message) {
            message = `Severe: OAuth connector credentials are not present`;
        }
        super({ message, model: Model.Connectors, dbOp: DbOp.READ });
        this.name = this.constructor.name;
    }
}
// db/connectors/UnableToUpdateConnector
export class UpdateConnectorFailed extends DbError {
    constructor(message) {
        super({ message, model: Model.Connectors, dbOp: DbOp.Update });
        this.name = this.constructor.name;
    }
}
// db/connectors/UnableToFetchProvider
export class FetchProviderFailed extends DbError {
    constructor({ message, cause }) {
        super({ message, model: Model.Providers, dbOp: DbOp.Update, cause });
        this.name = this.constructor.name;
    }
}
// db/connectors/NoOauthConnectorFound
export class NoOauthConnectorFound extends DbError {
    constructor({ message, cause }) {
        super({ message, model: Model.Connectors, dbOp: DbOp.Create, cause });
        this.name = this.constructor.name;
    }
}
// db/connectors/NoConnectorsFound
export class NoConnectorsFound extends DbError {
    constructor({ message, cause }) {
        super({ message, model: Model.Connectors, dbOp: DbOp.READ, cause });
        this.name = this.constructor.name;
    }
}
// db/connectors/ConnectionInsertionError
export class ConnectionInsertionError extends DbError {
    constructor({ message, cause }) {
        super({ message, model: Model.Connectors, dbOp: DbOp.Create, cause });
        this.name = this.constructor.name;
    }
}
// api/oauth/OauthCallbackError
export class OAuthCallbackError extends Error {
    constructor({ message, cause }) {
        super(`${message || "Error while executing oauth callback"}`, { cause });
        this.name = this.constructor.name;
    }
}
// api/admin/NoUserFound
export class NoUserFound extends DbError {
    constructor({ message, cause }) {
        super({ message, model: Model.Users, dbOp: DbOp.READ, cause });
        this.name = "NoUserFound";
    }
}
// api/admin/AddServiceConnectionError
export class AddServiceConnectionError extends DbError {
    constructor({ message, cause }) {
        super({ message, model: Model.Connectors, dbOp: DbOp.Create, cause });
        this.name = this.constructor.name;
    }
}
// api/admin/ConnectorNotCreated
export class ConnectorNotCreated extends DbError {
    constructor({ message, cause }) {
        super({ message, model: Model.Connectors, dbOp: DbOp.READ, cause });
        this.name = this.constructor.name;
    }
}
export class DownloadDocumentError extends IntegrationsError {
    constructor(integrationErrOpts) {
        let { message } = integrationErrOpts;
        if (!message) {
            message = `Error while downloading document`;
        }
        super({ ...integrationErrOpts, message });
        this.name = this.constructor.name;
    }
}
export class DeleteDocumentError extends IntegrationsError {
    constructor(integrationErrOpts) {
        let { message } = integrationErrOpts;
        if (!message) {
            message = `Error while deleting document`;
        }
        super({ ...integrationErrOpts, message });
        this.name = this.constructor.name;
    }
}
export class CalendarEventsListingError extends IntegrationsError {
    constructor(integrationErrOpts) {
        let { message } = integrationErrOpts;
        if (!message) {
            message = `Could not list calendar events`;
        }
        super({ ...integrationErrOpts, message });
        this.name = this.constructor.name;
    }
}
