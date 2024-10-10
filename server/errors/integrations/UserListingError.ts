export class UserListingError extends Error {
    constructor(message?:any, err ?: any){
        super(`${message || `Error listing users: ${err}`}`);
        this.name = 'UserListingError';
    }
}
