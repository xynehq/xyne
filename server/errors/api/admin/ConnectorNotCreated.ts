export class ConnectorNotCreated extends Error {
    constructor(message?: string) {
        super(`Error : ${message || 'Connector could not be created successfully'}`);
        this.name = 'ConnectorNotCreated';
    }
}