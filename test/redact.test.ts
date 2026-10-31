import { describe, expect, it } from "vitest";
import { redact } from "../src/redact.js";

// All values below are fabricated; they only have the shape of real credentials.
describe("redact", () => {
  it.each([
    [`K='AQ.Zz9XY1abCdEfGhIjKlMnOpQrStUvWxYz0123456789ab' && curl -s https://x`, "AQ.Zz9"],
    [`printf 'SKETCHFAB_TOKEN=9f8e7d6c5b4a39281706f5e4d3c2b1a0\\n' >> .env.local`, "9f8e7d6c"],
    [`curl -H "Authorization: Bearer abc.def.ghi123" https://api`, "abc.def"],
    [`export OPENAI_API_KEY=sk-proj-AbCdEf1234567890ghIJkl`, "sk-proj"],
    [`gh auth login --with-token ghp_AbCdEfGhIjKlMnOpQrStUvWxYz012345`, "ghp_"],
    [`curl "https://x.googleapis.com/v1?key=AIzaSyA1b2C3d4E5f6G7h8I9j0KlMnOpQrSt"`, "AIzaSy"],
    [`psql postgres://u:pw@h/db --password=hunter2xyz`, "hunter2"],
  ])("masks %s", (input, secret) => {
    expect(redact(input)).not.toContain(secret);
  });

  it("leaves ordinary commands readable", () => {
    const cmd = "cd /Users/me/Projects/app && npm install lodash && git push origin feature/login-page";
    expect(redact(cmd)).toBe(cmd);
    expect(redact("grep -n TryOnPipeline src/features/try-on/TryOnStudio.tsx")).toContain("TryOnStudio.tsx");
  });
});
