import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

// The Inter font runs inside the webview, so ship it next to the extension.
mkdirSync("dist/fonts", { recursive: true });
const inter = "node_modules/@fontsource-variable/inter";
copyFileSync(`${inter}/files/inter-latin-opsz-normal.woff2`, "dist/fonts/inter-latin-opsz-normal.woff2");
copyFileSync(`${inter}/LICENSE`, "dist/fonts/Inter-OFL.txt");
// Prism is bundled into dist/highlight.js; its MIT license travels with it.
copyFileSync("node_modules/prismjs/LICENSE", "dist/Prism-LICENSE.txt");

const shared = { bundle: true, sourcemap: !production, minify: production, logLevel: "info" };

const contexts = await Promise.all([
  // The extension itself, running in VS Code's extension host.
  esbuild.context({
    ...shared,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    format: "cjs",
    platform: "node",
    target: "node18",
    external: ["vscode"],
  }),
  // The syntax highlighter, running inside the webview.
  esbuild.context({
    ...shared,
    entryPoints: ["src/webview/highlight.ts"],
    outfile: "dist/highlight.js",
    format: "iife",
    platform: "browser",
    target: "es2022",
  }),
]);

if (watch) {
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
}
