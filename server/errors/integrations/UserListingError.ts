export class UserListingError extends Error {
    constructor(err ?: any){
        super(`Error listing users: ${err}`);
    }
}
