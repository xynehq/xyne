import crypto from "crypto"
import type { CipherGCMTypes } from "crypto"

export class Encryption {
  protected key: string
  protected algo: CipherGCMTypes = "aes-256-gcm"
  protected encoding: BufferEncoding = "base64"
  private encryptionKeyByteLength = 32

  constructor(key: string) {
    this.key = key

    if (
      key &&
      Buffer.from(key, this.encoding).byteLength !==
        this.encryptionKeyByteLength
    ) {
      throw new Error("Encryption key must be base64-encoded and 256-bit long.")
    }
  }

  getKey() {
    return this.key
  }

  public encrypt(str: string): string {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv(
      this.algo,
      Buffer.from(this.key, this.encoding),
      iv,
    )
    let enc = cipher.update(str, "utf8", this.encoding)
    enc += cipher.final(this.encoding)
    const authTag = cipher.getAuthTag().toString(this.encoding)

    return JSON.stringify({
      ciphertext: enc,
      iv: iv.toString(this.encoding),
      authTag: authTag,
    })
  }

  public decrypt(encryptedStr: string): string {
    const { ciphertext, iv, authTag } = JSON.parse(encryptedStr)

    if (!ciphertext || !iv || !authTag) {
      throw new Error("Invalid encrypted string format.")
    }

    const decipher = crypto.createDecipheriv(
      this.algo,
      Buffer.from(this.key, this.encoding),
      Buffer.from(iv, this.encoding),
    )
    decipher.setAuthTag(Buffer.from(authTag, this.encoding))
    let str = decipher.update(ciphertext, this.encoding, "utf8")
    str += decipher.final("utf8")
    return str
  }
  public hashOneWayScrypt(str: string): string {
    // Use a fixed salt derived from the encryption key
    const salt = crypto
      .createHash("sha256")
      .update(this.key + "api_key_salt_scrypt")
      .digest()
      .subarray(0, 32) as crypto.BinaryLike

    // Use scrypt with secure parameters
    const hash = crypto.scryptSync(str, salt, 32, {
      N: 16384, // CPU/memory cost parameter
      r: 8, // Block size parameter
      p: 1, // Parallelization parameter
    })

    return hash.toString(this.encoding)
  }
}
