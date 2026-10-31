# Show HN

Post at https://news.ycombinator.com/submit . Put the GitHub URL in the URL field, then add the text
below as the **first comment** right away (HN shows the URL post; your comment carries the story).

## Title (pick one; HN titles must be plain, no hype)

- Show HN: Sandfit – Turn on your coding agent's sandbox without breaking your workflow
- Show HN: Sandfit – Sandbox policies for Claude Code and Codex, built from your history

URL: https://github.com/hardikverma22/sandfit

## First comment

Hi HN, I built sandfit because I kept turning on Claude Code's sandbox and turning it off again
an hour later.

Every coding agent now ships a sandbox (Claude Code's /sandbox, Codex's workspace-write,
Anthropic's sandbox-runtime, nono). They're deny-by-default, so they all ask the same
question: which domains and folders should I allow? Nobody knows that up front. You switch it
on, `npm install` fails, the dev server can't bind, `git push` breaks, and you either turn it off
or add broad allow rules that defeat the point.

But the answer is already on your disk. Claude Code and Codex keep transcripts of every command
the agent ran. sandfit reads them locally, works out what each command needed (it parses the
shell: pipes, `cd`, `bash -c`, redirects, heredocs, plus a table of what tools do behind the
scenes, like `npm install` needing registry.npmjs.org and `~/.npm`), and writes a least-privilege
policy for your sandbox.

The part I care about most is the forecast: before you change anything, it replays your
history against the sandbox and tells you what would break. To keep that honest, it builds the
policy from your older history and tests it on your newest 20%, which it never saw.

Things I tried hard to get right:

- It always denies reading secrets (~/.ssh, ~/.aws, ~/.npmrc, .env…) and writing to files that
  run code later: git hooks and config, shell rc files, .mcp.json, .vscode, and the agent's own
  settings. That last class is how this summer's sandbox escapes in Cursor, Codex and Gemini CLI
  worked: the agent wrote a file that a trusted tool later ran.
- It never grants broad paths (~, ~/Documents, a parent of your project), and lists tools that
  can't work sandboxed (docker, gh, git push over SSH) openly instead of quietly allowing them.
- No network calls, no telemetry. Credentials in examples are masked before they're printed.

How I checked it works (all reproducible with `npm run bench`):

- The forecast is compared against a real sandbox (Anthropic's sandbox-runtime, bubblewrap on
  Linux and Seatbelt on macOS) probe by probe: 26/26 probes behave correctly, including reading
  planted fake keys and writing git hooks, and the forecast matched the real sandbox on 36/36. This
  runs in CI on both systems.
- On 64 hand-labelled commands written after I'd tuned it (and not tuned on since), it gets 96%
  precision and recall on what they need. The misses are listed in BENCHMARKS.md.
- Writing the benchmarks found real bugs, which was humbling: it was granting all of ~/Downloads
  for `mv x ~/Downloads/`, and missing `allowLocalBinding` in the srt config, so dev servers
  broke on macOS.

What's still rough: it only sees commands, not what a script does inside, so a script that calls
an API it doesn't know about won't be in the policy until you run it once sandboxed. It tells you
which tools it has no knowledge of; adding one is a one-line entry.

Try it (read-only, changes nothing): `npx sandfit`

I'd love to hear what it gets wrong on your history.

## Replies to have ready

- **"Why not a container?"** Containers are great, but the project and often your credentials
  are mounted into them, and many people don't want to run their agent in one. sandfit
  configures the OS sandbox the agent already ships with, which is lighter. And it can emit a
  plain policy file for anything else.
- **"Does it phone home?"** No network access at all; everything runs on your machine.
- **"Codex/Cursor support?"** Codex: yes (reads its history, writes config.toml). Cursor: not yet,
  its history format is different; happy to take a PR or a sample transcript.
