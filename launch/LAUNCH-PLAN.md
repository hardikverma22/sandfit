# sandfit launch plan

How developer-tool repos actually get noticed, and a concrete two-week plan for sandfit.
Every draft referred to here is in this folder, ready to edit and post. Nothing has been posted.

## What makes a repo take off (what the evidence says)

1. **One big spike, then compounding.** Most repos that blow up get one front-page moment
   (Hacker News, a big Reddit thread, a widely shared post) that pushes them onto GitHub Trending.
   Trending ranks by *how fast* stars arrive, not how many there are, and it brings a second
   wave of people. Every other channel exists to make that spike likelier and to catch the
   people it brings. (Trending's formula is not published; third-party trackers agree it is
   star velocity over day/week windows.)
2. **Timing beats tags.** A study of Hacker News launches of GitHub repos found that when you
   post matters a lot (hundreds of stars' difference), while the "Show HN" label itself made no
   measurable difference once other factors were controlled.
3. **The README is the landing page.** Most visitors decide in seconds. sandfit's README is
   already in good shape: a demo at the top, one command to try it, real numbers, honest limits.
4. **A story beats a feature list.** "I built X" posts that explain the problem, what is still
   rough, and what was learned do far better than announcements. The author staying in the
   comments all day matters more than the post itself.
5. **Timeliness is a multiplier.** Posts that answer something people are already arguing
   about travel further.
6. **Never fake it.** No vote rings, no bought stars, no asking friends to upvote a link. Hacker
   News and Reddit detect it and bury or ban the post; GitHub detects star manipulation and
   hides repos from discovery. Asking people to *try it and tell you what broke* is fine.

## sandfit's angle (why now)

Three things people are already talking about, and sandfit answers all three:

- **Agent sandboxes are being escaped through config files, not the sandbox itself.** In July
  2026, Pillar Security got out of the sandboxes of Cursor, Codex, Gemini CLI and Antigravity by
  having the agent write files that trusted tools later ran (hook configs, `.vscode` tasks, git
  metadata). sandfit's policies always deny writes to exactly that class of file: git hooks and
  config, shell startup files, `.mcp.json`, `.vscode`, and the agent's own settings. Its
  real-sandbox test proves those writes are blocked.
- **Agents with your credentials get hijacked.** In February 2026, a prompt injection in Cline's
  issue-triage workflow led to stolen npm publish credentials and an unauthorized release.
  sandfit denies reading `~/.npmrc`, `~/.ssh`, `~/.aws`, `.env` and similar by default.
- **People turn the sandbox off because it breaks their workflow.** Claude Code's GitHub issues
  are full of "too many prompts" and "sandbox broke X". sandfit's whole point is: see exactly
  what would break, *before* you switch it on, and get a config that fits.

One-line pitch:
> sandfit reads your Claude Code / Codex history and writes a sandbox policy that allows what you
> actually use and nothing more, and shows you what would break before you turn it on.

## Before launch day (about 1 hour, all on GitHub)

- [ ] **Publish 0.2.0 to npm** (you have the commands). Every post says `npx sandfit`, so it
      must work for strangers the moment they read it.
- [ ] **Upload the social preview:** repo Settings, General, Social preview, upload
      `launch/social-preview.png`. This is the card people see when the link is shared.
- [ ] **Repository topics:** Settings, or the gear next to "About". Suggested:
      `claude-code`, `codex`, `ai-agents`, `sandbox`, `security`, `least-privilege`,
      `developer-tools`, `cli`, `llm-security`, `prompt-injection`.
- [ ] **Short description** ("About"): *Turn on your coding agent's sandbox without breaking
      your workflow. Least-privilege policies from your Claude Code and Codex history.*
- [ ] **Inline video in the README** (drag `demo/sandfit-demo.mp4` into the README editor on
      github.com; see the earlier note). A playing demo with sound converts better than a GIF.
- [ ] **GitHub release v0.2.0** with notes from CHANGELOG.md (Releases, Draft a new release,
      tag `v0.2.0`). Watchers get notified, and a release looks maintained.
- [ ] **Open 5–8 "good first issue" issues** from `launch/good-first-issues.md`. Visitors who
      want to help need somewhere to start, and issues show the project is alive.
- [ ] **Try it once, from scratch, on a clean machine** (`npx sandfit@latest`). The first
      comment on any launch is "it crashed on my setup".

## The plan

| When | Where | Draft | Notes |
|---|---|---|---|
| Day 0 (Tue/Wed/Thu) | Hacker News, Show HN | `show-hn.md` | The main spike. Post around 8–10am US Eastern on a weekday (common practice; HN traffic peaks then). Stay in the comments all day. |
| Day 0, 1–2 h after HN | X / Bluesky thread | `x-thread.md` | Attach the MP4. Link the HN thread too. |
| Day 0 | LinkedIn | `linkedin.md` | Different audience: engineering leads and security people. |
| Day 1 | r/ClaudeAI and r/ClaudeCode | `reddit.md` | Problem-first, not promo. Check each subreddit's self-promotion rules first. |
| Day 1–2 | r/commandline, r/netsec (only the security write-up) | `reddit.md` | r/netsec only accepts technical write-ups, not tool announcements: post the article, not the repo. |
| Day 2 | dev.to / Hashnode / your blog | `article.md` | Long form: what history shows about what agents actually touch. Cross-post with a canonical link. |
| Day 2–3 | Awesome lists | `submissions.md` | awesome-claude-code (form-based, not PRs), plus a few others. |
| Day 3–5 | Newsletters | `submissions.md` | Console.dev, Changelog News, TLDR, Node Weekly. Short pitch email. |
| Week 2 | Follow-up post | `article.md` (part 2 idea) | Real results from users ("people ran sandfit; here is what broke most"), only with their permission. |
| Ongoing | Answer questions where they're asked | | When someone asks "how do I stop Claude Code asking for permission" or "is the sandbox worth it", answer helpfully and mention sandfit only where it fits. |

If HN doesn't take off on the first try, that is normal. You can re-post a Show HN after
meaningful changes (and the mods sometimes offer a second chance for good posts that got no
traction). Reddit, the article and newsletters are not wasted: each brings a steady trickle,
and a trickle of genuinely interested users is what gets a project onto Trending later.

## On launch day

- Be at your keyboard for 6–8 hours after posting. Answer every comment, especially critical
  ones, with specifics. Say "you're right, that's a gap" when it is, and fix small things live
  (and say so in the thread).
- Expect these questions, and have answers ready (the drafts cover most of them):
  - "Does it send my history anywhere?" No: no network calls, no telemetry; credentials are masked.
  - "Why not just use a container/VM?" Containers protect the machine but not the secrets and
    project mounted into them, and are heavier. sandfit configures the OS sandbox the agent
    already ships with. It can also write a policy file for other sandboxes.
  - "How accurate is it?" Point to BENCHMARKS.md: 96% precision and recall on commands it was
    never tuned on, and its forecast matched a real sandbox on 36 of 36 checks.
  - "What about tools it doesn't know?" It lists them, and one-line knowledge entries are the
    easiest contribution.
- Watch the repo's Insights, Traffic page for where visitors come from, and put effort there.

## What to measure

- Stars per day (Trending needs a burst, roughly 50–100 in a day per unverified reports),
  npm weekly downloads (npmjs.com/package/sandfit), referrers in GitHub Traffic, and issues/PRs
  from strangers (the real sign of traction).

## Sources

- Hacker News launch timing study: https://arxiv.org/abs/2511.04453v1
- How GitHub Trending ranks (third-party analysis): https://ossinsight.io/blog/introducing-trending-page , https://yuv.ai/blog/github-trending
- Sandbox escapes in Cursor, Codex, Gemini CLI, Antigravity (Pillar Security, July 2026): https://www.bleepingcomputer.com/news/security/cursor-codex-gemini-cli-antigravity-hit-by-sandbox-escapes/ , https://thenextweb.com/news/ai-coding-agents-sandbox-escapes-pillar
- Cline unauthorized npm release (February 2026): https://cline.bot/blog/post-mortem-unauthorized-cline-cli-npm
- Claude Code sandbox prompt fatigue: https://github.com/anthropics/claude-code/issues/64061 , https://claudeissues.com/issue/37839-sandbox-permission-prompts-are-excessive-and-unavoidable-for-common-development
- awesome-claude-code submission process: https://www.mintlify.com/hesreallyhim/awesome-claude-code/contributing
- OpenClaw growth curve (19 stars day one, then 150K in 24 days): https://www.star-history.com/blog/deepseek-harness-beats-openclaw-fastest-200k-stars
