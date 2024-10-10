export class ErrorRetrievingDocuments extends Error {
    constructor(message?:string, error?:any) {
        super(`${message || `Error retrieving document count:, ${error}`}`);
        this.name = 'ErrorRetrievingDocuments';
    }
}