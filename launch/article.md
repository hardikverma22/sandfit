# Article draft (dev.to / Hashnode / your blog)

Publish on your own blog if you have one and cross-post to dev.to with the canonical URL set, so
search engines credit the original. Add the demo GIF near the top and the MP4 link.

---

# Your coding agent's sandbox is off. Here's how to turn it on without breaking everything.

Every major coding agent now ships a sandbox. Claude Code has `/sandbox`, Codex has
`workspace-write`, and there's Anthropic's open-source sandbox-runtime, nono and others. They all
work the same way: deny everything, then allow what you list.

And that is exactly why most people don't use them.

## The empty allowlist problem

A deny-by-default sandbox asks you a question you can't answer up front: *which websites and
folders does my work need?*

So you switch it on and find out the hard way. `npm install` can't reach the registry. The dev
server can't open a port. `pip` can't write its cache. `git push` can't read your SSH key. Each
failure is either a permission prompt or a broken command. After an hour you either turn the
sandbox off or add broad rules ("allow all of ~") that quietly undo it.

## The answer is already on your disk

Claude Code saves a transcript of every session in `~/.claude/projects`, and Codex does the same
in `~/.codex/sessions`. Every command your agent ran is in there.

That history is the allowlist. You just need to read it carefully.

## What "carefully" means

A transcript shows `npm install`, not that npm talked to `registry.npmjs.org` and wrote to
`~/.npm`. Turning commands into needs takes three things:

1. **A real shell parser.** Agents write scripts: `cd web && npm ci && npm run build 2>&1 | tail`.
   You need pipes, lists, `cd` tracking, redirects, heredocs, `bash -c "…"`, and wrappers like
   `sudo`, `env`, `timeout`, `xargs`, `npx` and `python -m`.
2. **Knowledge of what tools do behind the scenes.** Which hosts `cargo build` reaches, where
   `uv` keeps its cache, which `pnpm` subcommands start a server.
3. **Restraint.** Generalize a write to the cache folder, never to your home folder. Treat tools
   that need your credentials (`gh`, `docker`, `git push` over SSH) as "run outside the
   sandbox", not "punch a hole in it".

I built [sandfit](https://github.com/hardikverma22/sandfit) to do this.

## Measure before you switch

The most useful thing a tool like this can do is tell you what will break *before* you change
anything. sandfit replays your history against the sandbox you have today, and against the
policy it proposes.

To keep that number honest, it builds the policy from your older history and tests it on your
newest 20%, which it never looked at. A policy that only fits the data it was built from is easy;
one that works on next week's commands is the point.

[Insert the summary output here: 28% broken with no config, 0% of unseen commands with the policy.]

## The files a hijacked agent goes for

In July 2026, Pillar Security escaped the sandboxes of Cursor, OpenAI's Codex, Google's Gemini CLI
and Antigravity, without breaking the sandboxes themselves. The agent wrote files that a trusted
tool *outside* the sandbox later acted on: hook configs, IDE task files, git metadata.

That is the important lesson for anyone configuring a sandbox: **the dangerous permission isn't
"write anywhere", it's "write to a file something else will execute later".**

So whatever your history says, a good policy always denies writes to:

- git hooks and `.git/config` (which can point hooks at any script)
- shell startup files (`~/.zshrc`, `~/.bashrc`, …)
- `.mcp.json` and editor task configs (`.vscode`)
- the agent's own settings, so it can't loosen its own sandbox

And it always denies *reading* credentials: `~/.ssh`, `~/.aws`, `~/.npmrc`, `.env` files. (Earlier
in 2026, a prompt injection against Cline's GitHub triage bot ended with stolen npm publish
credentials and an unauthorized release.)

## Don't trust the forecast, test it

I didn't want to publish "trust me" numbers, so sandfit is tested against a real sandbox. The test
suite builds a policy from a small history, then runs probes inside sandbox-runtime (bubblewrap on
Linux, Seatbelt on macOS): things the history needed, and attacks like reading a planted fake SSH
key, editing `~/.zshrc`, writing a git hook or reaching an unknown host. Then it compares what
the real sandbox did with what sandfit predicted.

Writing that test found real bugs. The srt config was missing `allowLocalBinding`, so dev servers
broke on macOS. A `mv build.zip ~/Downloads/` granted all of `~/Downloads`. Linux and macOS
disagree about whether a sandboxed process can bind a local port. All fixed, and all now covered
by tests that run on both systems in CI.

## Try it

```
npx sandfit           # read-only: what breaks today, what breaks with the policy
npx sandfit explain   # why each rule is there
npx sandfit apply     # write it (asks first, keeps a backup)
```

It runs entirely on your machine and works with Claude Code, Codex, sandbox-runtime and nono.
The code, benchmarks and real-sandbox tests are at
[github.com/hardikverma22/sandfit](https://github.com/hardikverma22/sandfit).

If it gets something wrong on your history, open an issue; I want to hear about it.

---

**Part 2 idea (week 2):** "What N developers' agent histories need from a sandbox": aggregate,
anonymous findings shared voluntarily by users (most common hosts, most common breakages, which
tools sandfit didn't know). Only with explicit permission; never collect data automatically.
