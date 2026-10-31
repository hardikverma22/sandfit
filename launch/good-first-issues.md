# Good first issues to open before launch

Open these on GitHub with the label `good first issue` (and `help wanted`). They come from real
gaps the benchmarks found, so they're genuine work, not filler.

1. **Know that `python manage.py runserver` starts a local server.** Django's dev server is
   missed (holdout set in BENCHMARKS.md). Add detection in `src/extract/extract.ts` and a labelled
   case to `bench/corpus.ts`.
2. **Treat `openssl … -in <file>` as a read.** `openssl x509 -in certs/server.pem` isn't seen as
   reading a key file (holdout miss). Add read detection for openssl's `-in` / `-key` flags.
3. **`pnpm exec` / `pnpm dlx` of a local binary shouldn't need the registry.** `pnpm exec tsc -b`
   currently gets npm registry + pnpm cache grants it doesn't need (holdout miss).
4. **Knowledge entries for more tools.** Each is one entry in `src/extract/knowledge.ts`:
   `turbo`, `nx`, `bazel`, `zig`, `dotnet`, `mix` (Elixir), `swift package`, `flutter`/`dart pub`.
5. **Read Cursor's history.** Cursor keeps agent history in its own format; supporting it would
   bring sandfit to many more people. Needs a sample transcript first.
6. **Windows support check.** The sandboxes sandfit targets are macOS/Linux, but `npx sandfit`
   could still read history and emit a policy on Windows (WSL). Try it and report.
7. **`sandfit diff`**: show what changed between the current sandbox settings and the proposed
   policy before `apply`.
8. **Homebrew formula** so macOS users can `brew install sandfit`.
