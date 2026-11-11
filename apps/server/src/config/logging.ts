/** Log settings shared by the web and worker processes. */
/**
 * What pino removes from every log line (security plan G-6): credentials, and
 * the parts of a database error that can hold personal data (a duplicate
 * e-mail appears in `detail`).
 */
export const LOG_REDACT_PATHS = [
  "req.headers.cookie",
  "req.headers.authorization",
  'req.headers["x-xsrf-token"]',
  "err.detail",
  "err.where",
  "err.parameters",
  "password",
  "*.password",
]

/** Pino options for both processes: level and redaction. */
export function loggerOptions(level: string, service: string) {
  return { level, base: { service }, redact: { paths: LOG_REDACT_PATHS, censor: "[redacted]" } }
}
