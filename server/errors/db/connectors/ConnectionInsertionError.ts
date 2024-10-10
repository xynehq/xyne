export class ConnectionInsertionError extends Error {
    constructor(message?:string) {
        super(`${message || 'Could not insert connection'}`);
        this.name = 'ConnectionInsertionError';
    }
}