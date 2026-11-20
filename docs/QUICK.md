![Mercury Agent](../assets/mercury_agent.png)

# Mercury — Quick Start for Everyone

A short, friendly guide to getting Mercury running and talking to it — **no IT background needed**.
You'll do three things: **1) Install it**, **2) Set it up**, **3) Use it**. Each step is copy‑and‑paste.

> Think of Mercury as your own private AI assistant that runs on your computer. It doesn't come with a
> brain of its own — you connect it to an AI service (free or paid) once, and then it's ready to chat,
> use tools, and help you with tasks.

If anything goes wrong, jump to **"If something doesn't work"** at the bottom. For the complete manual,
see **GUIDE.md**.

---

## Before you start (one‑time check)

Mercury needs a free program called **Node.js** (version 22.5 or newer). To check if you have it:

1. Open a **terminal** (on Mac: open the *Terminal* app; on Windows: open *PowerShell*; on Linux: your
   terminal).
2. Type this and press Enter:

   ```
   node -v
   ```

3. If you see a number like `v22.5.0` or higher, you're good. If you see an error or a lower number, go
   to **https://nodejs.org**, download the "LTS" version, install it (just click Next/Next/Finish), then
   check again.

That's the only thing you need to install by hand. Everything else is automatic.

---

## Step 1 — Install Mercury

In your terminal, go to the Mercury folder (the one you downloaded/unzipped) and run these three lines,
one at a time, pressing Enter after each. Each may take a minute.

```
cd mercury
npm install
npm run build
```

- `cd mercury` — enters the Mercury folder.
- `npm install` — downloads the pieces Mercury needs.
- `npm run build` — gets Mercury ready to run.

> On older npm you might see a yellow warning about "esbuild". **Ignore it** — it's harmless (newer
> npm no longer shows it, since the script is pre-approved in `package.json`).

To make the word `mercury` work as a command from anywhere, you can also run:

```
./install.sh
```

If that gives a permissions error, don't worry — you can still do everything below by typing
`node packages/cli/dist/bin.js` instead of `mercury` (they do exactly the same thing).

**Prefer an all‑in‑one box? (Docker)** If you happen to have Docker installed, a single command runs
everything for you:

```
docker compose up -d
```

Then skip to **Step 3** and open the web page. (If you don't know what Docker is, just use the three
lines above instead.)

---

## Step 2 — Set it up (account + AI connection)

Run the friendly setup wizard. It asks you a few simple questions:

```
mercury setup
```

It will ask you to:

1. **Create your login** — pick a username and password. (The first account you make becomes the
   boss/admin account.)
2. **Choose an AI service** to power Mercury. Pick whichever you have access to:

| If you want… | Choose | What you need |
| --- | --- | --- |
| A ready cloud service (Abacus.AI) | **ChatLLM / RouteLLM** | An Abacus.AI key |
| Many models through one key | **OpenRouter** | An OpenRouter key |
| Big-name models directly | **OpenAI** or **Anthropic** | That service's key |
| Totally free & private, on your own computer | **Ollama** or **LM Studio** | Install that app first; no key needed |

A "key" is just a long password the AI service gives you when you sign up on their website. Paste it in
when the wizard asks.

> **No key and just want to try it?** You can run a pretend offline mode to make sure Mercury works,
> before connecting a real AI. See the last section. (It only echoes your words back — it's for testing,
> not real answers.)

That's it — Mercury is now set up. You only do Step 1 and Step 2 **once**.

---

## Step 3 — Use Mercury

You have two easy ways to talk to Mercury. Pick whichever you like.

### A) The web page (easiest — feels like any chat app)

1. Start Mercury:

   ```
   mercury serve
   ```

2. Open your web browser and go to:

   ```
   http://localhost:3000
   ```

3. Log in with the username and password you made in Step 2, and start chatting. Leave the terminal
   window open while you use it (that's Mercury running). To stop Mercury, click the terminal and press
   **Ctrl + C**.

### B) Straight from the terminal (quick questions)

Ask a one‑off question:

```
mercury chat "What's a good recipe for banana bread?"
```

Or start a back‑and‑forth conversation (type `exit` to leave):

```
mercury chat
```

---

## Everyday things you might want to do

| I want to… | Type this |
| --- | --- |
| Start Mercury (web page) | `mercury serve` |
| Ask a quick question | `mercury chat "your question"` |
| Check everything is healthy | `mercury doctor` |
| Switch which AI model it uses | `mercury model` (shows current) |
| See what tools it can use | `mercury tools list` |
| Add a reminder/scheduled task | `mercury schedule add --when "every day 9am"` |
| See its help | `mercury help` |

You don't need to memorize these — the web page (Step 3A) has buttons for most of it.

---

## Using Mercury as an agentic AI (starting an agent)

Here's the good news: **you don't "launch" a separate agent — every chat already runs one.** When you
ask Mercury something, it reasons about the task, uses tools, looks at the results, and keeps going until
the job is done. That loop *is* the agent. So the simplest agent is just:

```
mercury chat "Find the 3 newest files in my Downloads folder and summarize each one"
```

It will pick the tools it needs and work through the steps by itself. Everything below is about steering
that agent — none of it is required to get started.

### Let it plan bigger jobs

For a multi‑step task, ask it to plan first. Add `--pattern plan-execute`:

```
mercury chat --pattern plan-execute "Research 3 competitors and write me a comparison"
```

Mercury has several "thinking styles" (patterns). You rarely need to choose — it picks a good one
automatically — but these are the handy ones:

| Style (`--pattern`) | Good for |
| --- | --- |
| `react` (default) | Everyday tasks that use tools |
| `plan-execute` | Bigger multi‑step jobs (plans, then does) |
| `reflexion` | Tasks where it should double‑check and retry itself |

### Keep the conversation going

Start an open back‑and‑forth session (type `exit` to leave):

```
mercury chat
```

Or keep a named conversation so you can return to it later with its memory intact:

```
mercury chat --session work "Let's keep planning my project here"
```

You can also point a single request at a specific AI model with `--model`, e.g.
`mercury chat --model openai/gpt-4o "..."` — but the default is usually fine.

### Let helpers work in parallel (multi‑agent)

For large jobs, the agent can spin up helper agents on its own. You just set the limits once:

```
mercury config set agent.maxSubagents 3    # how many helpers at once
mercury config set agent.maxIterations 12  # how many steps per task
```

Or run a ready‑made team "recipe" (called a workflow):

```
mercury workflow list                 # see the available recipes
mercury workflow run <name> "input"   # run one
```

### Decide what the agent is allowed to do (important for safety)

The agent's abilities come from **tools**. You control which it can use and whether it must ask first:

```
mercury tools list                               # see all its tools
mercury config set tools.approvals.mode smart    # manual | auto | smart | deny
```

With **manual** or **smart**, the agent pauses and asks your permission before doing anything sensitive
(like running a command or deleting a file). This is the safe way to let an agent act for you.

### It learns and remembers

As you use it, Mercury builds up **memory** (facts it should keep about you and your work) and **skills**
(how‑to's it picks up from tasks it has done before), so it gets more helpful over time. This happens
automatically — on the web page you can view and edit what it remembers.

### Let it run on its own (hands‑off)

To have an agent do something regularly without you, give it a schedule:

```
mercury schedule add --when "every day 9am"
mercury schedule edit <id> --when "every 3 hours"   # change the time, name or task later
```

You can also edit a schedule from the web Scheduler panel — each row has an **Edit** button.

Or start the web server (`mercury serve`) and drive agents from the web page — that's also how you'd
connect Mercury to chat apps like Telegram or Slack.

### A great first agent to try

```
mercury serve
# open http://localhost:3000, log in, then ask in the chat box:
# "Plan and write a 300-word post about <your topic>, then save it to a file."
```

Watch it make a plan, use the file tool, and finish — that's a complete agent run. For the full details
(all patterns, the decision engine, building your own tools), see **GUIDE.md** Parts V–VIII.

---

## Giving Mercury more tools (connecting to MCP servers)

Out of the box Mercury has a handful of built‑in tools. If you want it to do more — read and write files on
your computer, work with your GitHub, fetch the weather, and so on — you can plug in **MCP servers**. Think of
an MCP server as a little toolbox that someone else has already built: once you connect it, every tool inside
it becomes available to Mercury automatically, and you just keep chatting as normal.

You don't need to write any code. You only edit one small settings file.

**Step 1 — Open (or create) the connections file.** It lives at `~/.mercury/mcp.json` in your home folder.
Mercury watches this file, so any change takes effect right away — no restart needed.

**Step 2 — Paste in the servers you want.** Here's an example that connects two common ones — a filesystem
toolbox and a GitHub toolbox. Copy it, then change the folder path and the token to your own:

```
{
  "servers": {
    "fs": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/you/Documents"]
    },
    "github": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "paste-your-token-here" }
    }
  }
}
```

Give each server any short name you like (here `fs` and `github`) — that name is just a label. Most servers
you'll find are the "stdio" kind, which means Mercury starts them for you with the `command` shown; you rarely
have to change anything except the folder path, token, or similar detail the server needs.

**Step 3 — Check it worked.**

```
mercury mcp list
```

This shows every connected server and how many tools it offers. If a server shows up with its tools, you're
done — just chat with Mercury and it will reach for those new tools whenever they help.

**A note on safety.** By default Mercury treats tools from an outside server as *untrusted*: it still uses
them, but it's a little more careful with whatever they send back. That's the safe default, so leave it alone
unless you have a reason to change it.

Prefer buttons to files? If you run `mercury serve` and open the web page, there's a place to add MCP servers
there too. Either way works. For transports other than stdio and the full list of options, see
**GUIDE.md** §5.9.

---

## If something doesn't work

**First, always try this — it checks everything and tells you what's missing:**

```
mercury doctor
```

| What you see | What it means | What to do |
| --- | --- | --- |
| "node:sqlite not found" or a version complaint | Your Node.js is too old | Install the latest from **https://nodejs.org**, then retry |
| "no provider" / it won't answer | No AI service connected yet | Run `mercury setup` again and add a key, or start your Ollama/LM Studio app |
| "port already in use" | Something else is on 3000 | Run `mercury serve --port 8080` and open `http://localhost:8080` |
| A warning about "SQLite is experimental" | Normal | Ignore it — this is expected |
| `mercury: command not found` | The shortcut isn't installed | Use `node packages/cli/dist/bin.js` in place of `mercury` |

**Want to test Mercury without connecting any AI?** This offline test should reply `Echo: hello`:

```
MERCURY_ENABLE_MOCK=1 mercury chat "hello"
```

If you get that reply, Mercury itself is working — you just need to connect a real AI service (Step 2)
to get real answers.

---

## Good to know

- **Your data stays on your computer.** Mercury saves everything in a hidden folder in your home
  directory. Nothing is sent anywhere except to the AI service you chose.
- **It needs a real AI service to answer.** Mercury has no built‑in brain; the service you pick in
  Step 2 does the thinking.
- **One setup, then just `mercury serve`.** After the first setup, starting Mercury is a single command.

Need more detail (deploying for a team, security, adding tools)? Open **GUIDE.md** — this page is just
the fast track.
