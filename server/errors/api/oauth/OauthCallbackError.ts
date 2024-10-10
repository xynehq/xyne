export class OAuthCallbackError extends Error {
    constructor(message?: string) {
        super(`${message || 'Error while executing oauth callback'}`);
        this.name = 'OAuthCallbackError';
    }   
}