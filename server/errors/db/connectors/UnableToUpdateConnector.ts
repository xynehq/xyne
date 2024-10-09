export class UnableToUpdateConnector extends Error {
    constructor() {
        super('Could not update the connector');
    }
}