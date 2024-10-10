export class MissingDocumentWithId extends Error {
    constructor(message?:any, docId?: string) {
        super(`${message  || `Could not get document ${docId}, probably does not exist`}`);
    }
}