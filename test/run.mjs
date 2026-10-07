// Bundles each test/*.test.ts with esbuild (pointing `vscode` at test/fake-vscode.ts), then runs them
// with Node's built-in test runner. Usage: npm test
import * as esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";

const outdir = ".test-build";
rmSync(outdir, { recursive: true, force: true });

const tests = readdirSync("test").filter((f) => f.endsWith(".test.ts"));
await esbuild.build({
  entryPoints: tests.map((f) => `test/${f}`),
  outdir,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  alias: { vscode: "./test/fake-vscode.ts" },
  // The Anthropic SDK is CommonJS; this lets the ESM bundle require it.
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  logLevel: "warning",
});

const files = tests.map((f) => `${outdir}/${f.replace(/\.ts$/, ".mjs")}`);
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
