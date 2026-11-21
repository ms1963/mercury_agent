![Mercury Agent](../assets/mercury_agent.png)

# Mercury in Plain English — Install, Configure, Use

This is the friendliest guide to Mercury. No jargon. Follow it top to bottom and you'll have
a working AI assistant — in your terminal **and** in a web page — in about ten minutes.

> **What is Mercury?** It's your own private AI assistant that runs on *your* computer. You give
> it a "brain" (an AI model — either a free local one or a cloud one), and it can chat, remember
> things, run tools, and help with tasks. Nothing is locked to anyone else's servers unless you
> choose a cloud brain.

> **One thing to know first:** Mercury has **no AI model of its own**. You must connect it to one.
> This guide shows the two easiest choices:
> - **Ollama** — free, runs on your own machine, no account, no API key, works offline.
> - **ChatLLM** (Abacus.AI) — a cloud brain; needs an API key but no local setup and no powerful PC.

---

## Contents

1. [Before you start (one-time prerequisites)](#1-before-you-start)
2. [Install Mercury](#2-install-mercury)
3. [The 2-minute setup wizard](#3-the-2-minute-setup-wizard)
4. [Choose your brain: Ollama (free, local)](#4a-brain-option-a--ollama-free-local)
   or [ChatLLM (cloud)](#4b-brain-option-b--chatllm-abacusai-cloud)
5. [Talk to Mercury in the terminal (CLI)](#5-use-it-in-the-terminal-cli)
6. [Use the web page (UI)](#6-use-it-in-your-browser-web-ui)
7. [Deploy it so it keeps running](#7-keep-it-running-deploy)
8. [Everyday settings you might change](#8-everyday-settings)
9. [If something goes wrong](#9-if-something-goes-wrong)

---

## 1. Before you start

You need **two** free things on your computer. If you already have them, skip ahead.

**a) Node.js version 22.5 or newer.** This is what Mercury runs on.
- Download the "LTS" or "Current" installer from <https://nodejs.org> and run it.
- To check it worked, open a terminal (on Windows: "PowerShell"; on Mac: "Terminal") and type:
  ```bash
  node --version
  ```
  You should see something like `v22.5.0` or higher. If the number is lower, install the newer one.

**b) Git** (used to download Mercury).
- Get it from <https://git-scm.com/downloads> and run the installer.
- Check with: `git --version`

That's it. You do **not** need to be a programmer.

---

## 2. Install Mercury

Open your terminal and copy-paste these lines **one block at a time**, pressing Enter after each.

```bash
git clone https://github.com/ms1963/mercury_agent.git mercury
cd mercury
npm install
npm run build
```

- `git clone …` downloads Mercury into a new folder called `mercury`.
- `cd mercury` steps into that folder.
- `npm install` fetches the pieces it needs (takes a minute or two).
- `npm run build` gets it ready to run.

**Optional but recommended — a short name.** So you can type just `mercury` instead of the long
path, run:

```bash
./install.sh
```

This creates a global `mercury` command. From here on, this guide uses `mercury …`. If you skipped
`install.sh`, simply replace every `mercury` below with `node packages/cli/dist/bin.js`.

> Example: `mercury chat` becomes `node packages/cli/dist/bin.js chat`.

---

## 3. The 2-minute setup wizard

Mercury has a guided first-run wizard. Run:

```bash
mercury setup
```

It asks you a few plain questions. Here's exactly what you'll see and what to type:

```
Username [admin]:              ← press Enter to accept "admin", or type your own
Password (min 8 chars):       ← type a password (at least 8 characters) and press Enter
Provider (chatllm|openrouter|ollama|lmstudio|openai|anthropic|openai-compatible) [openrouter]:
                              ← type  ollama   (free/local)  OR  chatllm  (cloud), then Enter
Model [...]:                  ← press Enter to accept the suggested model
```

- The **username and password** are *your* login for Mercury's web page later. The first account
  you create automatically becomes the **admin** (the owner).
- The **provider** is the brain. Pick `ollama` or `chatllm` — the next section finishes that part.

When it's done you'll see a confirmation like `✔ default model … saved`. 

Now jump to the matching brain section below.

---

## 4a. Brain option A — Ollama (free, local)

Best if you want **zero cost, full privacy, and offline use**. Needs a reasonably modern computer.

**Step 1 — Install Ollama.** Download it from <https://ollama.com> and run the installer. It runs
quietly in the background.

**Step 2 — Download a model (the actual AI brain).** In your terminal:

```bash
ollama pull llama3.1
```

(This downloads a few gigabytes once. `llama3.1` is a solid general model.)

**Step 3 — Tell Mercury to use it:**

```bash
mercury config set llm.providers.ollama '{"type":"ollama","enabled":true}'
mercury model ollama/llama3.1
```

That's all — no API key, nothing else. Mercury talks to Ollama on your own machine
(`http://localhost:11434` by default).

✅ **Test it:**

```bash
mercury chat "Say hello in one sentence."
```

If it replies, your free local brain is working. Skip to [section 5](#5-use-it-in-the-terminal-cli).

---

## 4b. Brain option B — ChatLLM (Abacus.AI, cloud)

Best if your computer isn't powerful, or you want top-tier models without local setup.

**Step 1 — Get your API key.** Log in to your Abacus.AI ChatLLM account and copy your API key.
(An API key is just a long secret password that proves the requests are yours.)

**Step 2 — Save the key** in Mercury's private settings file. Run this, replacing `YOUR_KEY_HERE`
with your real key:

```bash
echo 'CHATLLM_API_KEY=YOUR_KEY_HERE' >> ~/.mercury/.env
```

> The key lives only in `~/.mercury/.env` on your computer. Never put it in chat messages or
> share it. (`~` means your home folder.)

**Step 3 — Pick the model:**

```bash
mercury model chatllm/route-llm
```

`route-llm` automatically picks the best model for each question. (Or pin one, e.g.
`mercury model chatllm/gpt-4o-mini`.) ChatLLM turns on automatically as soon as the key is present.

✅ **Test it:**

```bash
mercury chat "Say hello in one sentence."
```

If it replies, your cloud brain is working.

---

## 5. Use it in the terminal (CLI)

The CLI is the quickest way to use Mercury. Two modes:

**One quick question** (answers and exits):

```bash
mercury chat "Summarise what a black hole is for a 10-year-old."
```

**A back-and-forth conversation** (stays open until you leave):

```bash
mercury chat
```

Now just type messages and press Enter. Mercury remembers the conversation. Handy in-chat commands
you can type:

| Type this | What it does |
| --- | --- |
| `/model` | See or change which brain is active |
| `/stop` | Stop a reply that's running |
| `/retry` | Try the last answer again |
| `/undo` | Undo the last exchange |
| `/help` | Show all in-chat commands |
| `exit` (or Ctrl-C) | Leave the conversation |

**A few other useful CLI commands** (type them at the normal terminal, not inside a chat):

```bash
mercury model                 # show the current brain and list available ones
mercury tools list            # see the built-in tools Mercury can use
mercury doctor                # health-check: tells you if anything's missing
mercury help                  # full list of commands
```

---

## 6. Use it in your browser (web UI)

Prefer a normal web page with buttons and panels? Start the server:

```bash
mercury serve
```

You'll see: `Mercury listening on http://localhost:3000`. Now open
**<http://localhost:3000>** in your browser.

**First time:** register an account on the page. **The very first account becomes the admin/owner.**
(If you already created a user in `mercury setup`, log in with that username and password.)

Once inside, the web UI gives you the same power as the CLI, but visually:

| Panel | What it's for |
| --- | --- |
| **Chat** | Talk to Mercury, same as `mercury chat` |
| **Model** picker | Switch brains (Ollama ↔ ChatLLM) with a click — same as `/model` |
| **Tools** | Turn individual tools on/off |
| **Memory** | See and manage what Mercury remembers |
| **Settings / Config** | Change options without touching files |
| **Help** | Built-in documentation |

> Keep the terminal window that is running `mercury serve` open — closing it stops the web page.
> Section 7 shows how to make it run permanently.

For a deeper tour of the web UI, see [WEB_UI.md](WEB_UI.md).

---

## 7. Keep it running (deploy)

By default the web page only runs while `mercury serve` is open. To have it **start automatically
and stay on**, the easiest way is **Docker** (it bundles everything and restarts itself):

```bash
docker compose up -d
```

- `-d` means "run in the background."
- Your data (users, memory, settings) is saved in a storage volume called `mercury-data`, so it
  survives restarts and updates.
- Open <http://localhost:3000> as before.
- To stop it: `docker compose down`. To update later: `git pull` then `docker compose up -d --build`.
- Want the offline voice feature (talk/listen) inside Docker? Use the voice image instead:
  `docker compose --profile voice up -d --build mercury-voice` (bigger download — it bundles the
  speech engines).

> This runs Mercury on *your* machine/server. Anyone who should reach it from another device needs
> network access to it; for internet exposure put it behind a reverse proxy with HTTPS. That's an
> advanced step — for personal use, `localhost` is perfect.

To update a non-Docker install at any time:

```bash
mercury update        # does: git pull + npm install + build
```

---

## 8. Everyday settings

You rarely need to edit files by hand — use these commands (or the web **Settings** panel).

**Switch brains anytime:**
```bash
mercury model ollama/llama3.1      # go local/free
mercury model chatllm/route-llm    # go cloud
```

**See every setting / change one:**
```bash
mercury config                     # show all settings
mercury config get llm.defaultModel
mercury config set <key> <value>
```

**Add another login (e.g. for a family member):**
```bash
mercury user add alice s3cretpass          # normal user
mercury user add bob  s3cretpass --admin   # another admin
```

**Forgot a password? Reset it** (you need access to the computer Mercury runs on):
```bash
mercury user passwd alice a-new-password
```
Passwords are stored only as encrypted hashes, so the old one can't be recovered — only replaced.

**Where your stuff lives:** everything (accounts, memory, settings) is in the hidden folder
`~/.mercury` on your computer. Back that folder up and you've backed up everything.

---

## 9. If something goes wrong

**Run the built-in check first — it usually tells you exactly what's missing:**
```bash
mercury doctor
```

| Problem | Likely fix |
| --- | --- |
| `node: command not found` or version too low | Install Node.js ≥ 22.5 from nodejs.org (section 1) |
| Mercury says it has no model / won't answer | You skipped the brain step — do section 4a or 4b |
| Ollama answers are failing | Make sure Ollama is installed and running, and you ran `ollama pull llama3.1` |
| ChatLLM says unauthorized | Check `CHATLLM_API_KEY` in `~/.mercury/.env` is your real, current key |
| Web page won't open | Make sure `mercury serve` (or `docker compose up -d`) is running, then open <http://localhost:3000> |
| Forgot admin password | `mercury user passwd <name> <new-password>` on the host machine (section 8) |

Still stuck? `mercury help <topic>` and the web **Help** panel document everything in detail, and
the main [README](../README.md) links the full guides.

---

*You're done.* Pick a brain, type `mercury chat`, and start asking. Everything runs on your own
computer, on your terms.
