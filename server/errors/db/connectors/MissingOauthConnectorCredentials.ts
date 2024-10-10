export class MissingOauthConnectorCredentialsError extends Error {
    constructor(message?: string) {
        super(`${message || 'Severe: OAuth connector credentials are not present'}`);
        this.name = 'MissingOauthConnectorCredentialsError';
    }
}