# Changelog

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
