/**
 * A small, dependency-free POSIX shell parser that is good enough to answer one question:
 * "which programs ran, with which arguments, and where did their output go?"
 *
 * It handles quoting, escapes, pipelines and lists (| && || ; &), subshells, command and
 * process substitution, redirections and heredocs. It does not evaluate variables except
 * $HOME/~, and it never executes anything.
 */

export interface Redirect {
  op: string; // ">", ">>", "<", "&>", ">&" ...
  target: string;
}

export interface SimpleCommand {
  argv: string[];
  assignments: string[];
  redirects: Redirect[];
  /** Effective working directory, after any preceding `cd` in the same script. */
  cwd: string;
}

type Token =
  | { t: "word"; v: string }
  | { t: "op"; v: string }
  | { t: "redir"; op: string };

const OPS = ["&&", "||", ";;", "|&", ";", "|", "&", "(", ")", "\n"];

export interface ParseContext {
  cwd: string;
  home: string;
}

export function parseShell(script: string, ctx: ParseContext): SimpleCommand[] {
  const nested: string[] = [];
  const tokens = lex(script, ctx, nested);
  const out = group(tokens, ctx);
  for (const inner of nested) {
    // Substitutions run in the same cwd context as the outer command, approximately.
    out.push(...parseShell(inner, ctx));
  }
  return out;
}

function lex(src: string, ctx: ParseContext, nested: string[]): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  const pendingHeredocs: { delim: string; strip: boolean }[] = [];

  const readBalanced = (start: number, open: string, close: string): [string, number] => {
    // start points just after the opening delimiter
    let depth = 1;
    let j = start;
    let quote: string | null = null;
    while (j < n) {
      const c = src[j]!;
      if (quote) {
        if (c === "\\" && quote === '"') {
          j += 2;
          continue;
        }
        if (c === quote) quote = null;
      } else if (c === "'" || c === '"') {
        quote = c;
      } else if (c === "\\") {
        j += 2;
        continue;
      } else if (c === open) {
        depth++;
      } else if (c === close) {
        depth--;
        if (depth === 0) return [src.slice(start, j), j + 1];
      }
      j++;
    }
    return [src.slice(start), n];
  };

  while (i < n) {
    const c = src[i]!;

    // Newline: flush heredoc bodies first.
    if (c === "\n") {
      tokens.push({ t: "op", v: "\n" });
      i++;
      while (pendingHeredocs.length) {
        const { delim, strip } = pendingHeredocs.shift()!;
        while (i < n) {
          const end = src.indexOf("\n", i);
          const lineEnd = end === -1 ? n : end;
          const line = src.slice(i, lineEnd);
          i = end === -1 ? n : end + 1;
          if ((strip ? line.replace(/^\t+/, "") : line) === delim) break;
        }
      }
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "\\" && src[i + 1] === "\n") {
      i += 2;
      continue;
    }
    if (c === "#") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }

    // Redirections, optionally prefixed by an fd number: 2>, 2>>, 1>&2, &>, <<<, <<EOF
    const redir = /^(\d*)(<<<|<<-|<<|&>>|&>|>>|>&|<&|>\||<>|>|<)/.exec(src.slice(i, i + 5));
    if (redir && !(redir[2] === "<" && src[i + 1] === "(") && !(redir[2] === ">" && src[i + 1] === "(")) {
      const op = redir[2]!;
      i += redir[0].length;
      if (op === "<<" || op === "<<-") {
        while (src[i] === " " || src[i] === "\t") i++;
        const m = /^(['"]?)([^\s'";|&<>()]+)\1/.exec(src.slice(i));
        if (m) {
          pendingHeredocs.push({ delim: m[2]!, strip: op === "<<-" });
          i += m[0].length;
        }
        continue;
      }
      if ((op === ">&" || op === "<&") && /^[\d-]/.test(src[i] ?? "")) {
        // fd duplication like 2>&1: no file involved
        while (i < n && /[\d-]/.test(src[i]!)) i++;
        continue;
      }
      tokens.push({ t: "redir", op });
      continue;
    }

    // Process substitution <( ... ) and >( ... )
    if ((c === "<" || c === ">") && src[i + 1] === "(") {
      const [inner, next] = readBalanced(i + 2, "(", ")");
      nested.push(inner);
      tokens.push({ t: "word", v: "/dev/fd/63" });
      i = next;
      continue;
    }

    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      tokens.push({ t: "op", v: op });
      i += op.length;
      continue;
    }

    // A word: concatenation of quoted and unquoted segments.
    let word = "";
    let sawAny = false;
    let atStart = true;
    while (i < n) {
      const ch = src[i]!;
      if (" \t\r\n;&|()<>".includes(ch)) {
        // `<` or `>` inside a word only ends it when it begins a redirection
        break;
      }
      sawAny = true;
      if (ch === "'") {
        const end = src.indexOf("'", i + 1);
        word += src.slice(i + 1, end === -1 ? n : end);
        i = end === -1 ? n : end + 1;
      } else if (ch === "$" && src[i + 1] === "'") {
        const end = src.indexOf("'", i + 2);
        word += src.slice(i + 2, end === -1 ? n : end).replace(/\\n/g, "\n").replace(/\\t/g, "\t");
        i = end === -1 ? n : end + 1;
      } else if (ch === '"') {
        i++;
        while (i < n && src[i] !== '"') {
          if (src[i] === "\\" && i + 1 < n && '"\\$`\n'.includes(src[i + 1]!)) {
            word += src[i + 1];
            i += 2;
          } else if (src[i] === "$" && src[i + 1] === "(" && src[i + 2] !== "(") {
            const [inner, next] = readBalanced(i + 2, "(", ")");
            nested.push(inner);
            word += "$(…)";
            i = next;
          } else if (src[i] === "`") {
            const end = src.indexOf("`", i + 1);
            nested.push(src.slice(i + 1, end === -1 ? n : end));
            word += "$(…)";
            i = end === -1 ? n : end + 1;
          } else {
            word += src[i];
            i++;
          }
        }
        i++;
      } else if (ch === "\\") {
        if (i + 1 < n) word += src[i + 1];
        i += 2;
      } else if (ch === "$" && src[i + 1] === "(" && src[i + 2] !== "(") {
        const [inner, next] = readBalanced(i + 2, "(", ")");
        nested.push(inner);
        word += "$(…)";
        i = next;
      } else if (ch === "$" && src[i + 1] === "(" && src[i + 2] === "(") {
        // arithmetic $(( ... ))
        const [, next] = readBalanced(i + 3, "(", ")");
        word += "0";
        i = next + 1;
      } else if (ch === "`") {
        const end = src.indexOf("`", i + 1);
        nested.push(src.slice(i + 1, end === -1 ? n : end));
        word += "$(…)";
        i = end === -1 ? n : end + 1;
      } else if (ch === "~" && atStart && (i + 1 >= n || "/ \t\n;&|)".includes(src[i + 1]!))) {
        word += ctx.home;
        i++;
      } else if (ch === "$" && /^\$(HOME\b|\{HOME\})/.test(src.slice(i))) {
        const m = /^\$(HOME\b|\{HOME\})/.exec(src.slice(i))!;
        word += ctx.home;
        i += m[0].length;
      } else {
        word += ch;
        i++;
      }
      atStart = false;
    }
    if (sawAny) tokens.push({ t: "word", v: word });
    else i++; // safety: never loop forever on an unexpected char
  }
  return tokens;
}

function group(tokens: Token[], ctx: ParseContext): SimpleCommand[] {
  const out: SimpleCommand[] = [];
  const cwdStack: string[] = [];
  let cwd = ctx.cwd;
  let cur: SimpleCommand = { argv: [], assignments: [], redirects: [], cwd };
  let expectTarget: string | null = null;

  const flush = () => {
    if (cur.argv.length || cur.redirects.length) {
      out.push(cur);
      // `cd` changes the cwd of everything after it in this script
      if (cur.argv[0] === "cd" || cur.argv[0] === "pushd") {
        const target = cur.argv.find((a, idx) => idx > 0 && !a.startsWith("-"));
        if (!target || target === "~") cwd = ctx.home;
        else if (target !== "-") cwd = resolvePath(cwd, target);
      }
    }
    cur = { argv: [], assignments: [], redirects: [], cwd };
  };

  for (const tok of tokens) {
    if (tok.t === "redir") {
      expectTarget = tok.op;
      continue;
    }
    if (tok.t === "word") {
      if (expectTarget) {
        cur.redirects.push({ op: expectTarget, target: resolvePath(cur.cwd, tok.v) });
        expectTarget = null;
        continue;
      }
      if (cur.argv.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok.v)) {
        cur.assignments.push(tok.v);
        continue;
      }
      if (cur.argv.length === 0 && (tok.v === "{" || tok.v === "}")) continue;
      cur.argv.push(tok.v);
      continue;
    }
    // operator
    expectTarget = null;
    if (tok.v === "(") {
      flush();
      cwdStack.push(cwd);
      continue;
    }
    if (tok.v === ")") {
      flush();
      cwd = cwdStack.pop() ?? cwd;
      cur.cwd = cwd;
      continue;
    }
    flush();
  }
  flush();
  return out;
}

export function resolvePath(cwd: string, p: string): string {
  if (!p) return cwd;
  if (p.startsWith("/")) return normalize(p);
  return normalize(`${cwd.replace(/\/+$/, "")}/${p}`);
}

function normalize(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}
