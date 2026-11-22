# Add-Ins

Add-Ins are Mercury's unified, **declarative** way for end users to add **tools**,
**personalities** and **permission profiles** — purely by dropping files into the data
directory. **You never edit anything under `packages/` to add an add-in.**

An Add-In unifies the three pre-existing drop-in mechanisms (markdown personalities,
polyglot `tool.json` tool folders, and permission profiles) behind a single manifest, so
one self-contained folder can ship all three together.

> Status (v1.4.0): the loader, permission-profile merge and scaffold are covered by
> offline unit tests (`tests/addins.test.ts`, `tests/permissions.test.ts`). The runtime
> wiring (discovery on start, personalities/tools/permissions made live) is exercised
> indirectly; end-to-end execution of a scaffolded polyglot tool depends on your having
> the tool's interpreter installed. Nothing here is a "production-ready" claim.

## Where add-ins live

```
<dataDir>/addins/<name>/
  addin.yaml | addin.json         ← the manifest (required)
  personalities/*.md              ← persona prompt files (same format as <dataDir>/personalities)
  tools/<tool>/tool.json          ← polyglot tool folders (same format as <dataDir>/tools)
```

`<dataDir>` defaults to `~/.mercury`. Override the add-ins root with the `addins.dir`
config key, and disable discovery entirely with `addins.enabled: false`.

This is **additive and backward-compatible**: the legacy `<dataDir>/personalities`,
`<dataDir>/tools` and `<dataDir>/plugins` scans keep working exactly as before. Add-ins
are loaded *in addition* to them.

## Manifest format (`addin.yaml`)

```yaml
name: my-pack              # required; [a-zA-Z0-9_-]{1,64}
version: 0.1.0             # optional (default 0.0.0)
description: What this add-in provides.
enabled: true             # optional (default true); false ⇒ contributes nothing

# Markdown persona files, relative to this add-in dir:
personalities:
  - personalities/pirate.md

# Polyglot tool folders (each holds a tool.json), relative to this add-in dir:
tools:
  - tools/greet

# Per-personality/agent permission profiles (UserPolicy shape).
# A profile can only FURTHER RESTRICT the acting user — never escalate. See PERMISSIONS.md.
permissions:
  pirate:
    deniedToolsets: [shell]
    maxToolRisk: safe
```

A `.json` manifest (`addin.json`) with the same fields works identically.

### What each section contributes

| Section | Contributes | Same format as |
|---|---|---|
| `personalities` | Named persona prompts selectable via `--personality`/`/personality` | `<dataDir>/personalities/*.md` |
| `tools` | External-process ("polyglot") tools callable by the agent | `<dataDir>/tools/<tool>/tool.json` |
| `permissions` | Per-agent/personality permission profiles | see [PERMISSIONS.md](PERMISSIONS.md) |

Personality files use the markdown convention: the first `# Heading` is the title, the
rest is the prompt, and the file name (without `.md`) is the personality name.

Polyglot `tool.json` files use the standard schema (`name`, `description`, `toolset`,
`risk`, `parameters`, `command`, optional `build`/`timeoutMs`/`requires`). See
[EXTENDING.md](EXTENDING.md) for the full polyglot tool reference.

## Robustness

The loader is **pure filesystem + parsing — no LLM, no network**. A malformed add-in
(bad manifest, missing referenced file, a tool dir with no `tool.json`, a personality
path that escapes the add-in directory) is **skipped with a warning and never crashes
the runtime**. Duplicate add-in names keep the first and warn on the later copy. Warnings
are logged at start and shown by `mercury addin list`.

## CLI

```bash
mercury addin list                 # discovered add-ins: enabled state + what each contributes
mercury addin list --json          # machine-readable
mercury addin scaffold my-pack     # write a starter add-in into <dataDir>/addins/my-pack/
```

`mercury addin scaffold <name>` writes a complete, ready-to-copy template (manifest +
sample personality + sample polyglot echo tool + sample permission profile) **into the
data dir, never the source tree**. Edit it and restart Mercury to load it.

## Enabling / disabling

- Per add-in: set `enabled: false` in its manifest (it stays listed but contributes nothing).
- Globally: set `addins.enabled: false` in config.
- Relocate: set `addins.dir: /path/to/addins` in config.

Add-ins are discovered at startup. Restart Mercury (or re-create the `Mercury` instance)
after adding, editing or removing one.
