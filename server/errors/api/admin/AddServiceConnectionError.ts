export class AddServiceConnectionError extends Error {
    constructor(message?: string) {
        super(`Error : ${message || 'While adding service connection'}`);
        this.name = 'AddServiceConnectionError';
    }   
}