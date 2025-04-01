import crypto from "crypto";
export class Encryption {
    key;
    algo = "aes-256-gcm";
    encoding = "base64";
    encryptionKeyByteLength = 32;
    constructor(key) {
        this.key = key;
        if (key &&
            Buffer.from(key, this.encoding).byteLength !==
                this.encryptionKeyByteLength) {
            throw new Error("Encryption key must be base64-encoded and 256-bit long.");
        }
    }
    getKey() {
        return this.key;
    }
    encrypt(str) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv(this.algo, Buffer.from(this.key, this.encoding), iv);
        let enc = cipher.update(str, "utf8", this.encoding);
        enc += cipher.final(this.encoding);
        const authTag = cipher.getAuthTag().toString(this.encoding);
        return JSON.stringify({
            ciphertext: enc,
            iv: iv.toString(this.encoding),
            authTag: authTag,
        });
    }
    decrypt(encryptedStr) {
        const { ciphertext, iv, authTag } = JSON.parse(encryptedStr);
        if (!ciphertext || !iv || !authTag) {
            throw new Error("Invalid encrypted string format.");
        }
        const decipher = crypto.createDecipheriv(this.algo, Buffer.from(this.key, this.encoding), Buffer.from(iv, this.encoding));
        decipher.setAuthTag(Buffer.from(authTag, this.encoding));
        let str = decipher.update(ciphertext, this.encoding, "utf8");
        str += decipher.final("utf8");
        return str;
    }
}
