# Operator console

`mercury console` launches the interactive chat REPL with an operator banner. It is a convenience entry
point — equivalent to `mercury chat` plus a banner summarising the running instance.

## Usage

```
mercury console [--user <name>] [--model <id>] [--session <id>] [--pattern <name>]
```

## The banner

Before the prompt appears, the console prints:

- the Mercury CLI **version**,
- the acting **user**,
- the **data directory**,
- the **database path**,
- a **config summary** (default model, personality, and pattern if set).

## Notes

- All REPL slash-commands are available (`/help`, `/model`, `/usage`, `/reset`, ...).
- The flags mirror `mercury chat`. Press `Ctrl-D` to exit.
