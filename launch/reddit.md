# Reddit

Read each subreddit's rules before posting; several limit self-promotion (often "at most 1 in 10
of your posts may be your own project"). Post as a person sharing something they built, reply
to every comment, and don't post the same text to several subreddits on the same day.

## r/ClaudeAI or r/ClaudeCode

**Title:** I kept turning Claude Code's sandbox off, so I built a tool that writes the config from my own history

**Body:**

The sandbox is great in theory: fewer permission prompts, and a hijacked session can't read
`~/.ssh` or edit `~/.zshrc`. In practice I'd turn it on, `npm install` would fail on the
registry, the dev server couldn't bind a port, and I'd turn it off again.

The fix turned out to be sitting in `~/.claude/projects`: every command Claude ever ran. So I
wrote **sandfit**. It reads that history locally and writes the sandbox config (allowed domains,
writable folders, excluded commands, secret deny rules) that fits what you actually do. It also
shows you, before you change anything, which past commands would still break.

What it looked like on a sample week of Next.js work:

```
If you turn on the sandbox today
███████░░░░░░░░░░░░░░░░░  28% of your shell commands would break  (69 of 243)

With the sandfit policy
░░░░░░░░░░░░░░░░░░░░░░░░  0% would break  (0 of 49 commands from your newest 20% of history, which the policy never saw)
Manual approvals you would no longer need: 24 of 35
```

- `npx sandfit` is read-only. `npx sandfit apply` merges the config into `.claude/settings.json`
  and keeps a backup.
- `sandfit explain github.com` tells you why something is allowed (how often it was needed, with an example).
- Always denies secrets and the agent's own settings. Never grants `~` or other broad folders.
- No network calls, no telemetry.

It's tested against a real sandbox (Anthropic's sandbox-runtime) in CI, and there's a benchmark
of how well it understands commands. Both are in the repo.

Repo: https://github.com/hardikverma22/sandfit

I'd really like to know what it gets wrong on your history, especially tools it says it has no
knowledge of.

## r/commandline

**Title:** sandfit: builds a least-privilege sandbox policy for coding agents from their shell history (parses pipes, cd, bash -c, heredocs)

**Body:** Short version of the above, leading with the shell parsing (it's a small dependency-free
POSIX-ish parser that tracks `cd` across a script, unwraps `sudo`/`env`/`timeout`/`xargs`,
looks inside `bash -c` and `npx`, and handles curl's flags), plus the link.

## r/netsec

Do **not** post the repo here (tool announcements get removed). If you publish the article in
`article.md`, post that, with a technical title like:
**What coding agents actually need from a sandbox, and the config files that let them escape it**
