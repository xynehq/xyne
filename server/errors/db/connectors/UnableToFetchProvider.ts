export class UnableToFetchProvider extends Error {
    constructor() {
        super( "Could not fetch provider while refreshing Google Token");
    }
}