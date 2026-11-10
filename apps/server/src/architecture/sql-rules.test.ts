import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { checkSqlStrings } from "./sql-rules"

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

const check = (file: string, text: string) => checkSqlStrings(new Map([[file, text]]))

describe("SQL is never built from strings (SCR-02, security plan G-4)", () => {
  it("finds no string-built SQL in the server's source", () => {
    expect(checkSqlStrings(sourceFiles())).toEqual([])
  })

  it("refuses a template literal with a value inside, wherever the call is", () => {
    expect(check("jobs/x.ts", "await c.query(`SELECT * FROM ops.jobs WHERE id = '${id}'`)")).toEqual([
      { file: "jobs/x.ts", line: 1, snippet: "SELECT * FROM ops.jobs WHERE id = '${id}'" },
    ])
    expect(check("db/x.ts", "const a = 1\nawait client.query<{ n: number }>(\n  `DELETE FROM t WHERE name = ${name}`,\n)")).toHaveLength(1)
    expect(check("modules/work/infrastructure/repo.ts", "pool.query(`SELECT ${columns} FROM work.projects`)")).toHaveLength(1)
  })

  it("refuses a string joined with +", () => {
    expect(check("db/x.ts", `c.query("SELECT * FROM t WHERE id = " + id)`)).toHaveLength(1)
    expect(check("db/x.ts", "c.query('DELETE FROM t WHERE a = ' + a, [])")).toHaveLength(1)
  })

  it("allows parameters, multi-line templates without values, and the reviewed role line only in its file", () => {
    expect(check("db/x.ts", "c.query(`SELECT *\n FROM t\n WHERE id = $1`, [id])\nc.query(\"SELECT 1\")\nc.query(sql, params)")).toEqual([])
    expect(check("db/session.ts", "await client.query(`SET LOCAL ROLE ${ctx.role}`)")).toEqual([])
    expect(check("db/pool.ts", "await client.query(`SET LOCAL ROLE ${ctx.role}`)")).toHaveLength(1)
    expect(check("db/session.ts", "await client.query(`SET LOCAL ROLE ${input}`)")).toHaveLength(1)
  })

  it("leaves tests alone: they build throwaway databases and fixtures", () => {
    expect(check("db/database.test.ts", "c.query(`SELECT 1 FROM ${table}`)")).toEqual([])
    expect(check("db/testing/test-db.ts", "c.query(`CREATE DATABASE ${name}`)")).toEqual([])
  })
})
