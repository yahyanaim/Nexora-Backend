import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import type { TotpEngine } from "../ports"

/**
 * Time-based one-time codes (RFC 6238 with HMAC-SHA1, 6 digits, 30-second
 * steps: what every authenticator app reads from an otpauth:// address).
 * A code of the step before or after is accepted for clock drift; the caller
 * stores the step it accepted so that a code is never accepted twice.
 */

const STEP_SECONDS = 30
const DIGITS = 6
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

export function base32Encode(bytes: Buffer): string {
  let bits = 0
  let value = 0
  let out = ""
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/, "").toUpperCase()
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of clean) {
    const index = ALPHABET.indexOf(char)
    if (index < 0) throw new TypeError("Not base32")
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** The code of one step (RFC 4226 dynamic truncation). */
export function hotp(secret: Buffer, counter: number, digits = DIGITS, algorithm = "sha1"): string {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const mac = createHmac(algorithm, secret).update(msg).digest()
  const offset = mac[mac.length - 1]! & 0x0f
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!
  return String(bin % 10 ** digits).padStart(digits, "0")
}

const stepAt = (now: Date) => Math.floor(now.getTime() / 1000 / STEP_SECONDS)

export const totp: TotpEngine = {
  newSecret: () => base32Encode(randomBytes(20)),

  otpauthUrl(secret, account, issuer = "Nexora") {
    const label = encodeURIComponent(`${issuer}:${account}`)
    return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`
  },

  check(secret, code, now, lastStep) {
    if (!/^\d{6}$/.test(code)) return null
    const key = base32Decode(secret)
    const current = stepAt(now)
    for (const step of [current - 1, current, current + 1]) {
      if (step <= lastStep) continue
      const expected = Buffer.from(hotp(key, step))
      if (timingSafeEqual(expected, Buffer.from(code))) return step
    }
    return null
  },
}
