export class InitialisationError extends Error {
    constructor(message?:string) {
        super(`${message || 'Error while initialising the server'}`);
    }   
}