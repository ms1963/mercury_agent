---
name: code-review
description: Review a code change or file for bugs, security issues and readability. Use when the user asks for a review, audit or feedback on code.
metadata: { version: 1, tags: [code, quality], author: mercury }
---
# Code review

1. Read the files (`read_file`) or the diff (`shell`: `git diff`) — do not guess.
2. Check, in order: correctness, error handling, security (injection, secrets, path traversal), concurrency, performance, readability, tests.
3. Report findings as a list: `severity (high/medium/low) — file:line — problem — suggested fix`.
4. Only report issues you can point to in the code. Say "no issues found" when that is true.
5. Offer to apply fixes; apply them only after the user agrees.
