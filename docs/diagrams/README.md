# Interactive diagrams

Four interactive diagrams of Nexora, generated with [Archify](https://github.com/tt-a1i/archify) (Apache-2.0) from the code of this repository. Every box links to the exact source lines that prove it, pinned to commit `d7f79ef` (after B1a step 2).

| Diagram | What it shows |
|---|---|
| [`architecture.html`](architecture.html) | How a request reaches the database: users, the web app, the web process, the unit of work, PostgreSQL, the shared rules and the migration step |
| [`request-sequence.html`](request-sequence.html) | A readiness request step by step: one transaction under a database role, applied migrations compared with the files, 200 or 503 |
| [`database.html`](database.html) | The tables that exist today, by schema, with every column, type and key |
| [`rule-sync.html`](rule-sync.html) | How a rule change travels from Nexora-Saas to the server, and the CI check that blocks a pull request when the two copies differ |

## Opening them

GitHub shows HTML files as code. Download the file and open it in a browser, or clone the repository and open it from `docs/diagrams/`. Each file is standalone and needs no internet. In the viewer you can:
- zoom and pan
- search, and focus on one part (Lens)
- follow a route
- switch between light and dark
- play or pause the motion
- click a box to open its source lines
- export a PNG, SVG or WebM

## Regenerating them

The source of each diagram is in `source/`. After a change to the code, update its source lines and pinned commit, then render it again with the Archify skill package (Node 18+ and Chrome or Chromium):

```bash
ARCHIFY_CHROME=/path/to/chromium \
node <archify>/archify/bin/archify.mjs finalize architecture docs/diagrams/source/architecture.json docs/diagrams/architecture.html \
  --repo-root . --quality showcase --out-dir .archify/final-architecture --json
```

The type is `architecture`, `sequence`, `erd` or `workflow`. A pass means:
- the schema is valid
- every cited source line exists at the pinned commit
- a real browser rendered the page without overflow

The `*.delivery.json` receipts written next to the HTML are not committed.
