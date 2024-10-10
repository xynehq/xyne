export class NoOauthConnectorFound extends Error {
    constructor(message?:string, id?:any) {
        super(`${message || `Could not get the oauth connector with the given id : ${id}`}`);
        this.name = 'NoOauthConnectorFound';
    }
}