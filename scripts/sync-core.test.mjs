// Tests of scripts/sync-core.mjs (ARC-01, ARC-12): run with `node --test scripts/`.
// Each test builds a small web repository in a temporary folder and a package
// folder of its own (CORE_DIR), so the real packages/core is never touched.
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, test } from "node:test"

const script = path.join(path.dirname(new URL(import.meta.url).pathname), "sync-core.mjs")
let web, core

function write(rel, text) {
  fs.mkdirSync(path.dirname(path.join(web, rel)), { recursive: true })
  fs.writeFileSync(path.join(web, rel), text)
}
function git(...args) {
  return execFileSync("git", ["-C", web, ...args], { encoding: "utf8" }).trim()
}
function commit(message) {
  git("add", "-A")
  git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", message)
  return git("rev-parse", "HEAD")
}
function run(...args) {
  const env = { ...process.env, CORE_DIR: core }
  delete env.GITHUB_STEP_SUMMARY
  const r = spawnSync(process.execPath, [script, web, ...args], { encoding: "utf8", env })
  return { status: r.status, out: r.stdout + r.stderr }
}
const source = () => fs.readFileSync(path.join(core, "SOURCE"), "utf8")

beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sync-core-"))
  web = path.join(tmp, "web")
  core = path.join(tmp, "core")
  fs.mkdirSync(core)
  fs.mkdirSync(web)
  git("init", "-q")
  write("src/lib/workforce/money.ts", "export const round = (n: number) => Math.round(n * 100) / 100\n")
  write("src/lib/platform/plans.ts", 'import { round } from "@/lib/workforce/money"\nexport const price = (n: number) => round(n)\n')
  write("src/lib/errors/codes.ts", 'export const codes = ["err_internal"]\n')
  write("src/lib/workforce/screen.ts", 'import React from "react"\nexport const x = React\n') // left out: imports a package
  write("README.md", "web\n")
})
afterEach(() => fs.rmSync(path.dirname(web), { recursive: true, force: true }))

test("writing records the web commit in SOURCE, and the check at that commit passes", () => {
  const sha = commit("rules")
  const w = run()
  assert.equal(w.status, 0, w.out)
  assert.match(source(), new RegExp(`^commit=${sha}$`, "m"))
  assert.ok(fs.existsSync(path.join(core, "src/lib/platform/plans.ts")))
  assert.ok(!fs.existsSync(path.join(core, "src/lib/workforce/screen.ts")))
  const c = run("--check", "--at-source")
  assert.equal(c.status, 0, c.out)
})

test("a later web commit does not change the check pinned to SOURCE, and a rule change is reported as drift", () => {
  const first = commit("rules")
  assert.equal(run().status, 0)

  write("src/lib/workforce/money.ts", "export const round = (n: number) => Math.round(n)\n")
  commit("change a rule")
  const drift = run("--check")
  assert.equal(drift.status, 1)
  assert.match(drift.out, /changed {2}lib\/workforce\/money\.ts/)

  const pinned = run("--check", "--at-source")
  assert.equal(pinned.status, 1)
  assert.match(pinned.out, new RegExp(`SOURCE records ${first.slice(0, 7)}`))

  git("checkout", "-q", first)
  assert.equal(run("--check", "--at-source").status, 0)
})

test("a web commit that changes no rule is not drift", () => {
  commit("rules")
  assert.equal(run().status, 0)
  write("README.md", "web, with more words\n")
  commit("docs only")
  assert.equal(run("--check").status, 0)
})

test("writing refuses uncommitted rule changes, since SOURCE could not reproduce them", () => {
  commit("rules")
  write("src/lib/errors/codes.ts", 'export const codes = ["err_internal", "err_new"]\n')
  const w = run()
  assert.equal(w.status, 2)
  assert.match(w.out, /uncommitted changes under src\//)
  assert.ok(!fs.existsSync(path.join(core, "SOURCE")))
})

test("the pinned check fails when SOURCE is missing", () => {
  commit("rules")
  const c = run("--check", "--at-source")
  assert.equal(c.status, 1)
  assert.match(c.out, /SOURCE is missing/)
})
