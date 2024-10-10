export class ErrorDeletingDocuments extends Error {
    constructor(message?:string, error?:any) {
        super(`${message || `Error deleting documents:, ${error}`}`);
        this.name = 'ErrorDeletingDocuments';
    }
}