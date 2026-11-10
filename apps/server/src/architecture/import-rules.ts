import path from "node:path"

/**
 * The import rules of the server (ARC-02, ARC-06, ADR-001). The architecture
 * test runs them over every source file; a forbidden import fails the build.
 *
 * Platform folders (built in B1a):
 *   config   reads the environment; imports no other server folder
 *   db       database access; never HTTP, jobs or the worker
 *   http     the web layer; never `pg`, jobs or the worker
 *   jobs, worker   background work; never HTTP or Express
 *   main.ts, worker-main.ts   composition roots: may import anything
 *
 * Business modules (from B1c) live in `modules/<name>/` with four layers:
 *   domain          pure rules: its own domain, `@nexora/core`, `zod`; nothing else
 *   ports           interfaces the application needs: domain and ports
 *   application     use cases: domain, ports, application, the database session and unit of work; no Express or `pg`
 *   infrastructure  implements the ports: anything except HTTP
 * A module reaches another module only through its public interface,
 * `modules/<other>/application/index.ts`; everything else goes through the outbox (ARC-06).
 *
 * Tests and `testing/` folders may import anything; production code never imports them.
 */

export interface Violation {
  file: string
  specifier: string
  rule: string
}

const IMPORT_RE = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(["'])([^"']+)\1/g

/** Every module specifier a TypeScript file imports or re-exports. */
export function importsOf(text: string): string[] {
  return [...text.matchAll(IMPORT_RE)].map((m) => m[2] ?? "")
}

const isTest = (file: string) => /\.test\.ts$/.test(file) || file.split("/").includes("testing")
const PLATFORM = ["config", "db", "http", "jobs", "worker", "architecture"] as const
const ROOTS = new Set(["main.ts", "worker-main.ts"])
const LAYERS = ["domain", "ports", "application", "infrastructure"] as const
type Layer = (typeof LAYERS)[number]

interface Place {
  kind: "root" | "platform" | "module" | "test" | "other"
  folder?: string
  module?: string
  layer?: Layer
}

/** Where a file (path relative to `src`, without extension for imports) sits. */
function placeOf(rel: string): Place {
  if (isTest(rel)) return { kind: "test" }
  const [first = "", second = "", third = ""] = rel.split("/")
  const depth = rel.split("/").length
  if (depth === 1 && (ROOTS.has(first) || ROOTS.has(`${first}.ts`))) return { kind: "root" }
  if (first === "modules" && depth >= 3 && (LAYERS as readonly string[]).includes(third)) {
    return { kind: "module", module: second, layer: third as Layer }
  }
  if ((PLATFORM as readonly string[]).includes(first)) return { kind: "platform", folder: first }
  return { kind: "other" }
}

/** Resolves a relative specifier of `file` to a path relative to src (no extension), or null for a package. */
function target(file: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null
  const to = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)).replace(/\.(ts|js)$/, "")
  // a module's public interface is a folder import: modules/<name>/application means its index.ts
  return /^modules\/[^/]+\/application$/.test(to) ? `${to}/index` : to
}

const packageName = (spec: string) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : (spec.split("/")[0] ?? spec))

/** Packages each place may import; `node:*` is listed per place. */
const PACKAGES: Record<string, { allow: Set<string>; node: boolean }> = {
  domain: { allow: new Set(["@nexora/core", "zod"]), node: false },
  ports: { allow: new Set(["@nexora/core", "zod"]), node: false },
  application: { allow: new Set(["@nexora/core", "zod"]), node: false },
  config: { allow: new Set(["zod"]), node: true },
  db: { allow: new Set(["pg", "@nexora/core", "zod"]), node: true },
  http: { allow: new Set(["express", "pino", "zod", "@nexora/core"]), node: true },
  jobs: { allow: new Set(["pg", "pino", "zod", "@nexora/core"]), node: true },
  worker: { allow: new Set(["pg", "pino", "zod", "@nexora/core"]), node: true },
}

/** Platform folders each platform folder may import. */
const PLATFORM_DEPS: Record<string, Set<string>> = {
  config: new Set(["config"]),
  db: new Set(["db", "config"]),
  http: new Set(["http", "config"]),
  jobs: new Set(["jobs", "db", "worker", "config"]),
  worker: new Set(["worker", "jobs", "db", "config"]),
  architecture: new Set(["architecture"]),
}

/** The application layer may use the transaction helpers, which carry no SQL client of their own. */
const APPLICATION_PLATFORM = new Set(["db/session", "db/unit-of-work", "db/uuid"])

function checkPackage(place: Place, spec: string): string | null {
  const key = place.kind === "module" ? place.layer! : place.folder!
  const rules = PACKAGES[key]
  if (!rules) return null // infrastructure and architecture: any package
  if (spec.startsWith("node:")) return rules.node ? null : `${key} code uses no Node API`
  return rules.allow.has(packageName(spec)) ? null : `${key} code may not import the package "${packageName(spec)}"`
}

function checkInternal(place: Place, to: string): string | null {
  if (to.startsWith("..")) return "imports outside src (use the package name, e.g. @nexora/core)"
  const dest = placeOf(to)
  if (dest.kind === "test") return "production code imports a test or testing helper"
  if (dest.kind === "root") return "nothing imports an entry point"
  if (place.kind === "root") return null

  if (place.kind === "platform") {
    if (dest.kind === "module") {
      if (place.folder === "http" || place.folder === "jobs" || place.folder === "worker") {
        return dest.layer === "application" && to === `modules/${dest.module}/application/index` ? null : `${place.folder} reaches a module only through modules/${dest.module}/application/index.ts`
      }
      return `${place.folder} may not import business modules`
    }
    if (dest.kind === "platform") return PLATFORM_DEPS[place.folder!]?.has(dest.folder!) ? null : `${place.folder} may not import ${dest.folder}`
    return null
  }

  if (place.kind === "module") {
    if (dest.kind === "module" && dest.module !== place.module) {
      return to === `modules/${dest.module}/application/index` && place.layer !== "domain" && place.layer !== "ports"
        ? null
        : `module ${place.module} reaches module ${dest.module} only through modules/${dest.module}/application/index.ts (ARC-06)`
    }
    if (dest.kind === "module") {
      const allowed: Record<Layer, Layer[]> = {
        domain: ["domain"],
        ports: ["domain", "ports"],
        application: ["domain", "ports", "application"],
        infrastructure: ["domain", "ports", "application", "infrastructure"],
      }
      return allowed[place.layer!].includes(dest.layer!) ? null : `${place.layer} may not import ${dest.layer} (ARC-02)`
    }
    if (dest.kind === "platform") {
      if (place.layer === "infrastructure") return dest.folder === "http" ? "infrastructure may not import http" : null
      if (place.layer === "application" && APPLICATION_PLATFORM.has(to)) return null
      return `${place.layer} may not import ${to} (ARC-02)`
    }
    return null
  }
  return null
}

/** Checks a set of source files (path relative to src → content) and lists every forbidden import. */
export function checkImportRules(files: Map<string, string>): Violation[] {
  const violations: Violation[] = []
  for (const [file, text] of files) {
    const place = placeOf(file)
    if (place.kind === "test") continue
    if (place.kind === "other") {
      violations.push({ file, specifier: "", rule: "file outside the known folders: place it in a platform folder or a module layer, or add its folder to the import rules" })
      continue
    }
    for (const specifier of importsOf(text)) {
      const to = target(file, specifier)
      const rule = to === null ? (place.kind === "platform" || place.kind === "module" ? checkPackage(place, specifier) : null) : checkInternal(place, to)
      if (rule) violations.push({ file, specifier, rule })
    }
  }
  return violations
}
