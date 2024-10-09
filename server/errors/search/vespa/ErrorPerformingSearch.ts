export class ErrorPerformingSearch extends Error {
    constructor(error:any) {
        super(`Error performing search:, ${error} `);
    }
}