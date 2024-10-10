export class UnableToFetchProvider extends Error {
    constructor(message?: string) {
        super(`${message || 'Could not fetch provider while refreshing Google Token'}`);
        this.name = 'UnableToFetchProvider'
    }
}