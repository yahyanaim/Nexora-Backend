# Interactive diagrams

Nine interactive diagrams of Nexora, generated with [Archify](https://github.com/tt-a1i/archify) (Apache-2.0). Every box links to the exact source lines that prove it.

### What is built (sources: the code, commit `d7f79ef`, after B1a step 2)

| Diagram | What it shows |
|---|---|
| [`architecture.html`](architecture.html) | How a request reaches the database: users, the web app, the web process, the unit of work, PostgreSQL, the shared rules and the migration step |
| [`request-sequence.html`](request-sequence.html) | A readiness request step by step: one transaction under a database role, applied migrations compared with the files, 200 or 503 |
| [`database.html`](database.html) | The tables that exist today, by schema, with every column, type and key |
| [`rule-sync.html`](rule-sync.html) | How a rule change travels from Nexora-Saas to the server, and the CI check that blocks a pull request when the two copies differ |

### The target design (sources: the cahier des charges, commit `eafc61f`)

Each one is the interactive version of a figure in the docs.

| Diagram | Figure | What it shows |
|---|---|---|
| [`target-layout.html`](target-layout.html) | Cahier des charges Figure 1; ARCHITECTURE §1 | The two repositories, the web and worker processes (one image), PostgreSQL, object storage and e-mail |
| [`module-layers.html`](module-layers.html) | Cahier des charges Figure 2; ARCHITECTURE §3.2 | The layers inside one module: HTTP adapter, application, domain, ports, infrastructure |
| [`core-chain.html`](core-chain.html) | Cahier des charges Figure 3 | The planned tables from an hour worked to a payment received, with their keys (key columns only) |
| [`tenant-barriers.html`](tenant-barriers.html) | Cahier des charges Figure 4 | The three barriers between a request and another company's data, and the console and support roles |
| [`issue-invoice.html`](issue-invoice.html) | Cahier des charges Figure 5 | Issuing an invoice: one transaction with the gap-free number, then the worker builds and stores the files |

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

The type is `architecture`, `sequence`, `erd` or `workflow`. `core-chain` uses `--quality standard` (a dense table map); the others use `showcase`. A pass means:
- the schema is valid
- every cited source line exists at the pinned commit
- a real browser rendered the page without overflow

The `*.json` receipts written next to the HTML are not committed.
