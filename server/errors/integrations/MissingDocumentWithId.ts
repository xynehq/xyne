export class MissingDocumentWithId extends Error {
    constructor(docId: string,e:any) {
        super(`Could not get document ${docId}, probably does not exist, ${e}`);
    }
}