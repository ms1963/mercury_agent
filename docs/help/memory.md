# Memory

Mercury remembers across sessions with several layers:

- **Facts** — searchable long-term memories (`memory_remember`, `memory_recall` tools; web Memory panel).
- **Curated memory** — `MEMORY.md` (agent notes) and `USER.md` (about you), bounded in size, injected into every prompt.
- **User model** — a profile of preferences learned from conversations.
- **Session search** — full-text search over past conversations.
- **Blackboard** — shared scratch space for multi-agent workflows.

Use `/memory` in chat or the Memory panel to browse, edit and forget.

## Governed memory & knowledge (v1.4.0)

Memory can be policy-governed, PII-aware, retention-bounded, namespaced and auditable. All of this is
**off/soft by default** and backward-compatible — existing calls keep working.

```yaml
memory:
  governance:
    mode: off            # off | soft | strict
    enforcePolicy: false # route remember/recall/forget through the policy engine
    pii:
      detect: true
      redact: true       # replace detected PII with placeholders
      block: false       # reject writes that contain PII (strict)
  retention:
    ttlDays: 0                 # 0 = keep forever
    maxItemsPerNamespace: 0    # 0 = unbounded; otherwise prune oldest
  namespaces:
    default: default
    allowed: []                # when set (strict), only these namespaces are accepted
  knowledge:
    enabled: false
    chunkChars: 900
    chunkOverlap: 120
    recallK: 4
```

- **Namespaces** add a dimension on top of the per-user scope; `remember`/`recall`/`forget` accept a
  `namespace` option, and `mercury memory ns` lists them with counts.
- **PII** is detected (email, card, SSN, IP, phone) and either redacted or blocked per config.
- **Retention** prunes by TTL and/or max-items-per-namespace on write.
- **Audit** — every governed decision is recorded in the queryable `memory_audit` ledger
  (`mercury memory audit`, `GET /api/memory/audit`) in addition to the global audit bus.
- **Knowledge/RAG** — `mercury memory knowledge add` ingests a document (chunked + embedded) and
  `mercury memory knowledge search` recalls chunks with **provenance** via hybrid FTS+vector search.
  When `knowledge.enabled`, knowledge grounds `buildContext()`.
- Memory config is a **bundle section**, so it can be exported/installed with agent bundles.
