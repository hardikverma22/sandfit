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
- Add a test case to `test/extract.test.ts`.

## Development

```bash
npm install
npm test                 # unit, snapshot and property tests
npm run test:sandbox     # end-to-end against Anthropic's sandbox-runtime (macOS or Linux)
npm run dev -- --all     # run the CLI from source
```

On Linux, the real-sandbox tests need `bubblewrap` and `socat`.

## Principles

- **Never loosen what the user had.** Merges keep the user's values. Allow rules beyond the sandbox need an explicit flag.
- **Never grant a broad path.** See `tooBroad` in `src/policy/paths.ts`.
- **Every grant is explainable.** If you add a new kind of grant, record evidence for it.
- **The forecast must match a real sandbox.** If you change emitters or the forecast model, extend `test/sandbox/`.
