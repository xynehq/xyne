export class ConnectionInsertionError extends Error {
    constructor(err:any) {
        super(`Could not insert connection : ${err}`);
    }
}