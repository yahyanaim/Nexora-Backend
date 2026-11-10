import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { checkImportRules, importsOf } from "./import-rules"

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function sourceFiles(dir = SRC): Map<string, string> {
  const out = new Map<string, string>()
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) for (const [k, v] of sourceFiles(full)) out.set(k, v)
    else if (entry.name.endsWith(".ts")) out.set(path.relative(SRC, full).split(path.sep).join("/"), fs.readFileSync(full, "utf8"))
  }
  return out
}

/** One synthetic file, checked alone. */
const check = (file: string, text: string) => checkImportRules(new Map([[file, text]]))
/** The rule broken by the first forbidden import of that file. */
const rule = (file: string, text: string) => check(file, text)[0]?.rule

describe("import rules (ARC-02, ARC-06)", () => {
  it("the server's own source has no forbidden import", () => {
    const files = sourceFiles()
    expect(files.size).toBeGreaterThan(20)
    expect(checkImportRules(files)).toEqual([])
  })

  it("reads every form of import and re-export", () => {
    const text = `import a from "a"\nimport type { B } from "b"\nimport "c"\nexport { d } from "d"\nexport * from "e"\nconst f = await import("f")`
    expect(importsOf(text)).toEqual(["a", "b", "c", "d", "e", "f"])
  })

  it("refuses a domain file that imports Express, pg, Node or infrastructure", () => {
    const f = "modules/relations/domain/client.ts"
    expect(rule(f, `import express from "express"`)).toMatch(/domain code may not import the package "express"/)
    expect(rule(f, `import type pg from "pg"`)).toMatch(/"pg"/)
    expect(rule(f, `import fs from "node:fs"`)).toMatch(/no Node API/)
    expect(rule(f, `import { repo } from "../infrastructure/client-repo"`)).toMatch(/domain may not import infrastructure/)
    expect(rule(f, `import { pool } from "../../../db/pool"`)).toMatch(/domain may not import db\/pool/)
    expect(check(f, `import { money } from "@nexora/core/lib/workforce/money"\nimport { z } from "zod"\nimport { rule } from "./rule"`)).toEqual([])
  })

  it("refuses an application file that imports Express, pg or infrastructure, and allows the unit of work", () => {
    const f = "modules/work/application/create-project.ts"
    expect(check(f, `import type { Request } from "express"`)).toHaveLength(1)
    expect(rule(f, `import { repo } from "../infrastructure/project-repo"`)).toMatch(/application may not import infrastructure/)
    expect(rule(f, `import { pool } from "../../../db/pool"`)).toMatch(/application may not import db\/pool/)
    expect(check(f, `import { runCommand } from "../../../db/unit-of-work"\nimport type { ProjectRepo } from "../ports/project-repo"`)).toEqual([])
  })

  it("lets one module reach another only through its public interface (ARC-06)", () => {
    const f = "modules/time/application/submit.ts"
    expect(check(f, `import { findProject } from "../../work/application/index"`)).toEqual([])
    expect(check(f, `import { findProject } from "../../work/application"`)).toEqual([])
    expect(rule(f, `import { Project } from "../../work/domain/project"`)).toMatch(/only through modules\/work\/application\/index\.ts/)
    expect(rule(f, `import { repo } from "../../work/infrastructure/project-repo"`)).toMatch(/ARC-06/)
    expect(rule("modules/time/domain/entry.ts", `import { x } from "../../work/application/index"`)).toMatch(/ARC-06/)
  })

  it("keeps the platform folders apart", () => {
    expect(rule("db/pool.ts", `import { createApp } from "../http/app"`)).toMatch(/db may not import http/)
    expect(rule("db/pool.ts", `import express from "express"`)).toMatch(/"express"/)
    expect(rule("http/app.ts", `import pg from "pg"`)).toMatch(/"pg"/)
    expect(rule("http/app.ts", `import { runWorker } from "../worker/worker"`)).toMatch(/http may not import worker/)
    expect(rule("jobs/queue.ts", `import { createApp } from "../http/app"`)).toMatch(/jobs may not import http/)
    expect(rule("config/config.ts", `import { pool } from "../db/pool"`)).toMatch(/config may not import db/)
    expect(rule("http/routes.ts", `import { repo } from "../modules/work/infrastructure/project-repo"`)).toMatch(/only through modules\/work\/application\/index\.ts/)
    expect(check("http/routes.ts", `import { createProject } from "../modules/work/application/index"`)).toEqual([])
  })

  it("keeps tests out of production code, lets tests import anything, and refuses unknown folders", () => {
    expect(rule("db/pool.ts", `import { testDb } from "./testing/test-db"`)).toMatch(/test or testing helper/)
    expect(check("db/pool.test.ts", `import express from "express"\nimport { createApp } from "../http/app"`)).toEqual([])
    expect(rule("db/pool.ts", `import { x } from "../../../../packages/core/src/lib/x"`)).toMatch(/outside src/)
    expect(rule("helpers/thing.ts", ``)).toMatch(/outside the known folders/)
    expect(check("main.ts", `import { createApp } from "./http/app"\nimport pino from "pino"`)).toEqual([])
  })
})
