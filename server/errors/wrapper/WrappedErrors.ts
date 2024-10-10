export class WrappedError extends Error {
    private errors: Error[];

    constructor(customError: Error, originalError?: Error) {
        super(customError.message);
        this.name = customError.name;
        this.errors = [customError];

        if (originalError instanceof WrappedError) {
            this.errors = this.errors.concat(originalError.getErrors());
        } else if (originalError) {
            this.errors.push(originalError);
        }
    }

    getErrors(): Error[] {
        return this.errors;
    }

    getFullTrace(): string {
        return this.errors.map((error, index) => {
            return `Error ${index + 1}: ${error.name}: ${error.message}\n${error.stack}`;
        }).join('\n\n');
    }
}