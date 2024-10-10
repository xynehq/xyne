export class NoConnectorsFound extends Error {
    constructor(message?:string, id?:any) {
        super(`${message || `Could not get the connector with the given id : ${id}`}`);
        this.name = 'NoConnectorsFound';
    }
}