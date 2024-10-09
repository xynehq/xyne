export class InvalidOauthConnectorError extends Error {
    constructor(err?:any | "") {
        super(`Zod error: Invalid OAuth connector:  ${err}`);
    }
}