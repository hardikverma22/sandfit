/**
 * A labelled set of shell commands that coding agents really run, with what each one needs
 * from a sandbox in order to work. This is the ground truth the accuracy benchmark scores
 * sandfit against.
 *
 * Labels describe what the command needs on a typical developer machine. They were
 * written from how the tools behave, NOT from sandfit's output, so they include cases
 * sandfit gets wrong (look for `known limit` notes).
 *
 * Need labels:
 *   net:<host>       an outbound connection to this host
 *   write:<path>     a write outside the project and temp dirs ("~" = home)
 *   bind:localhost   listens on a local port (dev server)
 *   exec:<program>   cannot work inside an OS sandbox; must run outside it
 *   secret:<path>    reads a file that holds credentials ("./" = project)
 *
 * `optional` lists needs that are fine to report but not required (for example a
 * registry `npx` only contacts when the tool is not installed locally).
 *
 * The benchmark runs with a fake home where common cache folders exist, and a project
 * at ~/app whose git remote is https://github.com/acme/app.git.
 */
export interface Case {
  cmd: string;
  expect: string[];
  optional?: string[];
  note?: string;
}

const NPM = ["net:registry.npmjs.org", "write:~/.npm"];
const PNPM = ["net:registry.npmjs.org", "write:~/.local/share/pnpm", "write:~/.cache/pnpm"];
const PIP = ["net:pypi.org", "net:files.pythonhosted.org", "write:~/.cache/pip"];
const UV = ["net:pypi.org", "net:files.pythonhosted.org", "write:~/.cache/uv"];
const UV_OPT = ["net:github.com", "write:~/.local/share/uv"];
const CARGO_NET = ["net:index.crates.io", "net:static.crates.io"];
const GH_HOSTS = ["net:github.com", "net:api.github.com", "net:codeload.github.com", "net:objects.githubusercontent.com"];

export const CORPUS: Case[] = [
  // JavaScript package managers
  { cmd: "npm install", expect: NPM },
  { cmd: "npm ci", expect: NPM },
  { cmd: "npm i -D vitest @types/node", expect: NPM },
  { cmd: "npm test", expect: [] },
  { cmd: "npm run build", expect: [] },
  { cmd: "npm run lint -- --fix", expect: [] },
  { cmd: "npm run dev", expect: ["bind:localhost"] },
  { cmd: "npm start", expect: ["bind:localhost"] },
  { cmd: "npm run storybook", expect: ["bind:localhost"] },
  { cmd: "npm run dev -- --port 3001", expect: ["bind:localhost"] },
  { cmd: "npm publish --access public", expect: NPM },
  { cmd: "npm --prefix web install", expect: NPM },
  { cmd: "cd web && npm install", expect: NPM },
  { cmd: "npm ci && npm run build && npm test", expect: NPM },
  { cmd: "npx create-next-app@latest ../site --ts", expect: [...NPM, "write:~/site"] },
  { cmd: "npx tsc --noEmit", expect: [], optional: NPM, note: "npx runs the local bin; the registry is only needed if it is missing" },
  { cmd: "npx vitest run", expect: [], optional: NPM },
  { cmd: "npx prettier --write .", expect: [], optional: NPM },
  { cmd: "npx vite", expect: ["bind:localhost"], optional: NPM },
  { cmd: "npx next dev", expect: ["bind:localhost"], optional: NPM },
  { cmd: "npx playwright install chromium", expect: ["net:cdn.playwright.dev", "net:playwright.download.prss.microsoft.com", "write:~/.cache/ms-playwright"], optional: NPM },
  { cmd: "pnpm install", expect: PNPM },
  { cmd: "pnpm add zod", expect: PNPM },
  { cmd: "pnpm dev", expect: ["bind:localhost"] },
  { cmd: "pnpm run test", expect: [] },
  { cmd: "pnpm --filter web dev", expect: ["bind:localhost"] },
  { cmd: "pnpm dlx shadcn@latest add button", expect: PNPM, optional: ["net:ui.shadcn.com"] },
  { cmd: "timeout 300 pnpm install --frozen-lockfile", expect: PNPM },
  { cmd: "yarn", expect: ["net:registry.yarnpkg.com", "write:~/.cache/yarn"], optional: ["net:registry.npmjs.org"] },
  { cmd: "yarn add react", expect: ["net:registry.yarnpkg.com", "write:~/.cache/yarn"], optional: ["net:registry.npmjs.org"] },
  { cmd: "yarn build", expect: [] },
  { cmd: "bun install", expect: ["net:registry.npmjs.org", "write:~/.bun"] },
  { cmd: "bun run dev", expect: ["bind:localhost"] },
  { cmd: "bun test", expect: [] },
  { cmd: "sudo npm install -g pnpm", expect: NPM, optional: ["write:/usr/local/lib/node_modules"] },
  { cmd: "env NODE_ENV=production npm ci", expect: NPM },
  { cmd: "nohup npm run dev > dev.log 2>&1 &", expect: ["bind:localhost"] },
  { cmd: "deno run -A main.ts", expect: ["write:~/.cache/deno"], optional: ["net:deno.land", "net:jsr.io", "net:registry.npmjs.org"] },

  // Python
  { cmd: "pip install requests", expect: PIP },
  { cmd: "pip install -r requirements.txt", expect: PIP },
  { cmd: "pip3 install --user httpie", expect: PIP, optional: ["write:~/.local"] },
  { cmd: "python -m pip install -U pip", expect: PIP },
  { cmd: "python3 -m pip install black", expect: PIP },
  { cmd: "sh -c 'pip install black'", expect: PIP },
  { cmd: "python3 -m venv .venv", expect: [] },
  { cmd: "python -m pytest -q", expect: [] },
  { cmd: "python -m http.server 8000", expect: ["bind:localhost"] },
  { cmd: "uv sync", expect: UV, optional: UV_OPT },
  { cmd: "uv add httpx", expect: UV, optional: UV_OPT },
  { cmd: "uv run pytest", expect: ["write:~/.cache/uv"], optional: ["net:pypi.org", "net:files.pythonhosted.org", ...UV_OPT], note: "uv run syncs first, which may or may not need the network" },
  { cmd: "poetry install", expect: ["net:pypi.org", "net:files.pythonhosted.org", "write:~/.cache/pypoetry"] },
  { cmd: "pipx install ruff", expect: ["net:pypi.org", "net:files.pythonhosted.org", "write:~/.local/pipx", "write:~/.local/bin"] },
  { cmd: "pytest --cov=src tests/", expect: [] },
  { cmd: "uvicorn app.main:app --reload", expect: ["bind:localhost"] },
  { cmd: "flask run --port 5001", expect: ["bind:localhost"] },
  { cmd: "hf download org/model --local-dir models", expect: ["net:huggingface.co", "write:~/.cache/huggingface"], optional: ["net:cdn-lfs.huggingface.co"] },

  // Rust, Go, JVM, PHP, Ruby
  { cmd: "cargo build", expect: [...CARGO_NET, "write:~/.cargo"], optional: ["net:crates.io"] },
  { cmd: "time cargo build --release", expect: [...CARGO_NET, "write:~/.cargo"], optional: ["net:crates.io"] },
  { cmd: "cargo test", expect: [], optional: [...CARGO_NET, "net:crates.io", "write:~/.cargo"] },
  { cmd: "rustup target add wasm32-unknown-unknown", expect: ["net:static.rust-lang.org", "write:~/.rustup"], optional: ["write:~/.cargo"] },
  { cmd: "go build ./...", expect: ["write:~/.cache/go-build"], optional: ["net:proxy.golang.org", "net:sum.golang.org", "write:~/go"] },
  { cmd: "go mod tidy", expect: ["net:proxy.golang.org", "net:sum.golang.org", "write:~/go"], optional: ["write:~/.cache/go-build"] },
  { cmd: "go test ./...", expect: ["write:~/.cache/go-build"], optional: ["net:proxy.golang.org", "net:sum.golang.org", "write:~/go"] },
  { cmd: "go install golang.org/x/tools/gopls@latest", expect: ["net:proxy.golang.org", "net:sum.golang.org", "write:~/go"], optional: ["write:~/.cache/go-build"] },
  { cmd: "mvn -q package", expect: ["net:repo.maven.apache.org", "write:~/.m2"], optional: ["net:repo1.maven.org"] },
  { cmd: "./gradlew build", expect: ["net:services.gradle.org", "write:~/.gradle"], optional: ["net:plugins.gradle.org", "net:repo.maven.apache.org"] },
  { cmd: "composer install", expect: ["net:repo.packagist.org", "write:~/.cache/composer"], optional: ["net:packagist.org", "net:github.com"] },
  { cmd: "bundle exec rake test", expect: [] },
  { cmd: "rails s", expect: ["bind:localhost"] },

  // git
  { cmd: "git status", expect: [] },
  { cmd: 'git commit -m "fix: handle empty input"', expect: [] },
  { cmd: "git log --oneline -5", expect: [] },
  { cmd: "git pull", expect: ["net:github.com"] },
  { cmd: "git fetch --all --prune", expect: ["net:github.com"] },
  { cmd: "git push origin main", expect: ["net:github.com", "exec:git push"] },
  { cmd: "git push --force-with-lease", expect: ["net:github.com", "exec:git push"] },
  { cmd: "git clone https://github.com/vercel/next.js ../next", expect: ["net:github.com", "write:~/next"] },
  { cmd: "git clone git@github.com:acme/lib.git /tmp/lib", expect: ["net:github.com", "exec:git clone"] },
  { cmd: "git submodule update --init --recursive", expect: ["net:github.com"] },
  { cmd: "git ls-remote https://gitlab.com/a/b.git", expect: ["net:gitlab.com"] },

  // HTTP clients
  { cmd: "curl -s https://api.github.com/repos/acme/app", expect: ["net:api.github.com"] },
  { cmd: "curl -fsSL https://bun.sh/install | bash", expect: ["net:bun.sh"], optional: ["write:~/.bun"] },
  { cmd: "wget -q https://example.com/file.tar.gz -O /tmp/f.tgz", expect: ["net:example.com"] },
  { cmd: "curl localhost:3000/api/health", expect: ["bind:localhost"] },
  { cmd: "curl -s http://127.0.0.1:8000/docs", expect: ["bind:localhost"] },
  { cmd: 'curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d \'{"a":1}\' https://api.openai.com/v1/chat/completions', expect: ["net:api.openai.com"] },
  { cmd: "curl -o out.json https://registry.npmjs.org/react", expect: ["net:registry.npmjs.org"] },
  { cmd: "curl -sS api.example.com/v1/users", expect: ["net:api.example.com"] },
  { cmd: "curl -sS https://raw.githubusercontent.com/a/b/main/install.sh -o ~/bin/install.sh", expect: ["net:raw.githubusercontent.com", "write:~/bin/install.sh"] },
  { cmd: "http GET api.example.com/users", expect: ["net:api.example.com"] },
  { cmd: "echo $(curl -s https://ifconfig.me)", expect: ["net:ifconfig.me"] },
  { cmd: "diff <(curl -s https://a.example.com/v1) <(curl -s https://b.example.com/v1)", expect: ["net:a.example.com", "net:b.example.com"] },
  { cmd: 'bash -c "cd /tmp && curl -sO https://example.org/x.sh"', expect: ["net:example.org"] },
  { cmd: "xargs -n1 curl -sI < urls.txt", expect: [], note: "hosts come from a file; nothing to learn" },

  // Writes outside the project
  { cmd: "echo hi > ~/notes.txt", expect: ["write:~/notes.txt"] },
  { cmd: "mkdir -p ~/.config/myapp && cp config.json ~/.config/myapp/", expect: ["write:~/.config/myapp", "write:~/.config/myapp/config.json"] },
  { cmd: "tee -a /var/log/app.log < input.txt", expect: ["write:/var/log/app.log"] },
  { cmd: "touch /tmp/marker", expect: [] },
  { cmd: "rm -rf node_modules dist", expect: [] },
  { cmd: "cp .env.example .env", expect: [] },
  { cmd: "sed -i 's/old/new/' ~/.zshrc", expect: ["write:~/.zshrc"] },
  { cmd: 'echo "export PATH=$PATH:~/bin" >> ~/.bashrc', expect: ["write:~/.bashrc"] },
  { cmd: "ln -sf $(pwd)/bin/tool ~/.local/bin/tool", expect: ["write:~/.local/bin/tool"] },
  { cmd: "mv build.zip ~/Downloads/", expect: ["write:~/Downloads/build.zip"] },
  { cmd: "tar -xzf archive.tgz -C ~/opt", expect: ["write:~/opt"] },
  { cmd: "unzip -q pkg.zip -d /opt/pkg", expect: ["write:/opt/pkg"] },
  { cmd: "cat > ~/.config/app.toml <<'EOF'\nkey = 1\nEOF", expect: ["write:~/.config/app.toml"] },
  { cmd: "install -m 755 bin/tool /usr/local/bin/tool", expect: ["write:/usr/local/bin/tool"] },
  { cmd: "chmod +x ~/bin/deploy.sh", expect: ["write:~/bin/deploy.sh"] },
  { cmd: "cd .. && touch sibling.txt", expect: ["write:~/sibling.txt"] },
  { cmd: "(cd /tmp && touch x) && touch ~/y", expect: ["write:~/y"] },
  { cmd: "cp -r ~/templates/base ./new", expect: [] },
  { cmd: "for f in *.md; do cat \"$f\"; done", expect: [] },
  { cmd: "FOO=bar make build", expect: [] },
  { cmd: `node -e "require('fs').writeFileSync(require('os').homedir()+'/x','y')"`, expect: ["write:~/x"], note: "known limit: writes made from inside a script are invisible in the transcript" },

  // Secrets
  { cmd: "cat .env", expect: ["secret:./.env"] },
  { cmd: "grep API_KEY .env.local", expect: ["secret:./.env.local"] },
  { cmd: "source .env && npm run deploy", expect: ["secret:./.env"] },
  { cmd: "cat ~/.ssh/id_ed25519.pub", expect: ["secret:~/.ssh/id_ed25519.pub"] },
  { cmd: "head -5 ~/.aws/credentials", expect: ["secret:~/.aws/credentials"] },
  { cmd: "less ~/.kube/config", expect: ["secret:~/.kube/config"] },
  { cmd: "cat ~/.config/gh/hosts.yml", expect: ["secret:~/.config/gh/hosts.yml"] },
  { cmd: "base64 < ~/.ssh/id_rsa", expect: ["secret:~/.ssh/id_rsa"] },

  // Tools that cannot run inside an OS sandbox
  { cmd: "docker build -t app .", expect: ["exec:docker"] },
  { cmd: "docker compose up -d", expect: ["exec:docker"] },
  { cmd: "docker run -p 8080:80 nginx", expect: ["exec:docker"] },
  { cmd: "ssh deploy@example.com uptime", expect: ["exec:ssh"] },
  { cmd: "scp dist.tgz deploy@example.com:/srv", expect: ["exec:scp"] },
  { cmd: "rsync -av dist/ deploy@example.com:/var/www/", expect: ["exec:rsync"] },
  { cmd: "gh pr create --fill", expect: ["exec:gh"], optional: GH_HOSTS },
  { cmd: "gh api repos/acme/app/issues", expect: ["exec:gh"], optional: GH_HOSTS },
  { cmd: "aws s3 ls", expect: ["exec:aws"], optional: ["net:amazonaws.com"] },
  { cmd: "gcloud run deploy api --source .", expect: ["exec:gcloud"], optional: ["net:googleapis.com"] },
  { cmd: "kubectl get pods -n prod", expect: ["exec:kubectl"], optional: ["write:~/.kube"] },
  { cmd: "apt-get install -y jq", expect: ["exec:apt-get"] },
  { cmd: "sudo apt install -y ripgrep", expect: ["exec:apt"] },

  // Hosted platforms and other tools
  { cmd: "wrangler deploy", expect: ["net:api.cloudflare.com"], optional: ["net:dash.cloudflare.com"] },
  { cmd: "vercel --prod", expect: ["net:api.vercel.com"], optional: ["net:vercel.com"] },
  { cmd: "stripe listen --forward-to localhost:3000/webhook", expect: ["net:api.stripe.com"], optional: ["bind:localhost"] },
  { cmd: "ollama pull llama3", expect: ["net:registry.ollama.ai", "write:~/.ollama"] },
  { cmd: "hugo server -D", expect: ["bind:localhost"] },
  { cmd: "vite --port 5173", expect: ["bind:localhost"] },
  { cmd: "vite build", expect: [] },
];
