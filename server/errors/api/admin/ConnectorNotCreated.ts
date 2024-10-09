export class ConnectorNotCreated extends Error {
    constructor(message?: string) {
        super(message ? `Connector could not be created successfully : \n ${message}` : `Connector could not be created successfully`);
    }
}