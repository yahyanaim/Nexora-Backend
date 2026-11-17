import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto"
import type { SecretBox } from "../ports"

/**
 * Application-level encryption of stored secrets (SCR-07): AES-256-GCM with a
 * random 96-bit nonce per value, written `v1.<nonce>.<ciphertext>.<tag>` in
 * base64url. The key is derived with HKDF from the configured secret and a
 * purpose, so each kind of secret has its own key.
 */
export function aesGcmBox(secret: string, purpose: string): SecretBox {
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.alloc(0), Buffer.from(`nexora:${purpose}`, "utf8"), 32))
  return {
    seal(plain) {
      const nonce = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", key, nonce)
      const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
      return ["v1", nonce.toString("base64url"), body.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".")
    },
    open(sealed) {
      const [version, nonce, body, tag] = sealed.split(".")
      if (version !== "v1" || !nonce || !body || !tag) throw new TypeError("Unknown sealed value")
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"))
      decipher.setAuthTag(Buffer.from(tag, "base64url"))
      return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8")
    },
  }
}
