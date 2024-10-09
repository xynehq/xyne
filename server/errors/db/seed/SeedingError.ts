export class SeedingError extends Error {
    constructor(err:any) {
        super(`Error during seeding : \n`, err);
    }
}