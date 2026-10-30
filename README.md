<h1 align="center">sandfit</h1>

<p align="center">
  <b>Turn on your coding agent's sandbox without breaking your workflow.</b><br>
  sandfit reads the Claude Code and Codex history already on your machine and writes a<br>
  least-privilege sandbox policy that fits how you actually work.
</p>

<p align="center">
  <a href="#install"><img alt="npx sandfit" src="https://img.shields.io/badge/npx-sandfit-black"></a>
  <img alt="license MIT" src="https://img.shields.io/badge/license-MIT-blue">
  <img alt="local only" src="https://img.shields.io/badge/your%20history-never%20leaves%20your%20machine-green">
</p>

```console
$ npx sandfit

sandfit 0.1.0  ·  read 18,634 tool calls from 40 sessions (Claude Code)

  If you turn on the sandbox today
  ████████░░░░░░░░░░░░░░░░  32% of your shell commands would break  (2,731 of 8,423)

  With the sandfit policy
  ░░░░░░░░░░░░░░░░░░░░░░░░  0.3% would break on history it never saw
  53 commands that read secrets are blocked on purpose
  Manual approvals you would no longer need: 15 of 15

  What the policy allows
  Network   registry.npmjs.org, github.com, pypi.org, api.vercel.com +32 more
  Writes    your project, temp, ~/.npm, ~/.cache/uv +12 more
  Outside   gh, git push run unsandboxed
  Denied    secrets (~/.ssh, ~/.aws, .env …) and the agent's own config

  Next
  sandfit apply                    write it to .claude/settings.json (keeps a backup)
```

<sub>Real output from one developer's last month of Claude Code use. Your numbers will differ: run it.</sub>

## Why

Every coding agent now ships a sandbox: Claude Code's `/sandbox`, Codex's `workspace-write`, [Anthropic's sandbox-runtime](https://github.com/anthropics/sandbox-runtime), [nono](https://nono.sh), [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell). They are deny-by-default, so they all ask the same question: **which domains and paths should I allow?**

Nobody knows the answer up front. So people turn the sandbox on, watch `npm install` fail and the permission prompts pile up, and turn it off again, or add broad allow rules that quietly bypass it.

You already have the answer. It is in your agent's history: every command it ran, every file it wrote, every host it reached. sandfit turns that history into a policy, and **shows you what would break before you switch anything on**.

## Install

```bash
npx sandfit
```

Node 20 or newer. Nothing is installed globally and nothing is sent anywhere: sandfit reads `~/.claude/projects` and `~/.codex/sessions` locally and prints to your terminal.

## What it does

1. **Reads your history.** It covers Claude Code transcripts (including subagents) and Codex rollouts, for the last 30 days by default.
2. **Works out what each action needed.** It parses every shell command (pipes, `cd`, heredocs, `bash -c`, `sudo`, redirects). A knowledge base of developer tools fills in what transcripts don't show: `npm install` talks to `registry.npmjs.org` and writes `~/.npm`, `git push` needs your credentials, `pnpm dev` binds a local port.
3. **Builds a reviewable policy.** It generalizes paths to cache roots and repositories, never to `~` or `~/Library`. It always denies secrets (`~/.ssh`, `~/.aws`, `.env`, keychains), and blocks writes to the agent's own config and your shell startup files, so a hijacked agent cannot loosen its own sandbox.
4. **Forecasts the result.** It replays your history against today's sandbox and against the new policy. It also gives an honest number: the policy is built from your older history and tested on your newest 20%, which it never saw.
5. **Writes it for your sandbox**, keeping a backup of anything it changes.

## Targets

| Sandbox | Command | What you get |
|---|---|---|
| **Claude Code** `/sandbox` | `sandfit apply` | `sandbox.network`, `sandbox.filesystem`, `excludedCommands` and secret `deny` rules merged into `.claude/settings.json` |
| **Anthropic sandbox-runtime** (`srt`) | `sandfit apply -t srt` | `~/.srt-settings.json`, then run `srt claude` |
| **Codex CLI** | `sandfit apply -t codex` | `sandbox_mode = "workspace-write"` with `writable_roots` and network, or `--codex-profile` for per-domain rules |
| **nono** | `sandfit apply -t nono` | `~/.config/nono/profiles/sandfit.json`, then run `nono run --profile sandfit -- claude` |
| **Anything else** | `sandfit emit -t policy` | The policy as YAML, with how often each grant was needed and an example |

Preview any target without writing anything:

```bash
sandfit emit -t claude      # or srt, codex, nono, policy
```

## Commands

```bash
sandfit                       # summary: what breaks today, what breaks with the policy
sandfit forecast              # every blocked command, grouped, with the one-line fix
sandfit emit -t <target>      # print the config
sandfit apply -t <target>     # write it (asks first, keeps a backup)
```

Useful options: `--all` (every project, not just this repo), `--days 90`, `--harness claude`, `--min-count 2` (drop one-off grants), `--holdout 0.3`, `--json`.

## What sandfit will not do

- **Loosen your permissions.** It only adds sandbox grants and secret *deny* rules. Allow rules for WebFetch domains, edit paths and MCP tools are opt-in with `--with-permissions`.
- **Grant broad paths.** Never `~`, `/`, `~/Library`, `~/Documents`, a cache parent, or a repo that contains your project.
- **Hide trade-offs.** If a tool you use needs a secret (for example, npm reads `~/.npmrc`), sandfit leaves that one file readable and tells you why. Tools that cannot work sandboxed (`docker`, `gh`, `git push` over SSH, cloud CLIs) are listed as running outside the sandbox, not silently allowed inside it.
- **Send your history anywhere.** No network calls, no telemetry. Credentials found in examples are redacted before they reach the policy file.

## How accurate is it?

sandfit is tested against a **real** sandbox, not just its own model. The end-to-end suite (`npm run test:sandbox`) does three things:

1. It builds a policy from sample history and runs it under Anthropic's sandbox-runtime (Seatbelt on macOS, bubblewrap on Linux).
2. It checks that everything the history needed still works, and that reading a planted fake SSH key or `.env`, writing outside the project, editing `~/.zshrc`, and reaching unknown hosts all fail.
3. It checks that sandfit's forecast matches what the sandbox actually did, probe by probe.

**Known limits.** Transcripts show commands, not everything a command does inside. A script that calls an API sandfit has never heard of won't be in the policy until you run it once under the sandbox. sandfit lists those tools as "side effects unverified" so you know where to look.

## Contributing

The most valuable contribution is **knowledge**: one entry in [`src/extract/knowledge.ts`](src/extract/knowledge.ts) teaches sandfit what a tool needs (hosts, caches, sockets) for everyone. See [CONTRIBUTING.md](CONTRIBUTING.md).

Run `npx sandfit` and the "Tools sandfit has no knowledge of" line tells you exactly which entries are missing for your setup.

## License

MIT
