export class ErrorInsertingDocument extends Error {
    constructor(docId:any, data:any) {
        super(`Error inserting document ${docId}:, ${data}`);
    }
}