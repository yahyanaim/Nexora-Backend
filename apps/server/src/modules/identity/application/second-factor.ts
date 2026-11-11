import { isPasscodeShape, isRecoveryCodeShape, normalizeRecoveryCode, RECOVERY_CODE_COUNT } from "../domain/second-factor"
import type { Clock, IdentityStore, IdentityTransactions, PasswordHasher, RateLimiter, SecretBox, SecretTokens, TotpEngine } from "../ports"
import { type ClientInfo, SECOND_FACTOR_FAILURES_PER_PERSON, SIGN_IN_WINDOW_SECONDS, type SessionContext } from "./auth"

/**
 * Managing one's second factor and lock-screen passcode (cahier §8; IAM-05,
 * IAM-06, IAM-16, IAM-18). The TOTP secret is stored encrypted (SCR-07) and
 * shown once, as an otpauth address; recovery codes are shown once and kept as
 * SHA-256. Every change is written to the identity trail.
 */

export type SecondFactorRefusal = "already_enabled" | "not_set_up" | "invalid_code" | "required" | "invalid_password" | "bad_passcode" | "rate_limited"

export class SecondFactorError extends Error {
  constructor(readonly code: SecondFactorRefusal) {
    super(code)
    this.name = "SecondFactorError"
  }
}

export interface SecondFactorService {
  status(session: SessionContext): Promise<{ enabled: boolean; recoveryCodesLeft: number; passcodeSet: boolean }>
  /** Starts (or restarts) a set-up: a new secret, shown once as an otpauth address. */
  setup(session: SessionContext, client: ClientInfo): Promise<{ otpauthUrl: string }>
  /**
   * Confirms the set-up with a first code and the account password (a stolen
   * session alone cannot tie the account to someone else's app); answers the
   * ten recovery codes, shown once.
   */
  enable(session: SessionContext, input: { code: string; password: string }, client: ClientInfo): Promise<{ recoveryCodes: string[] }>
  /** `required` is decided by the caller from the person's memberships (owners, administrators, accountants). */
  disable(session: SessionContext, input: { password: string; code: string; required: boolean }, client: ClientInfo): Promise<void>
  regenerateCodes(session: SessionContext, code: string, client: ClientInfo): Promise<{ recoveryCodes: string[] }>
  /** A fresh code from the app (not a recovery code) marks the session for sensitive actions (IAM-06). */
  stepUp(session: SessionContext, code: string, client: ClientInfo): Promise<void>
  setPasscode(session: SessionContext, input: { passcode: string; password: string }, client: ClientInfo): Promise<void>
  removePasscode(session: SessionContext, client: ClientInfo): Promise<void>
}

export function secondFactorService(deps: {
  tx: IdentityTransactions
  hasher: PasswordHasher
  limiter: RateLimiter
  tokens: SecretTokens
  totp: TotpEngine
  box: SecretBox
  clock: Clock
}): SecondFactorService {
  const { tx, hasher, limiter, tokens, totp, box, clock } = deps
  const bucket = (principalId: string) => `second_factor:person:${principalId}`
  const audit = (s: IdentityStore, session: SessionContext, action: string, client: ClientInfo) =>
    s.audit({ action, realm: session.realm, principalId: session.principalId, sessionId: session.sessionId, ...client })

  /** Ten codes of 10 base32 characters (50 bits), written `xxxxx-xxxxx`. */
  function newCodes() {
    return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
      const raw = tokens.generate().toLowerCase().replace(/[^a-z2-7]/g, "").slice(0, 10).padEnd(10, "a")
      return `${raw.slice(0, 5)}-${raw.slice(5)}`
    })
  }

  /** Too many wrong codes for this person: refused before any check. */
  async function notLimited(principalId: string) {
    const { hits } = await limiter.count(bucket(principalId), SIGN_IN_WINDOW_SECONDS)
    if (hits >= SECOND_FACTOR_FAILURES_PER_PERSON) throw new SecondFactorError("rate_limited")
  }

  /**
   * Checks an app code (and a recovery code when allowed) inside the
   * transaction; a wrong one is audited, counted, and the transaction still
   * commits the audit before the refusal is thrown.
   */
  async function checkCode(session: SessionContext, code: string, opts: { allowRecovery: boolean; client: ClientInfo }) {
    await notLimited(session.principalId)
    const now = clock.now()
    const failed = await tx.run(async (s) => {
      const factor = await s.secondFactorOf(session.principalId)
      if (!factor?.enabledAt) throw new SecondFactorError("not_set_up")
      const step = totp.check(box.open(factor.secretEnc), code, now, factor.lastStep)
      if (step !== null) {
        await s.acceptStep(session.principalId, step)
        return false
      }
      if (opts.allowRecovery && isRecoveryCodeShape(code) && (await s.useRecoveryCode(session.principalId, tokens.hash(normalizeRecoveryCode(code)), now))) {
        await audit(s, session, "two_factor.recovery_used", opts.client)
        return false
      }
      await audit(s, session, "two_factor.failed", opts.client)
      return true
    })
    if (failed) {
      await limiter.hit(bucket(session.principalId), SIGN_IN_WINDOW_SECONDS)
      throw new SecondFactorError("invalid_code")
    }
  }

  return {
    async status(session) {
      return tx.run(async (s) => {
        const factor = await s.secondFactorOf(session.principalId)
        return {
          enabled: !!factor?.enabledAt,
          recoveryCodesLeft: factor?.enabledAt ? await s.remainingRecoveryCodes(session.principalId) : 0,
          passcodeSet: !!(await s.passcodeOf(session.principalId)),
        }
      })
    },

    async setup(session, client) {
      const secret = totp.newSecret()
      await tx.run(async (s) => {
        const factor = await s.secondFactorOf(session.principalId)
        if (factor?.enabledAt) throw new SecondFactorError("already_enabled")
        await s.saveSecondFactorSetup(session.principalId, box.seal(secret))
        await audit(s, session, "two_factor.setup_started", client)
      })
      return { otpauthUrl: totp.otpauthUrl(secret, session.user.email) }
    },

    async enable(session, input, client) {
      await notLimited(session.principalId)
      const user = await tx.run((s) => s.userById(session.principalId))
      if (!user?.passwordHash || !(await hasher.verify(user.passwordHash, input.password))) {
        await tx.run((s) => audit(s, session, "two_factor.enable_refused", client))
        throw new SecondFactorError("invalid_password")
      }
      const code = input.code
      const now = clock.now()
      const codes = newCodes()
      const ok = await tx.run(async (s) => {
        const factor = await s.secondFactorOf(session.principalId)
        if (!factor) throw new SecondFactorError("not_set_up")
        if (factor.enabledAt) throw new SecondFactorError("already_enabled")
        const step = totp.check(box.open(factor.secretEnc), code, now, factor.lastStep)
        if (step === null) {
          await audit(s, session, "two_factor.failed", client)
          return false
        }
        await s.enableSecondFactor(session.principalId, now, step)
        await s.replaceRecoveryCodes(session.principalId, codes.map((c) => tokens.hash(normalizeRecoveryCode(c))))
        // Enabling it proves the factor now: the session counts as freshly confirmed.
        await s.markSecondFactor(session.sessionId, now)
        await audit(s, session, "two_factor.enabled", client)
        return true
      })
      if (!ok) {
        await limiter.hit(bucket(session.principalId), SIGN_IN_WINDOW_SECONDS)
        throw new SecondFactorError("invalid_code")
      }
      return { recoveryCodes: codes }
    },

    async disable(session, input, client) {
      if (input.required) throw new SecondFactorError("required")
      const user = await tx.run((s) => s.userById(session.principalId))
      if (!user?.passwordHash || !(await hasher.verify(user.passwordHash, input.password))) {
        await tx.run((s) => audit(s, session, "two_factor.disable_refused", client))
        throw new SecondFactorError("invalid_password")
      }
      await checkCode(session, input.code, { allowRecovery: true, client })
      await tx.run(async (s) => {
        await s.deleteSecondFactor(session.principalId)
        await audit(s, session, "two_factor.disabled", client)
      })
    },

    async regenerateCodes(session, code, client) {
      await checkCode(session, code, { allowRecovery: false, client })
      const codes = newCodes()
      await tx.run(async (s) => {
        await s.replaceRecoveryCodes(session.principalId, codes.map((c) => tokens.hash(normalizeRecoveryCode(c))))
        await audit(s, session, "two_factor.codes_renewed", client)
      })
      return { recoveryCodes: codes }
    },

    async stepUp(session, code, client) {
      await checkCode(session, code, { allowRecovery: false, client })
      await tx.run(async (s) => {
        await s.markSecondFactor(session.sessionId, clock.now())
        await audit(s, session, "step_up.succeeded", client)
      })
    },

    async setPasscode(session, input, client) {
      if (!isPasscodeShape(input.passcode)) throw new SecondFactorError("bad_passcode")
      const user = await tx.run((s) => s.userById(session.principalId))
      if (!user?.passwordHash || !(await hasher.verify(user.passwordHash, input.password))) throw new SecondFactorError("invalid_password")
      const hash = await hasher.hash(input.passcode)
      await tx.run(async (s) => {
        await s.savePasscode(session.principalId, hash)
        await audit(s, session, "passcode.set", client)
      })
    },

    async removePasscode(session, client) {
      await tx.run(async (s) => {
        await s.deletePasscode(session.principalId)
        await audit(s, session, "passcode.removed", client)
      })
    },
  }
}
