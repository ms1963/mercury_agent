# Getting Started with Mercury

![Mercury Agent](../assets/mercury_agent.png)

*The friendly, no-jargon installation guide — for people who just want it to work.*

---

## Hello! 👋 Let's get you up and running

So you've heard about **Mercury**, your own private AI assistant that lives on *your* computer, and
you'd like to actually use it. Wonderful. You've come to the right page.

Here's the honest truth up front: **you do not need to be a programmer or an "IT person" to do this.**
If you can install an app, copy-and-paste a line of text, and follow a recipe, you can set up Mercury.
We'll go slowly, explain *why* at each step, and crack the occasional joke so it doesn't feel like
reading a tax form. 🧾

### What you're about to do (the whole journey on one page)

Think of it like adopting a very clever parrot 🦜 that can run errands:

1. **Build the cage** — install Mercury (a one-time thing).
2. **Give it a brain** — connect it to an AI service (**ChatLLM** or **Ollama**). Mercury is smart about
   *how* to think, but the actual "thinking power" comes from an AI you plug in. No brain, no answers.
3. **(Optional) Give it good judgment** — connect **Jev**, a little decision-helper that makes Mercury
   smarter about *which* model to use and *when* to ask your permission. Totally optional.
4. **Talk to it** — and enjoy your new assistant.

That's it. Four steps. Grab a coffee ☕ and let's go.

> **A quick promise about your privacy:** Mercury runs on your own machine and keeps your data in a
> hidden folder in your home directory. Nothing leaves your computer except the messages you send to
> the AI service *you* chose. You're in charge.

---

## Step 0 — The one thing to check first (2 minutes)

Mercury runs on a free, widely-used program called **Node.js**. It's the engine under the hood. You
need version **22.5 or newer**. Let's check if you already have it.

**Open a terminal.** Don't panic — a terminal is just a text box where you type commands:

- **Windows:** press the Start button, type **PowerShell**, and open it.
- **Mac:** press `Cmd + Space`, type **Terminal**, and hit Enter.
- **Linux:** you already know where your terminal is. 😎

Now type this and press Enter:

```
node -v
```

- If you see something like **`v22.5.0`** or higher → 🎉 you're ready, skip to Step 1.
- If you see an error, or a *smaller* number (like `v18.x`) → pop over to **https://nodejs.org**,
  download the big green **"LTS"** button, install it (Next → Next → Finish, like any app), then
  run `node -v` again to confirm.

That's the only thing you ever install by hand. Everything else, Mercury handles for you. 🙌

---

## Step 1 — Install Mercury (one time only)

First, make sure you have the Mercury folder on your computer (the one you downloaded or unzipped).
In your terminal, "walk into" that folder and run three lines, **one at a time**, pressing Enter after
each. Some take a minute — that's normal, go sip the coffee.

```
cd mercury
npm install
npm run build
```

What just happened, in plain English:

| Command | What it does | Mental picture |
| --- | --- | --- |
| `cd mercury` | Steps into the Mercury folder | Walking into the workshop 🚪 |
| `npm install` | Downloads the parts Mercury needs | Delivery truck drops off supplies 📦 |
| `npm run build` | Assembles those parts, ready to run | Snapping the LEGO together 🧱 |

> 💡 You might see a yellow **warning** about "esbuild" or "SQLite is experimental". **Ignore it.**
> Warnings are not errors — they're the computer clearing its throat, not refusing to work.

**Make `mercury` a magic word (optional but nice).** Run this so you can type just `mercury` anywhere:

```
./install.sh
```

If that throws a permissions grumble, no stress — everywhere this guide says `mercury`, you can instead
type `node packages/cli/dist/bin.js`. It does the exact same thing, just wordier. (For brevity we'll
write `mercury` from here on.)

✅ **Done with installation!** You never have to do Step 0 or Step 1 again.

---

## Step 2 — Give Mercury a brain 🧠

Mercury is like a brilliant assistant who speaks every language but needs a phone line to "the smart
part." That phone line is an **AI service**. You connect **one**, once.

You have two great starting options, and we'll cover **both**:

- 🌩️ **ChatLLM** (from Abacus.AI) — a cloud service. Easiest, nothing to install, great models.
  Needs an internet connection and a key (a free-to-get password-like code).
- 🏠 **Ollama** — runs AI **entirely on your own computer**. Totally free, totally private, works
  offline. Needs a one-time app install and a reasonably modern computer.

Not sure which? **Pick ChatLLM if you want the easiest path and don't mind a cloud service. Pick
Ollama if you want everything private and free on your own machine.** You can always switch later.

The friendly way to connect either one is the **setup wizard**, which asks simple questions:

```
mercury setup
```

It will first ask you to **create a login** (pick a username and password — the first account you make
becomes the admin, i.e. the boss 👑). Then it asks which AI service to use. Below are the details for
each of our two options.

---

### Option A — Connect ChatLLM (the easy cloud option) 🌩️

**1. Get your key.** Log into your Abacus.AI / ChatLLM account and copy your API key. It looks like a
long code, e.g. `s2-xxxxxxxxxxxx`. Think of it as a hotel key-card 🏨 — it proves you're allowed in.

**2. Tell Mercury about it.** Easiest is to let the setup wizard ask for it. If you'd rather do it by
hand, just paste your key into Mercury's private settings with this one line (replace the `s2-...` part
with your real key):

```
echo 'CHATLLM_API_KEY=s2-your-real-key-here' >> ~/.mercury/.env
```

> That `~/.mercury/.env` file is Mercury's private vault for secrets. It stays on your computer. Keys
> live *there*, never in the main settings file. 🔐

**3. Pick a model.** ChatLLM has a clever "RouteLLM" option that automatically picks the best model
for each question — a great default:

```
mercury model chatllm/route-llm
```

Prefer a specific model? You can name one instead, e.g. `mercury model chatllm/gpt-4o-mini`.

**That's it — ChatLLM is connected.** 🎉 (Fun fact: Mercury auto-enables ChatLLM the moment it sees
your key, so there's nothing else to switch on.) Jump to **Step 4** to start chatting — or peek at the
optional **Step 3** first.

---

### Option B — Connect Ollama (free & private, on your computer) 🏠

Ollama lets Mercury think using AI models running **right on your own machine** — no key, no cloud, no
bill, works on an airplane. ✈️ The trade-off: the first-time setup is a touch more involved, and bigger
models want a decent computer.

**1. Install Ollama.** Go to **https://ollama.com**, download it for your system, and install it like
any normal app. Once installed, it quietly runs in the background.

**2. Download a model (its "brain").** In your terminal, pull one. `llama3.1` is a solid all-rounder:

```
ollama pull llama3.1
```

This downloads a few gigabytes once (go refill the coffee ☕). You only do this per model.

**3. Tell Mercury to use Ollama:**

```
mercury config set llm.providers.ollama '{"type":"ollama","enabled":true}'
mercury model ollama/llama3.1
```

The first line flips Ollama "on" inside Mercury; the second says "use the llama3.1 brain."

**That's it — Ollama is connected,** and it all runs on your computer. 🎉 (If you ever run Ollama on a
*different* machine, you can point Mercury at it, but for most people the default local setup just works.)

> 🧊 **LM Studio** is another "runs-on-your-computer" option that works the same way — install the app,
> start its local server, then `mercury config set llm.providers.lmstudio '{"type":"lmstudio","enabled":true}'`.

---

## Step 3 — (Optional) Give Mercury good judgment with Jev 🧭

**You can completely skip this step** and Mercury works great. But if you're curious, here's what Jev
does and how to switch it on.

**What is Jev?** Mercury constantly makes little behind-the-scenes decisions: *Which AI model is best
for this question? Is this message trying to trick me? Should I ask the human before deleting that
file? Should I try again or give up?* **Jev** is a specialized "decision-helper"
that makes those judgment calls sharper and safer. Think of it as hiring a wise,
level-headed advisor 🧓 who sits next to your assistant and whispers good advice.

**What happens if you don't use it?** Nothing bad at all — Mercury simply uses your main AI (or a
safe built-in rule of thumb) to make those same decisions. Jev is a *nice-to-have*, not a must-have.

**How to turn it on.** Jev runs through **OpenRouter**, so you just need an OpenRouter key:

```
echo 'OPENROUTER_API_KEY=sk-or-your-real-key-here' >> ~/.mercury/.env
```

Get that key for free-to-start at **https://openrouter.ai**. The moment Mercury sees this key, Jev
becomes available automatically. By default (`decision.provider: auto`), Mercury will *use Jev when
it's available and sensible,* and quietly fall back to your main AI otherwise. You don't have to do
anything else.

Want to be explicit about it? You can set the behavior:

| If you want… | Run this |
| --- | --- |
| Mercury to decide automatically (recommended) | *(do nothing — this is the default)* |
| Always use Jev | `mercury config set decision.provider jev` |
| Never use Jev, just use my main AI | `mercury config set decision.provider llm` |

> 💡 Jev and your main AI are separate hats. Your main AI (Step 2) writes the answers; Jev (this step)
> just helps Mercury make smart choices. You can have one, both, or just the first.

---

## Step 4 — Use Mercury! 🚀

The fun part. There are two ways to talk to Mercury — pick whichever feels nicer.

### Way 1 — The web page (feels like any chat app, recommended) 💬

Start Mercury:

```
mercury serve
```

Then open your web browser and go to:

```
http://localhost:3000
```

Log in with the username and password you created in Step 2, and start chatting like you would with any
AI chat app. 

- Keep that terminal window **open** while you use Mercury — that's the engine running.
- To **stop** Mercury, click the terminal and press **Ctrl + C**.
- Next time, you only need `mercury serve` again — setup is already done. 🙌

> On a busy computer you might see "port already in use." Easy fix: `mercury serve --port 8080`, then
> open `http://localhost:8080` instead.

### Way 2 — Straight from the terminal (great for quick questions) ⌨️

Ask a one-off question:

```
mercury chat "What's a good recipe for banana bread?"
```

Or start a back-and-forth conversation (type `exit` when you're done):

```
mercury chat
```

### What makes Mercury special: it's an *agent* 🤖

Here's the magic — **you don't launch a separate "agent."** Every chat already *is* one. Ask Mercury to
do something multi-step, and it will reason, use tools, check its work, and keep going until it's
finished. Try this:

```
mercury chat "Find the 3 newest files in my Downloads folder and summarize each one"
```

Watch it pick the right tools and work through the steps by itself. That's a complete agent run — no
extra setup needed.

> 🛡️ **Safety tip:** Mercury can use "tools" (like running commands or editing files). By default it's
> cautious and will *ask your permission* before anything sensitive. You can review this with
> `mercury tools list` and adjust with `mercury config set tools.approvals.mode smart`.

---

## Doing more: prompts, agents & settings 🛠️

Once Mercury is answering you, here's how to get real work out of it. Everything below works from the
terminal; the web page has buttons for most of it too. (Remember: wherever you see `mercury`, you can
type `node packages/cli/dist/bin.js` instead if the shortcut didn't install.)

### A. Sending prompts (the many ways to ask) 💬

**One quick question** — Mercury answers and exits:

```
mercury chat "Summarize the plot of Hamlet in 3 sentences"
```

**A back-and-forth conversation** — keeps context until you type `exit`:

```
mercury chat
```

**Keep a conversation for later.** Give it a *session* name and reuse it tomorrow — Mercury remembers
what you talked about:

```
mercury chat --session trip-planning "Help me plan a 5-day trip to Lisbon"
# ...later...
mercury chat --session trip-planning "Add a day trip to Sintra"
```

**Ask a specific AI model** for one answer (handy if you connected more than one):

```
mercury chat --model ollama/llama3.1 "Explain how a rainbow forms"
```

**Change *how* Mercury thinks** with `--pattern`. A pattern is a thinking style. The useful ones:

| Pattern | Best for | Try it |
| --- | --- | --- |
| `react` | Everyday tasks (the default) | `mercury chat --pattern react "..."` |
| `cot` | Step-by-step reasoning, puzzles | `mercury chat --pattern cot "If a train..."` |
| `plan-execute` | Bigger multi-step jobs | `mercury chat --pattern plan-execute "Research and outline a blog post about bees"` |
| `reflexion` | When you want it to double-check itself | `mercury chat --pattern reflexion "Proofread this paragraph: ..."` |

> 💡 You rarely *need* to pick a pattern — leave it out and Mercury chooses a sensible one. It's there
> for when you want more care or more planning.

**From the web page**, you just type in the chat box — model, session and pattern are pickable in the
interface, no flags needed.

### B. Creating agents 🤖

In Mercury, an "agent" isn't a separate program you launch — **every chat is already an agent** that can
plan and use tools. "Creating an agent" really means *shaping* one. Three practical ways:

**1. Give it a personality.** A personality is just a short text file describing how Mercury should act.
Create one in your home folder under `~/.mercury/personalities/` — the **file name becomes the
personality name**:

```
# file: ~/.mercury/personalities/coach.md
# Coach
You are Mercury, an upbeat personal coach. Be encouraging, ask one clarifying
question when useful, and end each reply with a small, concrete next step.
```

Turn it on so every chat uses it:

```
mercury config set agent.personality coach
```

Mercury ships with a few to try (`default`, `concise`, `teacher`, `pirate`) — set `agent.personality
pirate` for a laugh. 🏴‍☠️

**2. Make a scheduled agent** that runs on its own, even when you're not watching. For example, a daily
news summary at 9am:

```
mercury schedule add --when "every day at 9am" Summarize today's top AI headlines
```

Manage them easily:

```
mercury schedule list            # see all your scheduled agents
mercury schedule run <id>        # run one right now to test it
mercury schedule pause <id>      # or resume / delete
```

> To have results delivered to a chat app (once you've connected one), add `--deliver telegram:<chat-id>`.

**3. Build a team of agents (a workflow).** For a job where several specialists cooperate, Mercury has
ready-made *workflows* — like a `dev-team` (a coordinator, an engineer, a reviewer) or a `debate`:

```
mercury workflow list                               # see the available teams
mercury workflow run research-report "The history of coffee"
```

Want your own tool, skill, or team template? Mercury scaffolds a starter file for you:

```
mercury new skill my-first-skill
mercury new workflow my-team
```

(These land in `~/.mercury/`; tools and skills hot-reload, so they're available immediately. See
**GUIDE.md** / **EXTENDING.md** for filling them in.)

### C. Changing parameters & configuration ⚙️

Mercury keeps its settings in one file at `~/.mercury/config.yaml`. You don't have to edit it by hand —
the `config` command does it safely.

**See a setting, or see everything:**

```
mercury config path              # where your config file lives
mercury config get agent         # show all agent settings
mercury config get llm.defaultModel
```

**Change a setting** (it's saved immediately — restart `mercury serve` to apply):

```
mercury config set llm.defaultModel ollama/llama3.1
mercury config set agent.temperature 0.7
```

The settings you'll most likely want:

| Setting | What it controls | Example |
| --- | --- | --- |
| `llm.defaultModel` | Which AI it uses by default | `mercury config set llm.defaultModel chatllm/route-llm` |
| `agent.personality` | Its tone/persona | `mercury config set agent.personality concise` |
| `agent.pattern` | Default thinking style | `mercury config set agent.pattern plan-execute` |
| `agent.temperature` | Creativity (0 = focused, 1 = playful) | `mercury config set agent.temperature 0.5` |
| `agent.maxIterations` | How many steps it may take on a task | `mercury config set agent.maxIterations 20` |
| `tools.approvals.mode` | How cautious it is with tools (`manual` / `smart` / `auto` / `deny`) | `mercury config set tools.approvals.mode smart` |
| `server.port` | The web page's port | `mercury config set server.port 8080` |

> 🛡️ **About `tools.approvals.mode`:** `manual` (the default) asks before every tool (safest), `smart`
> asks only for risky things (a good balance), `auto` never asks and just runs them (fastest, least
> cautious), and `deny` blocks tools that would need approval. Start with the default, or `smart`.

**Prefer not to touch config at all?** You can set things for a single run with environment variables —
handy for a quick experiment:

```
MERCURY_MODEL=ollama/llama3.1 mercury chat "hello"
```

That's the whole toolkit: **ask** (prompts), **shape** (agents), **tune** (config). Mix and match as you
go — nothing here is permanent, and `mercury config set` can always change it back.

---

## Everyday cheat-sheet 📋

You don't need to memorize these — the web page has buttons for most — but here are the handy ones:

| I want to… | Type this |
| --- | --- |
| Start Mercury (web page) | `mercury serve` |
| Ask a quick question | `mercury chat "your question"` |
| Check everything is healthy | `mercury doctor` |
| See / switch which AI it uses | `mercury model` |
| See what tools it has | `mercury tools list` |
| See all commands | `mercury help` |

---

## If something doesn't work 🔧 (don't worry, we've got you)

**Golden rule: run the doctor first.** It checks everything and tells you exactly what's missing:

```
mercury doctor
```

| What you see | What it means | What to do |
| --- | --- | --- |
| "node:sqlite not found" or a version complaint | Node.js is too old | Install the latest **LTS** from **https://nodejs.org**, then retry |
| "no provider" / it won't answer | No AI connected yet | Re-run `mercury setup`, or start your Ollama app |
| "port already in use" | Something's on port 3000 | `mercury serve --port 8080`, open `http://localhost:8080` |
| "SQLite is experimental" | Totally normal | Ignore it 😌 |
| `mercury: command not found` | The shortcut didn't install | Use `node packages/cli/dist/bin.js` instead of `mercury` |

**Want to prove Mercury itself works before connecting any AI?** Run this offline test — it should
reply `Echo: hello`:

```
MERCURY_ENABLE_MOCK=1 mercury chat "hello"
```

If you get that echo, Mercury is healthy — you just need to connect a real AI (Step 2) for real answers.
(This "echo mode" is only for testing; it doesn't actually think.)

---

## You're all set! 🎈

Let's recap your journey:

1. ✅ Installed Mercury (`npm install`, `npm run build`).
2. ✅ Gave it a brain — **ChatLLM** (cloud) or **Ollama** (your computer).
3. ✅ (Optional) Gave it good judgment with **Jev**.
4. ✅ Started chatting with `mercury serve` → `http://localhost:3000`.

From here, explore! Ask it to draft emails, plan a trip, summarize documents, write a to-do list, or
tackle a multi-step project. The more you use it, the more it learns (it builds up memory and skills
over time).

**Want to go deeper?** When you're ready for the advanced stuff — connecting Mercury to chat apps like
Telegram or Slack, adding more tools via MCP, multi-agent "teams," or deploying it for a group — open
**GUIDE.md** for the complete manual, or **QUICK.md** for another quick tour.

Enjoy your new assistant. 🦜✨
