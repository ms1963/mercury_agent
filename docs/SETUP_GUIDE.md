# Mercury Agent — Fresh Setup Guide (for dummies)

**Your target setup:**
- **LLM:** OpenRouter, using **Claude Sonnet** as the model
- **Decisions:** **Jev** (OpenRouter's Decisions API)
- **Integrations:** **Gmail** (send/receive email) and **Telegram** (chat with a bot)
- **Interface:** **Web UI** and/or **CLI**
- **Voice:** **offline** Speech‑to‑Text (whisper) and Text‑to‑Speech (piper)

This guide assumes a **Mac** (since that's where you run Mercury). Linux is nearly identical — only the "install the tools" commands differ, and I note them where it matters. Follow the steps top to bottom. Every box is copy‑paste.

> Throughout, `~` means your home folder (e.g. `/Users/michael`). Mercury keeps **all its data** in `~/.mercury`.

---

## STEP 0 — (If you had Mercury before) wipe the old install first

You said you want a *fresh* install. If an old one exists, remove it so nothing stale interferes. Use the uninstall script I gave you earlier:

```zsh
bash ~/mercury-uninstall.sh --backup
```

(`--backup` first saves your old memory/sessions to a `.mbak` file in case you want them later. If you never installed Mercury before, skip this step.)

---

## STEP 1 — Install the prerequisites (one time)

Mercury needs **Node.js 22.5 or newer** and **git**. The offline voice features need **ffmpeg**, **whisper** and **piper**. Easiest way on a Mac is [Homebrew](https://brew.sh).

**1a. Install Homebrew (skip if you already have `brew`):**
```zsh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

**1b. Install Node, git, and the voice tools:**
```zsh
brew install node git ffmpeg
```

Check Node is new enough (must say v22.5 or higher):
```zsh
node --version
```

**1c. Install the offline voice engines** (we'll configure them in Step 7):
```zsh
# Offline Speech-to-Text (OpenAI Whisper, runs 100% locally after download)
pip3 install -U openai-whisper

# Offline Text-to-Speech (Piper, local neural TTS)
pip3 install -U piper-tts
```
> If `pip3` is missing: `brew install python` then retry. On Linux use `apt install ffmpeg python3-pip` instead of brew, then the same `pip3` lines.

---

## STEP 2 — Download and build Mercury

```zsh
cd ~
git clone https://github.com/ms1963/mercury_agent.git mercury
cd mercury
npm install
npm run build
```

Now make the `mercury` command available everywhere:
```zsh
./install.sh
```

Test it:
```zsh
mercury --help
```
You should see the Mercury help text. If `mercury: command not found`, close and reopen Terminal, then try again.

---

## STEP 3 — Get your OpenRouter API key

1. Go to **https://openrouter.ai/keys** and sign in.
2. Click **Create Key**, copy it (it looks like `sk-or-v1-...`).
3. Make sure you have some credit on your OpenRouter account (Settings → Credits). Sonnet is a paid model.

> This **one** key powers both the LLM (Sonnet) **and** Jev decisions — you don't need a second key.

---

## STEP 4 — Put your secrets in Mercury's `.env` file

Mercury reads secrets from `~/.mercury/.env`. Create the folder and file:

```zsh
mkdir -p ~/.mercury
```

Open the file in a text editor:
```zsh
open -e ~/.mercury/.env      # macOS TextEdit  (Linux: nano ~/.mercury/.env)
```

Paste the following, replacing the placeholder values with your real ones (we'll get the Telegram token in Step 6 and the Gmail password in Step 5 — you can come back and fill those in later):

```ini
# --- LLM + Jev decisions (same key for both) ---
OPENROUTER_API_KEY=sk-or-v1-REPLACE_WITH_YOUR_KEY

# --- Gmail integration (Step 5) ---
EMAIL_USER=your.name@gmail.com
EMAIL_PASSWORD=your-16-char-gmail-app-password

# --- Telegram integration (Step 6) ---
TELEGRAM_BOT_TOKEN=123456789:REPLACE_WITH_YOUR_BOT_TOKEN
```

Save and close the editor.

> **Why env vars?** Mercury auto‑enables the OpenRouter provider the moment it sees `OPENROUTER_API_KEY`, and keeps your secrets out of the main config file. Never paste keys into `config.yaml`.

---

## STEP 5 — Create a Gmail App Password (for the Gmail integration)

Gmail will **not** accept your normal password from apps. You need a 16‑character **App Password**, which requires 2‑Step Verification.

1. Turn on 2‑Step Verification: **https://myaccount.google.com/signinoptions/two-step-verification**
2. Create an App Password: **https://myaccount.google.com/apppasswords**
   - Name it e.g. "Mercury", click **Create**.
   - Google shows a 16‑character password like `abcd efgh ijkl mnop`.
3. Put it (spaces removed) into `~/.mercury/.env` as `EMAIL_PASSWORD`, and your Gmail address as `EMAIL_USER`.

That's all you need from Google — Mercury connects over standard IMAP (reading) and SMTP (sending).

---

## STEP 6 — Create a Telegram bot

1. In the Telegram app, search for **@BotFather** and open the chat.
2. Send `/newbot`, follow the prompts (give it a name and a username ending in `bot`).
3. BotFather replies with a **token** like `123456789:AAE...`. Copy it.
4. Put it into `~/.mercury/.env` as `TELEGRAM_BOT_TOKEN`.

---

## STEP 7 — Write the Mercury configuration

Now we tell Mercury which model to use, to use Jev, and how to connect Gmail, Telegram, and the offline voice engines. The easiest reliable way is to create the config file directly.

Open it:
```zsh
open -e ~/.mercury/config.yaml      # Linux: nano ~/.mercury/config.yaml
```

Paste **exactly** this (then read the notes below it):

```yaml
version: 1

llm:
  defaultModel: openrouter/anthropic/claude-sonnet-5.5
  providers:
    openrouter:
      type: openrouter
      enabled: true
      # API key comes from OPENROUTER_API_KEY in .env (no need to put it here)

# Deterministic: always use the model above (don't let the router pick another)
router:
  enabled: false

# Jev decision engine (OpenRouter Decisions API). 'auto' already turns Jev on when
# OPENROUTER_API_KEY is set; this makes it explicit.
decision:
  provider: jev
  jev:
    model: typesafe/jev-1.13
    baseUrl: https://openrouter.ai/api/alpha
    apiKeyEnv: OPENROUTER_API_KEY

# Gmail + Telegram integrations
gateway:
  enabled: true
  pairing: true
  adapters:
    telegram:
      # token comes from TELEGRAM_BOT_TOKEN in .env
      enabled: true
    email:
      enabled: true
      imapHost: imap.gmail.com
      imapPort: 993
      imapSecure: true
      smtpHost: smtp.gmail.com
      smtpPort: 587
      smtpSecure: false
      # user/pass come from EMAIL_USER / EMAIL_PASSWORD in .env
      intervalMs: 60000

# Offline voice: Speech-to-Text with Whisper, Text-to-Speech with Piper
voice:
  stt:
    provider: whisper          # runs locally via the openai-whisper CLI — NO API key of any kind
  tts:
    provider: piper            # runs locally via the piper CLI
    # Point this at the voice model you download in Step 7b (use the FULL path):
    command: "piper --model /Users/REPLACE_ME/.mercury/voices/en_US-lessac-medium.onnx --output_file {output}"

# Scheduler time zone (natural-language "at 5pm" uses this; defaults to your Mac's zone)
scheduler:
  timezone: Europe/Berlin
```

### Notes on the config
- **The model id** `openrouter/anthropic/claude-sonnet-5.5` = "use OpenRouter's Claude Sonnet 5.5" (the current top Sonnet, released Sep 2026). After setup, run `mercury model` to list what's available, or check **https://openrouter.ai/models** — if OpenRouter lists a newer Sonnet slug, just swap the part after `openrouter/`. If you'd rather always track the newest Sonnet automatically, you can use the alias `openrouter/anthropic/claude-sonnet-latest` instead.
- **`router.enabled: false`** makes Mercury always use Sonnet. (Leaving it on lets Mercury auto‑pick among models — fine too, but less predictable.)
- **Jev** needs no extra key and the `/api/alpha` URL is correct — that's OpenRouter's **Decisions** endpoint, which is deliberately different from the chat endpoint.
- **`scheduler.timezone`** — change `Europe/Berlin` to your zone, or set it later with `mercury timezone set <Area/City>`.

### 7a. Optional: automatic fallback chain & criteria-based routing

Two optional, backward-compatible blocks under `llm:` make Mercury more resilient and smarter about
which model handles which request. Both are empty/off by default — add them only if you want them.

**Fallback chain (`llm.fallback`).** An *ordered* list of `provider/model` pairs that Mercury tries, in
order, whenever the primary model is **unavailable** — model-not-found, a bad/missing API key (401/403),
a refused connection (a local backend is down), or rate-limit/overload (429/503/529). Request-intrinsic
errors (context too large, bad request, content-policy) are **not** retried on another model.

```yaml
llm:
  defaultModel: openrouter/anthropic/claude-sonnet-5.5
  fallback:
    - { provider: openrouter, model: openai/gpt-4o-mini }   # tried if Sonnet is unavailable
    - { provider: ollama, model: llama3.1 }                 # last resort: local, always available
```

You can manage it from the CLI instead of editing YAML by hand:
```zsh
mercury fallback add openrouter openai/gpt-4o-mini
mercury fallback add ollama llama3.1
mercury fallback list
mercury fallback remove ollama llama3.1 --force
```

**Criteria-based routing (`llm.routing`).** A list of `provider/model` entries, each tagged with the
**criteria** it serves (from the profile tag vocabulary `general`, `code`, `reasoning`, `fast`, `cheap`,
`vision`, `local`, `private`). For each request Mercury picks the **most specific** entry whose criteria
are all satisfied. An entry with **no criteria, or exactly `default`**, is the general-purpose catch-all.
The selected model still benefits from the fallback chain above if it is unavailable.

```yaml
llm:
  routing:
    - { provider: anthropic, model: claude-sonnet-4-5, criteria: [code, reasoning] }
    - { provider: openrouter, model: openai/gpt-4o-mini, criteria: [fast, cheap] }
    - { provider: ollama, model: llama3.1, criteria: [private, local] }
    - { provider: openrouter, model: anthropic/claude-sonnet-5.5, criteria: [default] }  # catch-all
```

Or from the CLI:
```zsh
mercury route add anthropic claude-sonnet-4-5 code reasoning
mercury route add openrouter openai/gpt-4o-mini fast cheap
mercury route add openrouter anthropic/claude-sonnet-5.5 default
mercury route list
```

> Every referenced provider must be configured (under `llm.providers` or via its env key) for the id to
> resolve. See `mercury help fallback` and `mercury help route` for the full reference.

### 7c. Optional (advanced / HIGH-RISK): self-extending tools

Mercury can **draft a brand-new tool by itself** when it repeatedly needs a capability no registered
tool provides. Because this means Mercury writing and running its own code, it is **DISABLED BY
DEFAULT** and you should leave it off unless you understand the risk. Everything below the master switch
is a hard no-op until you enable it.

```zsh
mercury selfextend status          # shows DISABLED by default
mercury selfextend enable          # turn the feature ON (writes selfExtension.enabled: true)
mercury selfextend gaps            # capability gaps tracked so far
mercury selfextend list pending    # drafts awaiting your approval
mercury selfextend approve <id>    # approve a validated draft for its first run
mercury selfextend disable         # kill-switch: turn it back off
```

Even when enabled, a drafted tool must **compile, pass a generated unit test, stay within a
least-privilege capability manifest (deny-by-default), and be approved by you** before it can ever run —
and it runs **out-of-process** with a scrubbed environment, no network unless you granted it, and
time/output limits. Grants (`selfExtension.allowFilesystem` / `allowNetwork` / `allowedHosts` /
`allowShell`) are all off by default. See `mercury help selfextend` and `docs/GAPS.md` §2b for the full
threat model.

### 7b. Download a Piper voice (needed for offline TTS)
Piper needs a voice model file. Download a good English one:
```zsh
mkdir -p ~/.mercury/voices && cd ~/.mercury/voices
curl -L -o en_US-lessac-medium.onnx \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx
curl -L -o en_US-lessac-medium.onnx.json \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json
```
Then in `config.yaml`, replace `/Users/REPLACE_ME/` in the piper `command:` line with your real home path. Find it with:
```zsh
echo "$HOME"
```

> **No OpenAI key for speech‑to‑text.** The `whisper` provider is OpenAI's *open‑source* model that you installed with `pip3 install openai-whisper` in Step 1 — it runs entirely on your Mac and asks for **no API key**. The "openai" in the package name is just the model's origin, not a cloud account. (Only Mercury's separate `provider: openai` STT option would need a key, and this guide never uses it — so there is nothing OpenAI‑related to sign up for or pay.)
>
> **Whisper first run:** the first time you use speech‑to‑text, Whisper downloads its model (a few hundred MB) once, then works fully offline. To use a specific size, you can set `voice.stt.command` to e.g. `whisper {input} --model small --output_format txt --output_dir {outdir}`.

---

## STEP 8 — Create your login & start Mercury

**8a. Create your admin account** (used by the Web UI):
```zsh
mercury setup --username michael --password "choose-a-strong-password"
```
When it asks for a provider/model, you can just press Enter (your `config.yaml` already set them).

**8b. Try the CLI** (quickest check it all works):
```zsh
mercury
```
At the `›` prompt type `who am i` and press Enter. You should get a real answer from Sonnet (not a 401). Type `/help` for commands, `Ctrl+D` to exit.

**8c. Start the Web UI:**
```zsh
mercury serve
```
Open **http://localhost:3000** in your browser and log in with the account from 8a. Leave this Terminal window running while you use the web UI (press `Ctrl+C` to stop it).

**8d. Start the integrations (Gmail + Telegram):**
Open a **new** Terminal window (so the web UI keeps running) and run:
```zsh
mercury gateway start
```
This begins polling Gmail and listening for Telegram messages. Leave it running.

---

## STEP 9 — Link (pair) your Telegram & email so Mercury trusts them

For security, Mercury only talks to **paired** accounts. First time:

1. **Telegram:** open your bot in Telegram and send it any message (e.g. "hi"). The bot replies with a **pairing code**.
2. In a Terminal, approve it:
   ```zsh
   mercury gateway pair <THE-CODE> --user michael
   ```
3. **Gmail:** send an email to your own Gmail address (the `EMAIL_USER` one) — or have someone email it. Mercury replies with a pairing code; approve it the same way:
   ```zsh
   mercury gateway pair <THE-CODE> --user michael
   ```

After pairing, just message the Telegram bot or email the account and Mercury will respond. (To see codes waiting for approval: `mercury gateway pending`.)

---

## STEP 10 — Use voice (offline)

Voice works through the CLI and the integrations:
- Send the **Telegram bot a voice message** → Mercury transcribes it with Whisper (offline), answers, and can reply with Piper‑generated speech.
- Everything stays on your Mac; no audio is sent to any cloud.

Quick test that the engines are wired up:
```zsh
mercury voice            # shows the active STT/TTS providers (should say whisper / piper)
```

---

## Daily use — the short version

| I want to… | Command |
|---|---|
| Chat in the terminal | `mercury` |
| One‑off question | `mercury chat "summarize my day"` |
| Open the web app | `mercury serve` → http://localhost:3000 |
| Turn on Gmail + Telegram | `mercury gateway start` |
| Change the model | `mercury model openrouter/anthropic/claude-sonnet-5.5` |
| See available models | `mercury model` |
| Change the time zone | `mercury timezone set Europe/Berlin` |
| Approve a new Telegram/email contact | `mercury gateway pair <CODE> --user michael` |

---

## If something goes wrong

- **`401 ... "Missing Authentication header"`** → your `OPENROUTER_API_KEY` isn't set. Check `~/.mercury/.env` has the real key, then restart the command. (Open a fresh Terminal so it reloads.)
- **`401 "No auth credentials found"` or `403`** → the key is wrong/expired or out of credit. Make a new key at openrouter.ai/keys and top up credit.
- **Model id rejected** → run `mercury model` and copy an exact id from the list; update `llm.defaultModel`.
- **Gmail won't connect** → you must use a 16‑char **App Password** (Step 5), not your normal Gmail password, and 2‑Step Verification must be on.
- **Telegram silent** → make sure `mercury gateway start` is running and you've paired (Step 9). One bot token = one running gateway.
- **No sound / no transcription** → confirm `whisper` and `piper` are installed (`which whisper`, `which piper`) and the piper `command:` path in `config.yaml` points to a real `.onnx` file.
- **"at 5pm" scheduled at the wrong hour** → set your zone: `mercury timezone set <Area/City>`.

---

That's the whole setup. Once Steps 1–9 are done, you have OpenRouter + Sonnet + Jev, Gmail and Telegram, Web UI and CLI, and offline voice — all running locally on your Mac.
