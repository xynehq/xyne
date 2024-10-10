export class UnableToCompleteSyncJob extends Error {
    constructor(message?:string, id?:any, errorMessage?: string) {
        super(`${message || `Could not successfully complete sync job: ${id} due to ${errorMessage}`}`);
        this.name = 'UnableToCompleteSyncJob';
    }
}