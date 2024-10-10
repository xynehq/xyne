export class UnableToUpdateConnector extends Error {
    constructor(message?: string) {
        super(`${message || 'Could not update the connector'}`);
        this.name = 'UnableToUpdateConnector';
    }
}