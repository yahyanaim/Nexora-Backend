import { z } from "zod"

/**
 * The only place that reads environment variables (ARC-04). Boot fails with a
 * clear message when a value is missing or, in production, when a secret is
 * missing, left at an example value or too short.
 */
const WEAK = /^(change[-_]?me|secret|password|example|test|dev)/i

const secret = (name: string) =>
  z
    .string({ error: `${name} is required` })
    .min(32, `${name} must be at least 32 characters`)
    .refine((v) => !WEAK.test(v), `${name} is still an example value`)

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    APP_ORIGIN: z.url().default("http://localhost:3000"),
    SESSION_SECRET: z.string().optional(),
    /** The web or worker login user (NOINHERIT member of the nx_* group roles). */
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "DATABASE_URL must be a postgres:// URL").optional(),
    /** nx_owner, used only by the migration step. */
    MIGRATION_DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "MIGRATION_DATABASE_URL must be a postgres:// URL").optional(),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(20).default(10), // QAL-06: at most 20 per process
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") return
    const check = secret("SESSION_SECRET").safeParse(env.SESSION_SECRET)
    if (!check.success) for (const issue of check.error.issues) ctx.addIssue({ code: "custom", path: ["SESSION_SECRET"], message: issue.message })
    if (!env.APP_ORIGIN.startsWith("https://")) ctx.addIssue({ code: "custom", path: ["APP_ORIGIN"], message: "APP_ORIGIN must use https in production" })
    if (!env.DATABASE_URL) ctx.addIssue({ code: "custom", path: ["DATABASE_URL"], message: "DATABASE_URL is required in production" })
  })

export type Config = z.infer<typeof schema>

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`)
    this.name = "ConfigError"
  }
}

/** Reads and checks the configuration once; throws ConfigError listing every problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Readonly<Config> {
  const parsed = schema.safeParse(env)
  if (!parsed.success) throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`))
  return Object.freeze(parsed.data)
}
