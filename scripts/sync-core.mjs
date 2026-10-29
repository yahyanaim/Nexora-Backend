#!/usr/bin/env node
/**
 * Builds packages/core/src from the web application's rule files (ARC-03).
 *
 * The rules stay written once, in the web repository. This script copies every
 * pure rule file (and its tests) from `src/lib/workforce`, `src/lib/platform` and
 * `src/lib/errors`, follows their imports, and rewrites `@/…` imports into
 * relative ones so the package stands alone. A file that reaches browser storage,
 * the API layer, React, translations or any package outside the allow-list is
 * left out, and so is every file that imports it.
 *
 *   node scripts/sync-core.mjs <path to Nexora-Saas> [--check]
 *
 * With --check nothing is written: the script exits 1 when packages/core/src
 * differs from what the web repository would produce (CI parity check, ARC-01).
 */
import fs from "node:fs"
import path from "node:path"

const args = process.argv.slice(2)
const check = args.includes("--check")
const webRoot = path.resolve(args.find((a) => !a.startsWith("--")) ?? process.env.WEB_REPO ?? "../Nexora-Saas")
const webSrc = path.join(webRoot, "src")
const outSrc = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../packages/core/src")

if (!fs.existsSync(webSrc)) {
  console.error(`Web repository not found at ${webRoot}`)
  process.exit(2)
}

const SEED_DIRS = ["lib/workforce", "lib/platform", "lib/errors"]
// Demo data and the browser store never enter the package; the server has its own seed (MIG-04).
const EXCLUDED = [/\/demo-store\.ts$/, /-seed\.ts$/, /\/console-data\.ts$/]
const ALLOWED_PACKAGES = new Set(["vitest"])
// The only part of the browser store the rules use: a random id. The package has its own.
const ID_SHIM = { from: /^(\.\/|@\/lib\/workforce\/)demo-store$/, names: ["createId"], to: "lib/id" }
// Hand-written files of the package, kept when the generated tree is rebuilt.
const OWN_FILES = new Set(["lib/id.ts", "lib/id.test.ts"])

const IMPORT_RE = /(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(["'])([^"']+)\2/g

/** Resolves an import of `fromRel` to a path relative to src, or null for a package. */
function resolve(fromRel, spec) {
  let base
  if (spec.startsWith("@/")) base = spec.slice(2)
  else if (spec.startsWith(".")) base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec))
  else return null
  for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
    const full = path.join(webSrc, candidate)
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return candidate
  }
  return { missing: base }
}

const cache = new Map()
/** Reads a source file and lists its imports. */
function parse(rel) {
  if (cache.has(rel)) return cache.get(rel)
  const text = fs.readFileSync(path.join(webSrc, rel), "utf8")
  const imports = [...text.matchAll(IMPORT_RE)].map((m) => m[3])
  const entry = { text, imports }
  cache.set(rel, entry)
  return entry
}

function usesOnlyIdShim(text, spec) {
  const m = text.match(new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*["']${spec.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}["']`))
  if (!m) return false
  return m[1].split(",").map((s) => s.trim()).filter(Boolean).every((n) => ID_SHIM.names.includes(n))
}

const verdict = new Map() // rel -> true (kept) | string (reason it is left out)
function keep(rel, stack = new Set()) {
  if (verdict.has(rel)) return verdict.get(rel)
  if (stack.has(rel)) return true // a cycle is decided by its other edges
  if (!rel.endsWith(".ts") || EXCLUDED.some((re) => re.test(`/${rel}`))) {
    verdict.set(rel, "demo data, browser store or not TypeScript")
    return verdict.get(rel)
  }
  stack.add(rel)
  const { text, imports } = parse(rel)
  for (const spec of imports) {
    if (ID_SHIM.from.test(spec) && usesOnlyIdShim(text, spec)) continue
    const target = resolve(rel, spec)
    if (target === null) {
      if (!ALLOWED_PACKAGES.has(spec)) return set(rel, `imports package "${spec}"`)
      continue
    }
    if (typeof target === "object") return set(rel, `imports missing "${spec}"`)
    const ok = keep(target, stack)
    if (ok !== true) return set(rel, `imports ${target} (${ok})`)
  }
  stack.delete(rel)
  verdict.set(rel, true)
  return true
}
function set(rel, reason) {
  verdict.set(rel, reason)
  return reason
}

function rewrite(rel, text) {
  return text.replace(IMPORT_RE, (all, lead, q, spec) => {
    let target
    if (ID_SHIM.from.test(spec) && usesOnlyIdShim(text, spec)) target = `${ID_SHIM.to}.ts`
    else {
      const r = resolve(rel, spec)
      if (r === null) return all
      target = r
    }
    let out = path.posix.relative(path.posix.dirname(rel), target).replace(/(\/index)?\.ts$/, "")
    if (!out.startsWith(".")) out = `./${out}`
    return `${lead}${q}${out}${q}`
  })
}

// 1. Decide every seed file.
const seeds = SEED_DIRS.flatMap((dir) =>
  fs.readdirSync(path.join(webSrc, dir)).filter((f) => f.endsWith(".ts")).map((f) => `${dir}/${f}`),
)
for (const rel of seeds) keep(rel)

// 2. Build the expected tree: every kept file reached from the seeds.
const expected = new Map()
for (const [rel, ok] of verdict) if (ok === true) expected.set(rel, rewrite(rel, parse(rel).text))

const header = (rel) => `// Generated by scripts/sync-core.mjs from Nexora-Saas src/${rel}. Do not edit: change the web repository and run npm run sync:core.\n`
const files = new Map([...expected].map(([rel, text]) => [rel, header(rel) + text]))

// 3. Compare with or write packages/core/src.
function listOut(dir = outSrc, base = "") {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const rel = base ? `${base}/${d.name}` : d.name
    return d.isDirectory() ? listOut(path.join(dir, d.name), rel) : [rel]
  })
}
const existing = listOut().filter((rel) => !OWN_FILES.has(rel))
const differences = []
for (const [rel, text] of files) {
  const full = path.join(outSrc, rel)
  if (!fs.existsSync(full)) differences.push(`missing  ${rel}`)
  else if (fs.readFileSync(full, "utf8") !== text) differences.push(`changed  ${rel}`)
}
for (const rel of existing) if (!files.has(rel)) differences.push(`extra    ${rel}`)

const left = [...verdict].filter(([rel, ok]) => ok !== true && seeds.includes(rel))
if (check) {
  if (differences.length) {
    console.error(`packages/core differs from the web repository (${differences.length}):`)
    for (const d of differences) console.error(`  ${d}`)
    console.error("Run: npm run sync:core -- <path to Nexora-Saas>")
    process.exit(1)
  }
  console.log(`packages/core matches the web repository: ${files.size} files.`)
} else {
  for (const rel of existing) if (!files.has(rel)) fs.rmSync(path.join(outSrc, rel))
  for (const [rel, text] of files) {
    fs.mkdirSync(path.dirname(path.join(outSrc, rel)), { recursive: true })
    fs.writeFileSync(path.join(outSrc, rel), text)
  }
  console.log(`Wrote ${files.size} files to packages/core/src (${differences.length} changed).`)
  console.log(`Left out ${left.length} seed files:`)
  for (const [rel, why] of left.sort()) console.log(`  ${rel}: ${why}`)
}
