export class NoConnectorsFound extends Error {
    constructor(id:any) {
        super(`Could not get the connector with the given id : ${id}`);
    }
}