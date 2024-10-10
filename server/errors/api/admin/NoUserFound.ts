export class NoUserFound extends Error {
    constructor(message?: string) {
        super(`Error : ${message || 'Could not get user by the given email'} `);
        this.name = 'NoUserFound';
    }
}