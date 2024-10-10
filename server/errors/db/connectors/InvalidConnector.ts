export class InvalidConectionError extends Error {
    constructor(message?:string) { 
        super(`${message || 'Zod error: Invalid connector'}`);
        this.name = 'InvalidConectionError';
    }
}