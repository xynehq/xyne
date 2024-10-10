export class ErrorUpdatingDocument extends Error {
    constructor(message?:string, docId?:any, error?:any) {
        super(`${message || `Error fetching document ${docId}:  ${error.message}`}`);
        this.name = 'ErrorUpdatingDocument'
    }
}