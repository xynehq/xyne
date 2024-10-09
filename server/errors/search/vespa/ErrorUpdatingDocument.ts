export class ErrorUpdatingDocument extends Error {
    constructor(docId:any, error:any) {
        super(`Error fetching document ${docId}:  ${error.message}`);
    }
}