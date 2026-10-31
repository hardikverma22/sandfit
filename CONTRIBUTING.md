# Contributing to sandfit

## The fastest useful contribution: teach sandfit a tool

Run `npx sandfit` and look at the line "Tools sandfit has no knowledge of". Each name there is a tool whose side effects sandfit cannot see.

Add an entry to `KNOWLEDGE` in [`src/extract/knowledge.ts`](src/extract/knowledge.ts):

```ts
ollama: {
  hosts: ["registry.ollama.ai"],     // hosts it contacts
  netSubcommands: ["pull", "push", "run"], // only these subcommands use the network (omit = always)
  writes: ["~/.ollama"],              // caches or stores it writes
  bindSubcommands: ["serve"],         // subcommands that listen on a local port
},
```

Rules for entries:

- **List only what the tool needs for its normal job.** If it is optional (telemetry, update checks), leave it out.
- **Prefer the narrowest host.** `registry.npmjs.org`, not `*.npmjs.org`.
- **Cache paths for both macOS and Linux** (`~/Library/Caches/x` and `~/.cache/x`). sandfit only grants the ones that exist on the user's machine.
- If the tool cannot work inside an OS sandbox at all (it needs a daemon socket or your credentials), set `exclude` with a one-line reason the user will read.
- Add a labelled case to [`bench/corpus.ts`](bench/corpus.ts): the command and what it really needs. `npm test` then checks sandfit gets it right, and `npm run bench:accuracy` shows the score.
- Do **not** change sandfit to fit [`bench/corpus-holdout.ts`](bench/corpus-holdout.ts). That set measures accuracy on commands sandfit was not tuned for; tuning on it would make the published number meaningless.

## Development

```bash
npm install
npm test                 # unit, CLI, snapshot, property and accuracy tests
npm run test:coverage    # the same with coverage floors (CI runs this)
npm run test:sandbox     # end-to-end against Anthropic's sandbox-runtime (macOS or Linux)
npm run bench            # accuracy, performance and real-sandbox benchmarks; rewrites BENCHMARKS.md
npm run dev -- --all     # run the CLI from source
```

Where things are:

| Folder | What is in it |
|---|---|
| `src/ingest` | Reading Claude Code and Codex transcripts |
| `src/extract` | The shell parser, and working out what each command needs (`knowledge.ts` is the tool table) |
| `src/policy` | Turning needs into rules (paths, hosts, what is too broad) |
| `src/forecast.ts` | Replaying history against a sandbox model |
| `src/emit` | Writing config for each sandbox |
| `test/` | Tests; `test/sandbox` runs commands in a real sandbox |
| `bench/` | Labelled command sets, the synthetic history generator and the three benchmarks |
| `demo/` | The README video (a HyperFrames project) |

On Linux, the real-sandbox tests need `bubblewrap`, `socat` and `ripgrep` (sandbox-runtime's own dependencies).

## Principles

- **Never loosen what the user had.** Merges keep the user's values. Allow rules beyond the sandbox need an explicit flag.
- **Never grant a broad path.** See `tooBroad` in `src/policy/paths.ts`.
- **Every grant is explainable.** If you add a new kind of grant, record evidence for it.
- **The forecast must match a real sandbox.** If you change emitters or the forecast model, add probes to `bench/sandbox-lib.ts` (they run in `npm run test:sandbox` and in CI).
- **Publish only measured numbers.** README and BENCHMARKS.md numbers come from `npm run bench`.
