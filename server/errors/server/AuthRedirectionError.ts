export class AuthRedirectError extends Error {
    constructor(message?:string) {
        super(`${message || 'Auth Redirecting Error : Error while auth redirection'}`);
        this.name = 'AUthRedirectingError';
    }   
}