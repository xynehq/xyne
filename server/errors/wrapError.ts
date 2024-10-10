import { WrappedError } from "./wrapper/WrappedErrors";

export function wrapError(CustomError: { new(message: string): Error }, message: string, originalError?: Error): WrappedError {
    const customErrorInstance = new CustomError(message);
    return new WrappedError(customErrorInstance, originalError);
}