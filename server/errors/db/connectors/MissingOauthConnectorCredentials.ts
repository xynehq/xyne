export class MissingOauthConnectorCredentialsError extends Error {
    constructor() {
        super('Severe: OAuth connector credentials are not present');
    }
}