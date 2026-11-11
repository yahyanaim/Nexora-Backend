/**
 * What the identity application needs from the outside world. The
 * infrastructure folder implements each port; tests may pass fakes.
 */

/** Argon2id hashing of passwords (IAM-02). */
export interface PasswordHasher {
  hash(password: string): Promise<string>
  /** False for a wrong password and for a hash it cannot read; never throws on input. */
  verify(hash: string, password: string): Promise<boolean>
  /** True when the stored hash should be replaced at the next successful sign-in (other algorithm or weaker settings). */
  needsRehash(hash: string): boolean
}

/** The list of leaked passwords, compared in normalised form (see normalizeForLeakCheck). */
export interface LeakedPasswordList {
  has(normalized: string): boolean
}

/** Single-use and session secrets (IAM-10). */
export interface SecretTokens {
  /** A new random secret of at least 256 bits, URL-safe. */
  generate(): string
  /** The form stored in the database: SHA-256, hex. */
  hash(token: string): string
}
