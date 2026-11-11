import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { LeakedPasswordList } from "../ports"

/**
 * The leaked-password list of IAM-03, read from apps/server/data (see its
 * README for the source and how it was built). Entries are lower case, like
 * the normalised password they are compared with.
 */
const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../data/breached-passwords.txt")

export function loadLeakedList(file = FILE): LeakedPasswordList {
  const entries = new Set(fs.readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter(Boolean))
  return { has: (normalized) => entries.has(normalized) }
}

let shared: LeakedPasswordList | null = null

/** The shared list, read once at first use. */
export const leakedPasswords: LeakedPasswordList = {
  has: (normalized) => (shared ??= loadLeakedList()).has(normalized),
}
