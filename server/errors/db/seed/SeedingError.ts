export class SeedingError extends Error {
    constructor(message?:string) {
        super(`${message || 'Error during seeding'}`);
        this.name = 'SeedingError';
    }
}