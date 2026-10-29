// Hand-written: the only part of the web application's browser store the rules use.
// `crypto.randomUUID` exists in browsers and in Node 19+, so the package needs neither DOM nor Node types.
declare const crypto: { randomUUID(): string }

/** Prefixed ids with a full UUID, the same shape as the web application's (`client_3f2a…`). */
export function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`
}
