import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv07 from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { toClaudeSettings } from "../src/emit/claude.js";
import { SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";
import { toNonoProfile, toSrtSettings } from "../src/emit/others.js";
import { analyze } from "../src/extract/extract.js";
import { ingest } from "../src/ingest/index.js";
import { buildPolicy } from "../src/policy/build.js";

// Vendored from json.schemastore.org (Claude Code) and the nono repository.
const schema = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`./schemas/${name}`, import.meta.url)), "utf8"));
const FIX = fileURLToPath(new URL("./fixtures/", import.meta.url));

async function policy() {
  const ing = await ingest({ claudeDir: `${FIX}claude`, codexDir: `${FIX}codex` });
  return buildPolicy(analyze(ing.events, { home: "/home/test", readGitRemotes: false }), { home: "/home/test" });
}

function validator(s: any) {
  const A: any = String(s.$schema ?? "").includes("2020") ? (Ajv2020 as any).default ?? Ajv2020 : (Ajv07 as any).default ?? Ajv07;
  const ajv = new A({ strict: false, allErrors: true });
  ((addFormats as any).default ?? addFormats)(ajv);
  return ajv.compile(s);
}

describe("emitted configs match the tools' published schemas", () => {
  it("Claude Code settings", async () => {
    const validate = validator(schema("claude-code-settings.json"));
    const p = await policy();
    for (const settings of [toClaudeSettings(p), toClaudeSettings(p, { withPermissions: true }), toClaudeSettings(p, { user: true, strictNetwork: true })]) {
      const ok = validate(settings);
      expect(validate.errors ?? []).toEqual([]);
      expect(ok).toBe(true);
    }
  });

  it("Claude Code settings with credential masking (everything except the mask entries themselves)", async () => {
    // SchemaStore's schema still lists only mode "deny" for credentials, while Claude Code's docs
    // document mode "mask" (code.claude.com/docs/en/sandboxing#mask-credentials). Validate the rest
    // of the config here; test/emit.test.ts checks the mask entries against the documented shape.
    const validate = validator(schema("claude-code-settings.json"));
    const p = { ...(await policy()), maskEnv: [{ name: "OPENAI_API_KEY", hosts: ["registry.npmjs.org"] }] };
    const settings = toClaudeSettings(p, { user: true, maskCredentials: true }) as any;
    expect(settings.sandbox.credentials.envVars[0].mode).toBe("mask");
    delete settings.sandbox.credentials;
    const ok = validate(settings);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("nono profile", async () => {
    const validate = validator(schema("nono-profile.json"));
    const ok = validate(toNonoProfile(await policy()));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("sandbox-runtime settings (validated with srt's own schema)", async () => {
    const r = SandboxRuntimeConfigSchema.safeParse(toSrtSettings(await policy()));
    expect(r.success ? [] : r.error.issues).toEqual([]);
  });
});
