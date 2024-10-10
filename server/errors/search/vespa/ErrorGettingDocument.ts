export class ErrorGettingDocument extends Error {
    constructor(message?: any, docId?: any, error?:any){
        super(`${message || `Error fetching document ${docId}:  ${error.message}`}`);
        this.name = 'ErrorGettingDocument';
    }
}