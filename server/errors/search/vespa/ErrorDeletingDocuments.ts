export class ErrorDeletingDocuments extends Error {
    constructor(error:any) {
        super(`Error deleting documents:, ${error}`);
    }
}