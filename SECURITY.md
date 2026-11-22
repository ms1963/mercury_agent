# Security Policy

## Supported versions

Mercury's current release is `1.4.0`. Security fixes are applied to the latest `main` and the most
recent release.

| Version | Supported |
| ------- | --------- |
| 1.4.x   | ✅        |
| < 1.4   | ❌        |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, use GitHub's private vulnerability reporting for this repository
(**Security → Report a vulnerability**), or contact the maintainer privately. Include:

- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- affected version/commit and your environment.

You will receive an acknowledgement as soon as possible, and we will keep you informed as the issue
is investigated and resolved. Please give us a reasonable amount of time to release a fix before any
public disclosure.

## Security model

Mercury can run shell commands, read files, browse the web and talk to chat platforms — treat it
like a remote shell for whoever can log in. The full threat model, the controls that exist
(authentication, RBAC, prompt-injection guardrails, approvals, path jail, SSRF guard, secret
redaction, hash-chained audit log) and their limits are documented in
[docs/SECURITY.md](docs/SECURITY.md).
