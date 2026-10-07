// Syntax highlighting for the webview's code blocks. Bundled to dist/highlight.js, which sets
// window.csHighlight(code, language) -> HTML string, or null when the language isn't known.
import "./prism-manual";
import Prism from "prismjs";
// Order matters: each grammar after the ones it builds on.
import "prismjs/components/prism-markup-templating";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-python";
import "prismjs/components/prism-java";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-csharp";
import "prismjs/components/prism-go";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-ruby";
import "prismjs/components/prism-php";
import "prismjs/components/prism-kotlin";
import "prismjs/components/prism-swift";
import "prismjs/components/prism-json";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-scss";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-powershell";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-markdown";

/** VS Code language ids and common code-fence names that differ from Prism's grammar names. */
const ALIASES: Record<string, string> = {
  typescriptreact: "tsx",
  javascriptreact: "jsx",
  ts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  html: "markup",
  xml: "markup",
  svg: "markup",
  vue: "markup",
  svelte: "markup",
  jsonc: "json",
  py: "python",
  cs: "csharp",
  "c#": "csharp",
  "objective-c": "c",
  golang: "go",
  rs: "rust",
  rb: "ruby",
  kt: "kotlin",
  yml: "yaml",
  md: "markdown",
  shellscript: "bash",
  shell: "bash",
  sh: "bash",
  zsh: "bash",
  ps1: "powershell",
  less: "css",
  sass: "scss",
};

function highlight(code: string, language: string): string | null {
  const id = ALIASES[language.toLowerCase()] ?? language.toLowerCase();
  const grammar = Prism.languages[id];
  // Prism escapes the code itself, so the result is safe to set as HTML.
  return grammar ? Prism.highlight(code, grammar, id) : null;
}

(globalThis as { csHighlight?: typeof highlight }).csHighlight = highlight;
