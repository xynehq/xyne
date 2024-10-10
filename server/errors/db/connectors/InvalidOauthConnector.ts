export class InvalidOauthConnectorError extends Error {
    constructor(message?: string) {
        super(`${message || 'Zod error: Invalid OAuth connector'}`);
        this.name = 'InvalidOauthConnectorError';
    }
}