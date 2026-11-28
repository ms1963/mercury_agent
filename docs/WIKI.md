# LLM Wiki

Mercury v1.4.0 ships an **LLM Wiki** subsystem — an implementation of Andrej
Karpathy's "LLM wiki" pattern. Instead of doing retrieval at *query* time (classic
RAG), the LLM synthesises knowledge into a human-readable, cross-linked markdown wiki
at **ingestion** time. Queries then read the finished pages, and a dedicated **lint**
pass keeps the wiki healthy as it grows.

The subsystem is available three ways:

- a `WikiService` class (`@mercury/core`) you can embed,
- three built-in agent tools (`wiki_ingest`, `wiki_query`, `wiki_lint`),
- a `mercury wiki` CLI command group.

---

## Why ingestion-time synthesis

Query-time RAG re-reads raw chunks on every question and leaves the knowledge
unstructured. The LLM-wiki approach does the reading-and-writing work **once**, when a
source is ingested: the model folds the new material into a small set of focused,
cross-linked pages. The result is a corpus a *human* can read and audit, queries that
consult coherent pages rather than disconnected chunks, and a structure a linter can
reason about (orphans, broken links, stale pages…).

## Directory layout

Everything lives under a single wiki directory (default `<dataDir>/wiki`, i.e.
`~/.mercury/wiki`). It is created lazily on first use:

```
wiki/
  raw/              immutable original sources (stored read-only; read, never modified)
  wiki/             LLM-authored markdown pages, one topic per file (<slug>.md)
  index.md          table of contents (regenerated deterministically on every ingest)
  log.md            append-only log of ingest and lint operations
  SCHEMA.md         page conventions / schema (seeded once; configurable name)
  .wiki-state.json  small state file (last-ingest / last-lint markers)
```

Each page is markdown with YAML frontmatter:

```markdown
---
title: Topic A
slug: topic-a
sources:
  - raw/notes.txt
synthesized: 2026-02-01T00:00:00.000Z
links:
  - topic-b
---

Prose synthesised by the LLM, cross-linking [Topic B](topic-b.md) or [[topic-b]].
```

### Design note: who maintains what

The **LLM authors page bodies** and declares each page's outgoing links. The
**index is maintained deterministically** by the service (`index.md` is regenerated
from the set of pages on every ingest), not by the LLM. This keeps the table of
contents always parseable and in sync — which the orphan/broken-link checks rely on —
and avoids the LLM silently dropping entries.

Raw sources are copied into `raw/` under a unique filename and `chmod`'d read-only, so
re-ingesting never overwrites an earlier source.

## The three operations

### 1. Ingest

`ingest(pathOrText, opts)` copies the source into `raw/` (immutably), asks the LLM to
synthesise or update the relevant wiki page(s) — reusing existing slugs so a topic is
updated rather than duplicated — maintains cross-links, regenerates `index.md`, and
appends a line to `log.md`. A page accumulates every source that contributed to it.

### 2. Query

`query(question, opts)` consults `index.md`, ranks pages by keyword overlap, reads the
top *k*, and has the LLM answer **using only those pages**, citing the underlying raw
source file(s). Identical concurrent queries are coalesced (single-flight) and the
parsed index is cached briefly (TTL cache) so repeated queries skip re-parsing.

### 3. Lint (and delta-lint)

`lint(opts)` runs quality checks over the wiki:

| Check | How it works | LLM? |
|---|---|---|
| **orphan** | a page nothing links to (not in `index.md`, not linked by any page); skipped when there is only one page | no |
| **broken-link** | an outgoing link (frontmatter `links` or body `[t](slug.md)` / `[[slug]]`) to a page that does not exist | no |
| **stub** | body shorter than `wiki.stubMinChars`, or containing a placeholder marker (TODO/TBD/FIXME/WIP/…) | no |
| **stale** | a raw source whose mtime is newer than the page's `synthesized` timestamp | no |
| **contradiction** | the LLM is asked whether any pages factually conflict | **yes** |

The four deterministic checks never call the LLM. The contradiction check is the only
LLM-assisted one and is **skippable** — pass `--no-llm` (CLI) / `no_llm` (tool) or run
with no provider configured, and lint degrades gracefully to the deterministic checks.

**Delta-lint** (`--delta`) only checks pages created or modified since the last lint
pass (tracked in `.wiki-state.json`), for scale. Both modes update the last-lint
marker.

## Configuration

Add a `wiki` section to your config (all keys are optional and backward-compatible):

| Key | Default | Meaning |
|---|---|---|
| `wiki.enabled` | `true` | Master switch for the tools + CLI. When `false`, the tools report the subsystem as disabled. |
| `wiki.dir` | `""` → `<dataDir>/wiki` | Wiki root directory. |
| `wiki.schemaFile` | `"SCHEMA.md"` | Name of the schema/convention file inside the wiki dir. |
| `wiki.stubMinChars` | `200` | Pages whose body is shorter than this are flagged as stubs. |

Example (`~/.mercury/config.json` or `.yaml`):

```json
{
  "wiki": { "enabled": true, "stubMinChars": 150 }
}
```

> **Customisation without touching the source.** Per Mercury's design, user
> customisation lives entirely under the data dir: your sources, pages, schema and the
> config above. You never edit `packages/**` to run or tune the wiki.

## CLI

```bash
mercury wiki init                      # create the directory layout
mercury wiki status                    # pages, sources, last ingest/lint
mercury wiki ingest ./notes.md         # ingest a file
cat notes.md | mercury wiki ingest -   # ingest from stdin
mercury wiki ingest ./a.txt --name intro.txt --instruction "focus on setup"
mercury wiki query "how do I configure providers?"
mercury wiki lint                      # full lint (incl. LLM contradiction check)
mercury wiki lint --delta --no-llm     # only changed pages, deterministic checks only
mercury wiki lint --json               # machine-readable report
```

`lint` prints a report grouped by issue type and **exits non-zero when any issue is
found** (so it is CI-friendly), matching the exit-code convention of `mercury eval`.

Ingest and query require a configured LLM provider; `init`, `status` and the
deterministic part of `lint` do not.

## Tools

| Tool | Risk | Purpose |
|---|---|---|
| `wiki_ingest` | moderate (writes) | Ingest literal `text` or a file `path`; optional `name`, `instruction`. |
| `wiki_query` | safe (output tagged untrusted) | Answer a `question` from the wiki, citing sources; optional `k`. |
| `wiki_lint` | safe | Run the checks; optional `delta`, `no_llm`. |

They are part of the `wiki` toolset and are listed in
[docs/TOOLS.md](TOOLS.md) (auto-generated). All LLM work goes through the existing
`LLMService`, so wiki calls inherit its circuit-breaker + retry/backoff.

## Status: tested vs. untested

Consistent with the honest tone of [STATUS.md](../STATUS.md) — this is v2.2.2, **not**
"production-ready":

**Tested (offline, deterministic, `tests/wiki.test.ts`):**

- `init` creates the layout and seeds schema/index/log.
- `ingest` stores the source read-only, writes a page, updates the index and log, and
  records `synthesized` — using a **test-local fake LLM** (no network).
- `query` answers from the wiki and cites the underlying raw sources (fake LLM).
- Every **deterministic** lint check — orphan, broken-link, stub, stale — and
  **delta** mode, all run **with no LLM at all**.
- The contradiction check is exercised with an injected fake LLM, and verified to be
  **skipped** under `no_llm`.

**Not yet exercised against a real service:**

- Synthesis / answering / contradiction detection against a **real LLM API**. The
  runtime wiring (`WikiService` ↔ real `LLMService`) compiles and the deterministic
  JSON-parsing of model output is defensive, but the quality of synthesised pages,
  answers and contradiction findings depends entirely on the configured model and has
  not been measured here.
- The `mercury wiki` CLI and the three tools have unit-tested service logic beneath
  them, but the end-to-end CLI/agent paths that require a live provider were not run
  against one in this environment.

No mock LLM runs in any runtime path: mocks exist only in the test file.
