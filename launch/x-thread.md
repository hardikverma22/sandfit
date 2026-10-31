# X / Bluesky thread

Attach `demo/sandfit-demo.mp4` to the first post (native video gets far more reach than links).
Put the link in the last post, not the first (X down-ranks posts with external links).

1/
Every coding agent has a sandbox now.

Almost nobody keeps it on, because it breaks npm install, git push and your dev server within the hour.

I built sandfit: it reads your Claude Code / Codex history and writes a sandbox policy that fits how you actually work. 🧵

2/
The trick: the answer is already on your disk.

Your agent's transcripts show every command it ran. sandfit works out what each one needed (hosts, folders, local ports) and allows exactly that.

Nothing else. Nothing leaves your machine.

3/
Before you switch anything on, it tells you what would break.

On a sample week of Next.js work:
– sandbox on, no config: 28% of commands break
– with the sandfit policy: 0% of 49 commands it had never seen

4/
It always blocks the stuff a hijacked agent goes for:

– reading ~/.ssh, ~/.aws, .env, ~/.npmrc
– writing git hooks, ~/.zshrc, .mcp.json, .vscode, its own settings

That second list is how this summer's sandbox escapes in Cursor, Codex & Gemini CLI worked.

5/
I didn't want "trust me" numbers, so it's tested against a real sandbox (bubblewrap + Seatbelt), probe by probe:

✅ 26/26 probes behave correctly
✅ forecast matched the real sandbox 36/36
✅ 96% precision/recall on commands it was never tuned on

6/
Try it. It's read-only until you say apply:

npx sandfit

Works with Claude Code, Codex, Anthropic's sandbox-runtime and nono.

github.com/hardikverma22/sandfit

Tell me what it gets wrong on your history 🙏
