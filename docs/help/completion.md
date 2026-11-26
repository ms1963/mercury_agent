# Shell completion

`mercury completion <bash|zsh|fish>` prints a shell-completion script for the `mercury` CLI to stdout, so
you can `source` it or save it where your shell loads completions from. The script is generated from the
real command list, so it stays in step with the available commands.

## Usage

```
mercury completion bash > /etc/bash_completion.d/mercury      # or: source from ~/.bashrc
mercury completion zsh  > "${fpath[1]}/_mercury"               # then restart your shell
mercury completion fish > ~/.config/fish/completions/mercury.fish
```

## What it completes

- All top-level commands (`chat`, `serve`, `sessions`, `migrate`, `logs`, ...).
- The common subcommands of each command that has them (e.g. `migrate status|up`, `sessions list|rename|...`).

## Notes

- The output is a plain script; nothing is written or installed for you — you choose where it goes.
- Re-generate the script after upgrading Mercury so new commands are completed.
