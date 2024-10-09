export class ErrorRetrievingDocuments extends Error {
    constructor(error:any) {
        super(`Error retrieving document count:, ${error}`);
    }
}