export class ErrorPerformingSearch extends Error {
    constructor(message?: string, error?:any) {
        super(`${message || `Error performing search:, ${error}`} `);
        this.name = 'ErrorPerformingSearch';
    }
}