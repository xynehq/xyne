export class NoOauthConnectorFound extends Error {
    constructor(id:any) {
        super(`Could not get the oauth connector with the given id : ${id}`);
    }
}