# LinkedIn

Attach `demo/sandfit-demo.mp4`. Put the GitHub link in the first comment, not the post (LinkedIn
shows link posts to fewer people), and say "link in the first comment" at the end.

---

Your developers' AI coding agents can read their SSH keys.

Every agent ships a sandbox that would stop that. Most people switch it off within an hour,
because a deny-by-default sandbox breaks npm install, git push and the local dev server, and
nobody knows which hosts and folders to allow.

So I built sandfit, an open-source CLI that answers that question from data you already have.
It reads the agent's own history (Claude Code and Codex keep transcripts of every command),
works out what each command needed, and writes a least-privilege sandbox policy:

→ allows exactly the hosts, caches and folders your work uses
→ always denies secrets (SSH keys, cloud credentials, .env files) and the files a hijacked agent
  would use to escape (git hooks, shell startup files, its own settings)
→ shows you what would break *before* you switch anything on

I didn't want to ask anyone to take the numbers on trust, so it's tested against a real sandbox
in CI: 26 of 26 attack-and-need probes behave correctly, and its forecast matched the real
sandbox on 36 of 36 checks.

It runs locally, sends nothing anywhere, and is MIT licensed. One command to try: npx sandfit

If your team uses Claude Code or Codex, I'd love to hear what it finds on your history.

Link in the first comment.

#AIsecurity #DeveloperTools #OpenSource #ClaudeCode
