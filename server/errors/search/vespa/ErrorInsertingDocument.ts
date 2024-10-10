export class ErrorInsertingDocument extends Error {
    constructor(message?: string, docId?:any, data?:any) {
        super(`${message || `Error inserting document ${docId}:, ${data}`}`);
        this.name = 'ErrorInsertingDocument';
    }
}