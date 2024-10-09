export class ErrorGettingDocument extends Error {
    constructor(docId: any, error:any){
        super(`Error fetching document ${docId}:  ${error.message}`);
    }
}