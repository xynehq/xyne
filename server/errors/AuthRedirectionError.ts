export class AuthRedirectError extends Error {
    constructor() {
        super('Auth Redirecting Error : Error while auth redirection');
    }   
}