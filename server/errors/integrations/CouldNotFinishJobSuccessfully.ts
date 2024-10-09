export class CouldNotFinishJobSuccessfully extends Error {
    constructor(e:any) {
        super(`Could not finish job successfully', ${e}`);
    }
}