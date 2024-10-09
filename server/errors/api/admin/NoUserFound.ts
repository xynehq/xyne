export class NoUserFound extends Error {
    constructor(message?: string) {
        super(message? `Could not get user by the given email : ${message}` : `Could not get user by the given email`);
    }
}