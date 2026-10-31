import { createRequire } from "node:module";

// package.json is the single source of the version (the release workflow bumps only that).
// It sits one level above both src/ and dist/, and npm always ships it.
export const VERSION: string = createRequire(import.meta.url)("../package.json").version;
