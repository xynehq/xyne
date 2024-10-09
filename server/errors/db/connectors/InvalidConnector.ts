export class InvalidConectionError extends Error {
    constructor(err?:any | "") {
        super(`Zod error: Invalid connector : ${err}`);
    }
}