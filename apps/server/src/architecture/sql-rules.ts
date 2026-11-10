/**
 * SQL is never built from strings (SCR-02, security plan G-4). Values reach
 * PostgreSQL only as parameters ($1, $2…). The architecture test runs this check
 * over every source file: a `query(…)` whose SQL is a template literal with
 * `${…}` inside, or a string joined with `+`, fails the build. The few reviewed
 * exceptions are listed below with the reason; each interpolates a value from a
 * closed list in the code, never input.
 */

export interface SqlViolation {
  file: string
  line: number
  snippet: string
}

/** file → the exact text of the reviewed interpolations it may contain. */
export const REVIEWED_INTERPOLATIONS: Record<string, string[]> = {
  // The role comes from DB_ROLES, checked just above; SET ROLE cannot take a parameter.
  "db/session.ts": ["SET LOCAL ROLE ${ctx.role}"],
}

const isTest = (file: string) => /\.test\.ts$/.test(file) || file.split("/").includes("testing")

/** The first argument of each `.query(` call, when it is a string or template literal. */
function queryArguments(text: string): Array<{ index: number; quote: string; body: string; after: string }> {
  const out: Array<{ index: number; quote: string; body: string; after: string }> = []
  const re = /\.query\s*(?:<[^>(]*>)?\s*\(\s*/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = m.index + m[0].length
    const quote = text[start]
    if (quote !== "`" && quote !== '"' && quote !== "'") continue
    let i = start + 1
    while (i < text.length && text[i] !== quote) i += text[i] === "\\" ? 2 : 1
    out.push({ index: m.index, quote, body: text.slice(start + 1, i), after: text.slice(i + 1, i + 40).trimStart() })
  }
  return out
}

/** Checks source files (path relative to src → content) and lists every SQL built from strings. */
export function checkSqlStrings(files: Map<string, string>): SqlViolation[] {
  const violations: SqlViolation[] = []
  for (const [file, text] of files) {
    if (isTest(file)) continue
    for (const arg of queryArguments(text)) {
      const interpolated = arg.quote === "`" && arg.body.includes("${")
      const joined = arg.after.startsWith("+")
      if (!interpolated && !joined) continue
      if (interpolated && !joined && (REVIEWED_INTERPOLATIONS[file] ?? []).includes(arg.body.trim())) continue
      const line = text.slice(0, arg.index).split("\n").length
      violations.push({ file, line, snippet: arg.body.trim().slice(0, 80) })
    }
  }
  return violations
}
