export class CouldNotFinishJobSuccessfully extends Error {
    constructor(message?:string) {
        super(`${message || 'Could not finish job successfully'}`);
        this.name = 'CouldNotFinishJobSuccessfully';
    }
}