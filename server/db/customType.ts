import { customType } from 'drizzle-orm/pg-core';
import { Encryption } from '@/utils/encryption'; // Adjust the path as necessary


/**
 * Custom type for encrypted text fields using the Encryption class.
 * Stores all encrypted components in a single field separated by a delimiter.
 */
export const encryptedText = (encryption: Encryption) => {
    return customType<{ data: string, notNull: false }>({
        dataType() {
            return 'text';
        },
        /**
         * Transforms the value retrieved from the database.
         * @param value - The concatenated encrypted string from the database.
         * @returns The decrypted plain text.
         */
        fromDriver(value: unknown): string {
            if (typeof value !== 'string') {
                throw new TypeError('Encrypted value must be a string.');
            }
            return encryption.decrypt(value);
        },
        /**
         * Transforms the value before storing it in the database.
         * @param value - The plain text to encrypt.
         * @returns The concatenated encrypted string.
         */
        toDriver(value: string): string {
            return encryption.encrypt(value);
        },
    });
}