/**
 * What common developer tools touch, beyond what is visible in their arguments.
 *
 * A transcript only shows `npm install`, not that npm talked to registry.npmjs.org and
 * wrote to ~/.npm. This table fills that gap. Keep entries conservative: list only hosts
 * and paths the tool needs for its normal job.
 */

export interface ToolKnowledge {
  /** Hosts contacted when any of `netSubcommands` runs (or always, if omitted). */
  hosts?: string[];
  netSubcommands?: string[];
  /** Paths written as a side effect (caches, stores). "~" is the home directory. */
  writes?: string[];
  /** Unix sockets the tool needs. */
  sockets?: string[];
  /** Subcommands that start a server listening on a local port. */
  bindSubcommands?: string[];
  /** The tool cannot run inside an OS sandbox at all; suggest excluding it. */
  exclude?: string;
  /** Secret files the tool reads during normal use (only matters if the file exists). */
  readsSecrets?: string[];
}

const NPM_HOSTS = ["registry.npmjs.org"];
const PY_HOSTS = ["pypi.org", "files.pythonhosted.org"];
const CRATES = ["crates.io", "index.crates.io", "static.crates.io"];
const GO = ["proxy.golang.org", "sum.golang.org"];
const GITHUB = ["github.com", "api.github.com", "codeload.github.com", "objects.githubusercontent.com"];
const NPM_INSTALL = ["install", "i", "ci", "add", "update", "up", "upgrade", "outdated", "view", "info", "show", "publish", "audit", "exec", "dlx", "create", "init", "x", "remove", "rm", "uninstall", "dedupe", "fetch"];

export const KNOWLEDGE: Record<string, ToolKnowledge> = {
  npm: { readsSecrets: ["~/.npmrc"], hosts: NPM_HOSTS, netSubcommands: NPM_INSTALL, writes: ["~/.npm"], bindSubcommands: ["start", "dev", "serve", "preview"] },
  npx: { readsSecrets: ["~/.npmrc"], hosts: NPM_HOSTS, writes: ["~/.npm"] },
  pnpm: { readsSecrets: ["~/.npmrc"], hosts: NPM_HOSTS, netSubcommands: NPM_INSTALL, writes: ["~/Library/pnpm", "~/.local/share/pnpm", "~/.cache/pnpm", "~/Library/Caches/pnpm"], bindSubcommands: ["start", "dev", "serve", "preview"] },
  yarn: { readsSecrets: ["~/.npmrc"], hosts: ["registry.yarnpkg.com", ...NPM_HOSTS], netSubcommands: ["", ...NPM_INSTALL], writes: ["~/.yarn", "~/Library/Caches/Yarn", "~/.cache/yarn"], bindSubcommands: ["start", "dev", "serve", "preview"] },
  bun: { readsSecrets: ["~/.npmrc"], hosts: NPM_HOSTS, netSubcommands: NPM_INSTALL, writes: ["~/.bun"], bindSubcommands: ["dev", "start", "serve", "preview"] },
  bunx: { readsSecrets: ["~/.npmrc"], hosts: NPM_HOSTS, writes: ["~/.bun"] },
  deno: { hosts: ["deno.land", "jsr.io", ...NPM_HOSTS], writes: ["~/Library/Caches/deno", "~/.cache/deno"] },
  pip: { hosts: PY_HOSTS, netSubcommands: ["install", "download", "index", "wheel"], writes: ["~/Library/Caches/pip", "~/.cache/pip"] },
  pip3: { hosts: PY_HOSTS, netSubcommands: ["install", "download", "index", "wheel"], writes: ["~/Library/Caches/pip", "~/.cache/pip"] },
  uv: { hosts: [...PY_HOSTS, "github.com"], netSubcommands: ["add", "sync", "pip", "lock", "run", "tool", "python", "venv", "init", "export"], writes: ["~/.cache/uv", "~/.local/share/uv"] },
  uvx: { hosts: PY_HOSTS, writes: ["~/.cache/uv", "~/.local/share/uv"] },
  poetry: { hosts: PY_HOSTS, netSubcommands: ["install", "add", "update", "lock", "publish"], writes: ["~/Library/Caches/pypoetry", "~/.cache/pypoetry"] },
  pipx: { hosts: PY_HOSTS, netSubcommands: ["install", "run", "upgrade"], writes: ["~/.local/pipx", "~/.local/bin"] },
  cargo: { hosts: CRATES, netSubcommands: ["build", "b", "run", "r", "test", "t", "check", "c", "install", "add", "update", "fetch", "publish", "search", "clippy", "doc", "bench"], writes: ["~/.cargo"] },
  rustup: { hosts: ["static.rust-lang.org"], writes: ["~/.rustup", "~/.cargo"] },
  go: { hosts: GO, netSubcommands: ["get", "mod", "build", "install", "run", "test", "vet", "list"], writes: ["~/go", "~/Library/Caches/go-build", "~/.cache/go-build"] },
  gem: { hosts: ["rubygems.org", "index.rubygems.org"], netSubcommands: ["install", "update", "fetch", "push"], writes: ["~/.gem", "~/.local/share/gem"] },
  bundle: { hosts: ["rubygems.org", "index.rubygems.org"], netSubcommands: ["install", "update", "add", "lock", ""], writes: ["~/.bundle", "~/.gem"] },
  composer: { hosts: ["repo.packagist.org", "packagist.org", "github.com"], netSubcommands: ["install", "update", "require", "create-project"], writes: ["~/.composer", "~/.cache/composer", "~/Library/Caches/composer"] },
  mvn: { hosts: ["repo.maven.apache.org", "repo1.maven.org"], writes: ["~/.m2"] },
  gradle: { hosts: ["services.gradle.org", "plugins.gradle.org", "repo.maven.apache.org"], writes: ["~/.gradle"] },
  "./gradlew": { hosts: ["services.gradle.org", "plugins.gradle.org", "repo.maven.apache.org"], writes: ["~/.gradle"] },
  brew: { hosts: ["formulae.brew.sh", "ghcr.io", "pkg-containers.githubusercontent.com", "github.com"], netSubcommands: ["install", "upgrade", "update", "fetch", "reinstall", "tap", "search", "info"], writes: ["~/Library/Caches/Homebrew", "/opt/homebrew", "/usr/local/Homebrew"] },
  gh: { hosts: GITHUB, writes: ["~/.config/gh"], exclude: "uses your GitHub token, which the sandbox keeps unreadable" },
  hf: { hosts: ["huggingface.co", "cdn-lfs.huggingface.co"], writes: ["~/.cache/huggingface"] },
  "huggingface-cli": { hosts: ["huggingface.co", "cdn-lfs.huggingface.co"], writes: ["~/.cache/huggingface"] },
  vercel: { hosts: ["api.vercel.com", "vercel.com"], writes: ["~/Library/Application Support/com.vercel.cli", "~/.local/share/com.vercel.cli"] },
  netlify: { hosts: ["api.netlify.com"], writes: ["~/Library/Preferences/netlify", "~/.config/netlify"] },
  wrangler: { hosts: ["api.cloudflare.com", "dash.cloudflare.com"], writes: ["~/.wrangler", "~/Library/Preferences/.wrangler"] },
  supabase: { hosts: ["api.supabase.com"], writes: ["~/.supabase"] },
  flyctl: { hosts: ["api.fly.io"], writes: ["~/.fly"] },
  fly: { hosts: ["api.fly.io"], writes: ["~/.fly"] },
  stripe: { hosts: ["api.stripe.com"], writes: ["~/.config/stripe"] },
  playwright: { hosts: ["cdn.playwright.dev", "playwright.download.prss.microsoft.com"], netSubcommands: ["install"], writes: ["~/Library/Caches/ms-playwright", "~/.cache/ms-playwright"] },
  docker: { sockets: ["/var/run/docker.sock"], exclude: "needs the Docker daemon socket, which a sandbox cannot safely expose" },
  podman: { exclude: "needs the container runtime outside the sandbox" },
  kubectl: { writes: ["~/.kube"] },
  terraform: { hosts: ["registry.terraform.io", "releases.hashicorp.com"], netSubcommands: ["init", "plan", "apply", "destroy", "get", "providers"], writes: ["~/.terraform.d"] },
  aws: { hosts: ["amazonaws.com"], exclude: "uses your cloud credentials; run it outside the sandbox or through a broker" },
  gcloud: { hosts: ["googleapis.com"], exclude: "uses your cloud credentials; run it outside the sandbox or through a broker" },
  az: { hosts: ["management.azure.com"], exclude: "uses your cloud credentials; run it outside the sandbox or through a broker" },
  ssh: { exclude: "needs your SSH keys, which the sandbox protects" },
  scp: { exclude: "needs your SSH keys, which the sandbox protects" },
  rsync: {},
  ollama: { hosts: ["registry.ollama.ai"], netSubcommands: ["pull", "push", "run"], writes: ["~/.ollama"] },
  next: { bindSubcommands: ["dev", "start"] },
  vite: { bindSubcommands: ["", "dev", "preview", "serve"] },
  astro: { bindSubcommands: ["dev", "preview"] },
  nuxt: { bindSubcommands: ["dev", "preview"] },
  remix: { bindSubcommands: ["dev"] },
  expo: { hosts: ["exp.host", "api.expo.dev"], bindSubcommands: ["start", "run"] },
  "http-server": { bindSubcommands: [""] },
  serve: { bindSubcommands: [""] },
  uvicorn: { bindSubcommands: [""] },
  gunicorn: { bindSubcommands: [""] },
  flask: { bindSubcommands: ["run"] },
  rails: { bindSubcommands: ["server", "s"] },
  jekyll: { bindSubcommands: ["serve", "s"] },
  hugo: { bindSubcommands: ["server", "serve"] },
};

/** Programs whose side effects are fully described by their arguments (or that have none). */
export const KNOWN_LOCAL = new Set([
  "ls", "cat", "head", "tail", "less", "more", "wc", "sort", "uniq", "cut", "tr", "grep", "egrep", "rg", "ag", "find", "fd", "sed", "awk", "jq", "yq",
  "echo", "printf", "true", "false", "test", "[", "pwd", "cd", "pushd", "popd", "which", "type", "command", "whoami", "date", "env", "printenv", "export",
  "mkdir", "touch", "cp", "mv", "rm", "rmdir", "ln", "chmod", "chown", "tee", "tar", "unzip", "zip", "gzip", "gunzip", "xz", "diff", "cmp", "patch",
  "file", "stat", "du", "df", "basename", "dirname", "realpath", "readlink", "sleep", "kill", "pkill", "ps", "top", "lsof", "xargs", "tree", "md5", "shasum",
  "node", "python", "python3", "ruby", "perl", "php", "java", "javac", "tsc", "tsx", "ts-node", "jest", "vitest", "mocha", "pytest", "eslint", "prettier",
  "biome", "ruff", "black", "mypy", "make", "cmake", "clang", "gcc", "rustc", "swift", "swiftc", "xcodebuild", "xcrun", "open", "pbcopy", "pbpaste",
  "osascript", "say", "afplay", "sips", "ffmpeg", "magick", "convert", "sqlite3", "psql", "mysql", "redis-cli", "source", ".", "set", "unset", "exit",
  "wait", "read", "local", "return", "for", "while", "if", "then", "else", "fi", "do", "done", "case", "esac", "function", "trap", "seq", "column", "nl",
  "base64", "hexdump", "od", "strings", "iconv", "split", "comm", "join", "paste", "fold", "fmt", "rev", "tac", "yes", "time", "timeout", "nohup", "nice",
  "git", "curl", "wget", "http", "https", "xh", "bash", "sh", "zsh", "eval", "exec", "sudo", "caffeinate", "stdbuf", "watch", "defaults", "plutil", "mdfind",
  "deactivate", "ffprobe", "pgrep", "ssh-keygen", "dig", "nslookup", "host", "ping", "nc", "lipo", "codesign", "security", "ditto", "hdiutil", "textutil", "pdftotext",
  "until", "break", "continue", "select", "[[", "]]", "!", "shift", "getopts", "declare", "typeset", "readonly", "let", "mapfile", "noglob",
  "launchctl", "systemctl", "journalctl", "lsblk", "uname", "hostname", "id", "groups", "ulimit", "umask", "alias", "history", "clear", "tput", "stty",
]);

/** Commands that wrap another command: the real program follows. */
export const WRAPPERS: Record<string, { skipFlagsWithValue?: string[]; skipPositional?: number }> = {
  sudo: { skipFlagsWithValue: ["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U"] },
  env: { skipFlagsWithValue: ["-u", "-C", "-S"] },
  time: {},
  nohup: {},
  nice: { skipFlagsWithValue: ["-n"] },
  timeout: { skipFlagsWithValue: ["-s", "-k", "--signal", "--kill-after"], skipPositional: 1 },
  exec: {},
  command: {},
  builtin: {},
  caffeinate: { skipFlagsWithValue: ["-t", "-w"] },
  stdbuf: { skipFlagsWithValue: ["-i", "-o", "-e"] },
  watch: { skipFlagsWithValue: ["-n", "-d"] },
  xargs: { skipFlagsWithValue: ["-I", "-n", "-P", "-L", "-s", "-d", "-E", "-a"] },
  "bundle exec": {},
};

/** Paths that hold secrets. A sandbox policy from sandfit always denies reading these. */
export const SECRET_PATHS = [
  "~/.ssh",
  "~/.aws",
  "~/.gnupg",
  "~/.config/gcloud",
  "~/.azure",
  "~/.kube/config",
  "~/.docker/config.json",
  "~/.npmrc",
  "~/.pypirc",
  "~/.netrc",
  "~/.git-credentials",
  "~/.config/gh/hosts.yml",
  "~/.cargo/credentials.toml",
  "~/.terraform.d/credentials.tfrc.json",
  "~/Library/Keychains",
  "~/.password-store",
  "~/.local/share/keyrings",
];

/** Entries in SECRET_PATHS that are single files rather than directories. */
export const SECRET_FILES = new Set([
  "~/.kube/config",
  "~/.docker/config.json",
  "~/.npmrc",
  "~/.pypirc",
  "~/.netrc",
  "~/.git-credentials",
  "~/.config/gh/hosts.yml",
  "~/.cargo/credentials.toml",
  "~/.terraform.d/credentials.tfrc.json",
]);

/** Files inside a project that hold secrets. Denied for reading and writing. */
export const SECRET_PROJECT_GLOBS = [".env", ".env.*", "*.pem", "*.key", ".envrc"];

/**
 * Paths an agent must never be able to change, because changing them would let it
 * loosen its own sandbox (the "agent disables its own sandbox" failure class).
 */
export const SELF_PROTECT_PATHS = [
  "~/.claude/settings.json",
  "~/.claude/settings.local.json",
  ".claude/settings.json",
  ".claude/settings.local.json",
  "~/.codex/config.toml",
  "~/.srt-settings.json",
  "~/.config/nono",
  ".git/hooks",
  "~/.zshrc",
  "~/.bashrc",
  "~/.bash_profile",
  "~/.profile",
  "~/.zprofile",
];
