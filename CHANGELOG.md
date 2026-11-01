# Changelog

## Unreleased

### Fixed
- The agents' own folders (`~/.claude`, `~/.codex`) are no longer granted when the agent's file tools
  wrote there. Before, Claude's memory files could end up in Codex's `writable_roots` and in
  `explain`. `forecast` now says such writes are protected on purpose instead of suggesting
  `allowWrite` for them.
- `sandfit score` no longer suggests `sandfit apply` for credential files your tools read on every
  run (like `~/.npmrc`), since apply leaves those readable on purpose. It suggests keeping tokens out
  of them instead.
- `sandfit score` counts broken commands the way `apply` and `forecast` do. Secret reads are listed
  as blocked on purpose rather than counted as broken.
- `--all --project <dir>` uses every project's history for the named project. Before, `--all`
  ignored `--project`.
- A mistyped command (`sandfit scroe`) is an error instead of running the summary.

## 0.6.0 (2026-11-01)

### Added
- `sandfit score`: rates the Claude Code sandbox settings that apply to a project out of 100, with
  the fix for every lost point. Seven checks: sandbox on, no unsandboxed retry, fails closed,
  network limited, credentials on this machine denied, writes kept narrow, little running outside.
  It merges user, project, local and managed settings the way Claude Code does, reads both path
  conventions (sandbox paths and permission rules), and shows how many recent commands the settings
  would block. `--json`, and `--min <n>` to fail CI below a score.
- `sandfit score --badge`: a README badge for the project's committed settings.

## 0.5.0 (2026-11-01)

### Added
- `sandfit drift`: checks that your sandbox config still covers what your agent did recently
  (default: the last 30 days). It lists the rules your config is missing, which means those
  commands will be blocked, and the rules nothing used, which it only reports. It exits 1 when
  something is missing, for CI and scripts. `--quiet` prints one line, `--json` the full result.
- `sandfit drift --hook`: the same check as a Claude Code SessionStart hook. When the config is
  missing something, the session opens with a one-line warning. It always exits 0, and stays
  quiet in projects that never set the sandbox up.
- `sandfit learn` reads Claude Code's own sandbox report (`deny network-outbound host:443`), so a
  blocked `curl` inside Claude Code now teaches it the host. Captured on macOS with Claude Code 2.1.309.

### Fixed
- Git over SSH: when your history syncs with an SSH remote (`git push`, `pull` or `fetch` to
  `git@github.com:...`), fetch, pull and push now all run outside the sandbox. Before, only the
  commands seen in history did, so the first `git fetch` failed because the sandbox protects
  `~/.ssh`. Found by testing on a real Mac. HTTPS remotes are unchanged: fetch works inside the
  sandbox there.
- The forecast follows Claude Code's rule for commands that run outside the sandbox: the whole call
  must be excluded commands, with no `cd`, redirect to a file or `$(...)`. `cd repo && git push` or
  `git push 2>&1 | tail -1` stays sandboxed, and is now shown as blocked with the reason, instead
  of counted as fine. Found on a real Mac, where `git fetch` failed this way.
- Exclusions are written the way the command was typed (`sudo apt *`, not `apt *`), because Claude
  Code matches the text of the call.
- Writes to the agents' own folders (`~/.claude`, `~/.codex`, for example Claude's memory files) are
  never granted to commands or suggested by `learn`: a command that can write there can change what
  the agent does next.
- `learn` shows the line of a multi-line call that hit the block, not the whole call.

## 0.4.0 (2026-10-31)

### Added
- `sandfit learn`: lists what a sandbox actually blocked in past sessions (hosts and paths named
  in the errors of sandboxed commands: a script refused an API, a tool that couldn't write its
  cache). These are the needs a command's text doesn't show.
- `sandfit apply --learn`: asks about each blocked host or path, and adds only what you accept.
  Enter skips, because a blocked attempt can be an attack. Secrets, shell startup files, the agent's
  own config and broad folders are never suggested.
- `--strict-network` (Claude Code, with `--user`): writes `sandbox.network.strictAllowlist`, so hosts
  outside the allowlist are refused instead of prompting. Needs Claude Code v2.1.219 or later. Claude
  Code only honours it in user or managed settings, so sandfit refuses it for project settings
  rather than writing a setting that would do nothing.
- `--mask-credentials` (Claude Code, with `--user`): masks the secret environment variables your
  history sent to specific hosts (a `$OPENAI_API_KEY` in a `curl`, `NPM_TOKEN` for npm, tokens of
  Vercel, Netlify, Cloudflare, Supabase, Fly, Stripe and Hugging Face CLIs). Sandboxed commands see a
  placeholder; Claude Code's proxy restores the real value only for those hosts. Writes
  `sandbox.credentials.envVars` (mode `mask`, `injectHosts`) and the experimental
  `sandbox.network.tlsTerminate`. Only variable names are recorded, never values. Variables used
  only locally are not masked.
- `sandfit explain env` shows each secret variable and the hosts it was sent to.
- `--target openshell`: an NVIDIA OpenShell sandbox policy (`openshell sandbox create --policy`). It
  lists the hosts your commands needed as one network rule for your agent's binary, which OpenShell
  extends to every process the agent starts (`--binary` names other programs). OpenShell allows only
  what is listed and keeps home and the project under `/sandbox`, so the file adds only writable
  folders outside it. Wildcard hosts OpenShell would reject are left out with a note. Emit only:
  OpenShell takes the policy when a sandbox is created.

### Changed
- Claude Code settings now include `sandbox.failIfUnavailable: true`. Without it, Claude Code runs
  commands unsandboxed when the sandbox cannot start, so a broken setup silently means no sandbox.
  Your own value is kept if you already set one.
- `diff` shows settings whose value is an empty object (like `tlsTerminate: {}`).

### Fixed
- Re-applying no longer duplicates list entries that are objects (such as credential entries).
- `--codex-profile` now writes what Codex's permission profiles need: `extends = ":workspace"` (so
  the project is writable and `.git/`, `.codex/` stay read-only) and `features.network_proxy = true`
  (without it Codex does not enforce the per-domain rules).
- `apply -t codex` refuses to mix the two Codex config styles: a profile on top of `sandbox_mode`
  (Codex would ignore the profile) or `sandbox_mode` on top of a profile (Codex would ignore the
  profile you had). Nothing is written in either case.

## 0.3.1 (2026-10-31)

### Changed
- Releases are published from GitHub Actions with npm provenance, so the npm page links each
  version to the exact commit and workflow that built it.
- The version lives only in `package.json`; the CLI reads it from there.

## 0.3.0 (2026-10-31)

### Added
- `sandfit diff`: what `apply` would change in your sandbox config, entry by entry, without writing
  anything. Grants are listed in full and protection rules summarized (`--full` lists them). It
  also flags entries already in your settings that your history never needed. `--json` for scripts.
- `sandfit apply --review`: keep or drop each grant your history needed only once (or at most N
  times with `--review-max N`) before anything is written. The forecast is recomputed for what you
  kept, so you see what dropping a grant would break.

### Changed
- `apply` shows exactly what it will change before asking, and writes nothing (no new backup)
  when the config is already up to date.

## 0.2.0 (2026-10-31)

### Added
- `sandfit explain [filter]`: why each rule is in the policy, how often it was needed, one example.
- Benchmarks (`npm run bench`, results in BENCHMARKS.md): accuracy on 200+ hand-labelled commands
  (with a holdout set sandfit was not tuned on), speed on up to 100,000 tool calls, and a
  probe-by-probe comparison of the forecast with a real sandbox.
- Much larger test suite: the CLI end to end, transcript edge cases, property tests for the
  safety rules, and coverage floors in CI.
- A demo video made with HyperFrames (`demo/`).
- Knowledge: kubectl, helm, apt/apt-get/dnf/yum/pacman (run outside the sandbox), prisma.

### Changed
- Understands much more of what commands need: subcommands after flags (`npm --prefix web install`,
  `pnpm --filter web dev`), programs started by `npx`/`pnpm dlx`/`bunx`, `python -m pip`,
  curl/wget flags (`localhost:3000`, `-sSLo file`), where `cp`/`mv`/`install` really write,
  `git config` and `git remote add`.
- Tools that must run outside the sandbox (gh, docker, kubectl …) no longer get grants inside it.
- The forecast models sandbox-runtime's built-in protected files (`.git/hooks`, `.git/config`,
  `.mcp.json`, `.vscode` …) and the Linux behaviour of local ports.
- Reads transcripts about 3x faster and skips files older than `--days` without opening them.
- Options are validated with clear messages; `--json` includes counts and scope.

### Fixed
- srt config was missing `allowLocalBinding` / `allowUnixSockets`, so dev servers broke under srt on macOS.
- `mv x ~/Downloads/` granted the whole of `~/Downloads`.
- An empty `CODEX_HOME` or `CLAUDE_CONFIG_DIR` made `apply` write into the current folder.
- `apply` crashed on an unparseable settings file; it now stops without touching it.
- `cp .env.example .env` was counted as reading a secret.
- The forecast could suggest granting a parent repository.

## 0.1.0
- First release.
