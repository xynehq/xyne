export class OAuthCallbackError extends Error {
    constructor(err:any) {
        super(`Error while executing oauth callback : \n , ${err}`);
    }   
}