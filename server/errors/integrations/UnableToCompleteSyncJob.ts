export class UnableToCompleteSyncJob extends Error {
    constructor(id:any, errorMessage: string) {
        super(`Could not successfully complete sync job: ${id} due to ${errorMessage}`);
    }
}