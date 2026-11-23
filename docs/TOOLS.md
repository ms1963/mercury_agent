# Built-in Tools

<!-- GENERATED FILE — do not edit by hand.
     Regenerate with: node scripts/gen-tools-doc.mjs -->

Mercury ships **83 built-in tools**, registered automatically at startup
(`registerBuiltinTools()` in `packages/tools/src/index.ts`). These are compiled
TypeScript, not files on disk — the `tools/` directory at the repository root holds
only *example* external tools (Go / JS / Python) that show how to add your own.

The agent is given the tools allowed by the active toolsets and policy; see
[docs/EXTENDING.md](EXTENDING.md) to add your own, and [docs/SECURITY.md](SECURITY.md)
for approvals, the path jail and the SSRF guard that govern tool use.

## Summary

| Toolset | Count |
| --- | ---: |
| Agents & workflows | 3 |
| Browser automation | 6 |
| Code & sandbox | 1 |
| Data | 8 |
| Decisions & reasoning | 3 |
| Files | 10 |
| Git | 4 |
| Media | 4 |
| Memory | 6 |
| Messaging | 2 |
| Processes | 4 |
| Scheduler | 3 |
| Skills | 5 |
| System | 1 |
| Terminal & processes | 1 |
| Utility | 11 |
| Vector search | 2 |
| Web | 6 |
| Wiki | 3 |
| **Total** | **83** |

## Agents & workflows

| Tool | Description |
| --- | --- |
| `delegate_task` | Delegate work to isolated subagents with fresh context. Pass one goal, or tasks=[...] to run several in parallel (bounded by the max-subagents limit). Each subagent only returns its final summary. Give each goal full context: subagents cannot see this conversation. |
| `list_workflows` | List available workflow definitions and template types. |
| `run_workflow` | Run a multi-agent workflow (pipeline, coordinator-worker, debate, map-reduce, ...) by name, or "auto" to let the router pick one. |

## Browser automation

| Tool | Description |
| --- | --- |
| `browser_back` | Go back to the previous page. |
| `browser_click` | Click the interactive element with the given [number] from the snapshot. |
| `browser_navigate` | Open a URL in the browser and return a text snapshot with numbered interactive elements. |
| `browser_screenshot` | Take a full-page screenshot (playwright backend) and attach it. |
| `browser_snapshot` | Return the current page snapshot again. |
| `browser_type` | Type text into an input element; submit=true presses Enter. |

## Code & sandbox

| Tool | Description |
| --- | --- |
| `execute_code` | Run a Python or JavaScript script that can call other tools programmatically: Python `call_tool("web_search", query="x")`, JS `await callTool("read_file", {path: "a.txt"})`. Use it to batch many tool calls or process data. Print results to stdout. |

## Data

| Tool | Description |
| --- | --- |
| `archive` | Create, extract or list .tar.gz / .zip archives (uses tar/unzip/zip on the host). |
| `csv_parse` | Parse CSV (inline or file) into JSON objects using the header row. Also reports column names and row count. |
| `document_generate` | Generate a document file from Markdown or HTML source and attach it to the reply. Output formats: pdf, docx (Word), html, pptx (PowerPoint — splits on headings / "---" slide breaks), md. PDF/DOCX/PPTX use host pandoc (+ libreoffice for PDF). |
| `document_text` | Extract text from a document (PDF via pdftotext, Word .docx, Excel .xlsx, PowerPoint .pptx, HTML, plain text). |
| `json_query` | Extract a value from JSON (inline or a file) with a path like "items[0].name". |
| `spreadsheet_generate` | Generate an Excel .xlsx spreadsheet from structured data and attach it to the reply. Provide either rows (a JSON array of objects or of arrays) or csv (CSV text). Optional header (column names) and sheet_name. |
| `sqlite_query` | Run SQL against a SQLite database file in the workspace. Read-only unless write=true. |
| `yaml_convert` | Convert YAML to JSON or JSON to YAML. |

## Decisions & reasoning

| Tool | Description |
| --- | --- |
| `decide_choice` | Make a calibrated choice between options. options = {key: "criterion describing when to pick it"}. Returns the chosen key with confidence. |
| `decide_noul` | Yes/no judgment with calibrated confidence (e.g. "Is this answer complete?"). |
| `decide_score` | Grade something on an ordered scale. levels = ["poor", "ok", "good", "excellent"] (low → high). |

## Files

| Tool | Description |
| --- | --- |
| `delete_file` | Delete a file (snapshotted, so it can be restored with /rollback). Folders are not deleted. |
| `edit_file` | Replace an exact text fragment in a file (patch). old_text must match exactly once unless replace_all=true. |
| `file_info` | Get size, type and modification time of a file or folder. |
| `find_files` | Find files by glob pattern, e.g. "**/*.md" or "src/*.ts". |
| `list_dir` | List files and folders in a directory (recursive=true lists all files, skipping node_modules/.git). |
| `make_dir` | Create a directory (including parents). |
| `move_file` | Move or rename a file. |
| `read_file` | Read a text file. Optionally pass offset (1-based line) and limit (number of lines). |
| `search_files` | Search file contents with a regular expression (like grep). Returns file:line: text. |
| `write_file` | Create or overwrite a text file (or append with append=true). Creates parent folders. |

## Git

| Tool | Description |
| --- | --- |
| `git_commit` | Stage files (default: all changes) and create a commit. |
| `git_diff` | Show the git diff of uncommitted (or staged) changes. |
| `git_log` | Show recent commits. |
| `git_status` | Show git status (branch and changed files) of a repository. |

## Media

| Tool | Description |
| --- | --- |
| `describe_image` | Ask a vision-capable model about an uploaded image attachment. |
| `image_generate` | Generate an image from a text prompt. The image is attached to the reply. |
| `speech_to_text` | Transcribe an uploaded audio attachment. |
| `text_to_speech` | Convert text to speech audio and attach it (voice reply). |

## Memory

| Tool | Description |
| --- | --- |
| `memory` | Curated persistent memory that is always in your prompt. target=memory (MEMORY.md: environment facts, conventions, lessons) or user (USER.md: who the user is, preferences). Keep entries short; the files are size-bounded and the oldest entries are dropped. |
| `memory_forget` | Delete long-term memories by id or matching text. |
| `memory_recall` | Search long-term memory (hybrid keyword + semantic) for relevant facts. |
| `memory_store` | Store a fact/lesson/preference/note in long-term memory (searchable later with memory_recall). |
| `session_search` | Full-text search over your past conversations with this user; summarize=true returns an LLM summary of what was found. |
| `user_profile` | View or update the dialectic user model (inferred traits and preferences of the user). |

## Messaging

| Tool | Description |
| --- | --- |
| `list_platforms` | List messaging platforms that can be used with send_message. |
| `send_message` | Send a message through a connected messaging platform (telegram, discord, slack, email, ...). target = chat id / channel / address. |

## Processes

| Tool | Description |
| --- | --- |
| `process_kill` | Stop a background process. |
| `process_list` | List background processes started by you. |
| `process_output` | Read the latest output of a background process. |
| `process_start` | Start a long-running background command (e.g. a dev server). Returns a process id. |

## Scheduler

| Tool | Description |
| --- | --- |
| `schedule_create` | Schedule a recurring or one-time task. when: natural language ("every weekday at 9am", "every 2 hours", "in 10 minutes", "tomorrow at 8") or cron. deliver_to: "platform:target" (e.g. "telegram:12345"); defaults to the current chat. |
| `schedule_list` | List your scheduled jobs. |
| `schedule_manage` | Pause, resume, delete, edit (when/task) or immediately run a scheduled job. |

## Skills

| Tool | Description |
| --- | --- |
| `skill_compose` | Run a composed skill: an ordered pipeline of tool calls and nested sub-skills. Each step is {tool, args} to call a tool, or {skill, steps, inputs} to run a nested sub-skill. Intermediate results are cached; recursion is depth- and cycle-guarded. Every tool step still goes through normal policy/approval. |
| `skill_install` | Install skills from a local folder or a git URL (admin only). |
| `skill_manage` | Create a new skill or improve an existing one (procedural memory). Write the body as a reusable procedure: When to use, Steps, Pitfalls, Verification. Create skills after solving non-trivial tasks. |
| `skill_view` | Load the full instructions of a skill (or one of its supporting files). Do this before following a skill. |
| `skills_list` | List available skills (name + description). With query, return the best matching skills. |

## System

| Tool | Description |
| --- | --- |
| `system_info` | Host information: OS, CPU, memory, uptime, Node version. |

## Terminal & processes

| Tool | Description |
| --- | --- |
| `terminal` | Run a shell command and return stdout/stderr/exit code. Use process_start for long-running servers. |

## Utility

| Tool | Description |
| --- | --- |
| `base64` | Base64 encode or decode text. |
| `calculator` | Evaluate an arithmetic expression exactly, e.g. "(3+4)*2^3", "sqrt(2)", "17 % 5". |
| `current_time` | Current date and time, optionally in an IANA time zone (e.g. Europe/Berlin). |
| `date_calc` | Date arithmetic: add N days/weeks/months/years to a date, or compute days between date and until. |
| `hash_text` | Hash text with sha256 (default), sha1, sha512 or md5. |
| `regex_extract` | Extract all regex matches (with capture groups) from text. |
| `text_diff` | Line-by-line diff of two texts (- removed, + added). |
| `text_stats` | Count characters, words, lines and estimated tokens of a text. |
| `todo` | Manage a task list for the current session: add items, mark one done (1-based index), list or clear. |
| `unit_convert` | Convert between units (length, mass, volume, time, data, temperature C/F/K). |
| `uuid` | Generate random UUIDs. |

## Vector search

| Tool | Description |
| --- | --- |
| `vector_index` | Add text snippets to a named in-memory vector collection for semantic search (session-scoped scratch index). |
| `vector_search` | Semantic search in a vector collection created with vector_index. |

## Web

| Tool | Description |
| --- | --- |
| `http_request` | Make an HTTP request (GET/POST/PUT/PATCH/DELETE) to an API and return status, headers and body. |
| `rss_read` | Read an RSS or Atom feed and list the latest items. |
| `weather` | Current weather and 3-day forecast for a place (Open-Meteo, no API key). |
| `web_fetch` | Fetch a web page and return readable text (format=text), raw HTML (html) or the list of links (links). |
| `web_read` | Open a web page (gated, requires approval) and return its readable main content — title and article text, boilerplate removed. Set render=true to run a headless browser (executes JavaScript) for JS-heavy pages, otherwise plain HTTP is used. Optionally includes the page links. |
| `web_search` | Search the web. Returns titles, URLs and snippets. |

## Wiki

| Tool | Description |
| --- | --- |
| `wiki_ingest` | Ingest a source into the LLM Wiki: the source is stored immutably under raw/, then the LLM synthesises or updates cross-linked markdown pages and the index. Provide either text (literal content) or path (a file to read). Optionally name the stored source and give synthesis guidance. |
| `wiki_lint` | Run quality checks over the LLM Wiki: orphan pages, broken internal links, stub/gap pages, stale pages (a raw source newer than the page) and (LLM-assisted) contradictions. delta only checks pages touched since the last lint; no_llm skips the contradiction check. |
| `wiki_query` | Answer a question from the LLM Wiki: consults the index, reads the most relevant pages and answers, citing the underlying raw source files. |

