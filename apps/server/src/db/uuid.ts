import { randomBytes } from "node:crypto"

/**
 * UUID version 7 (RFC 9562): 48-bit Unix milliseconds, then random bits, so
 * ids are time-ordered (index-friendly) and reveal no counts (DAT-03).
 * Within one millisecond a counter keeps ids increasing.
 */
let lastMs = -1
let counter = 0

export function uuidv7(now = Date.now()): string {
  if (now <= lastMs) {
    now = lastMs
    counter = (counter + 1) & 0xfff
    if (counter === 0) now = ++lastMs // 4,096 ids in one millisecond: borrow the next one
  } else {
    counter = randomBytes(2).readUInt16BE() & 0x7ff // random start, room to count up
  }
  lastMs = now
  const bytes = randomBytes(16)
  bytes.writeUIntBE(now, 0, 6)
  bytes[6] = 0x70 | (counter >> 8) // version 7 + 4 high bits of the counter
  bytes[7] = counter & 0xff
  bytes[8] = 0x80 | (bytes[8]! & 0x3f) // RFC 9562 variant
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
