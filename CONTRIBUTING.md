# Contributing to code storyline

Thanks for helping out! This guide covers running and debugging the extension locally.

## Prerequisites

- [Node.js](https://nodejs.org/) 18 or newer
- [VS Code](https://code.visualstudio.com/) 1.90 or newer
- An [Anthropic API key](https://console.anthropic.com/) for trying the command end to end

## Setup

```bash
git clone https://github.com/tarekwady/code-storyline.git
cd code-storyline
npm install
```

## Run and debug (F5)

1. Open the repository folder in VS Code.
2. Press **F5** (or open **Run and Debug** and pick **Run Extension**).
   This runs the `build` task, then launches an **Extension Development Host**, a second VS Code window with your local copy of the extension loaded. Your other installed extensions are disabled in that window so they can't interfere. It runs without the debugger, because on some machines attaching the debugger crashes that window a second after it opens.
3. In the Extension Development Host:
   - Set `codestoryline.apiKey` in its user settings (or start VS Code with `ANTHROPIC_API_KEY` set in your environment).
   - Open any source file and run **Show Code Storyline** from the Command Palette.
4. For breakpoints, pick **Debug Extension** in the **Run and Debug** view instead, then set breakpoints in `src/*.ts` in the original window; source maps map them to the bundle. If that window closes by itself right after opening, the debugger is crashing it on your machine: use **Run Extension** and `console.log`, and read the output in the test window with **Developer: Toggle Developer Tools** → **Console**.
5. After changing code, rebuild (`npm run build`, or keep `npm run watch` running) and reload the Extension Development Host with **Developer: Reload Window** (`Ctrl+R` / `Cmd+R`).

### Windows: "running scripts is disabled on this system"

PowerShell's default execution policy blocks `npm.ps1`, so `npm` fails in a PowerShell terminal. The F5 build task already runs through `cmd.exe` to avoid this. For your own terminal, either run `npm.cmd` instead of `npm`, switch the VS Code terminal to **Command Prompt** or **Git Bash**, or allow local scripts for your user with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

### Debugging the webview

The diagram is a webview, so its code (`media/main.js`, `media/main.css`) runs in a browser context, not the extension host. In the Extension Development Host, run **Developer: Open Webview Developer Tools** to inspect the DOM, see console output and set breakpoints. Changes to `media/` only need the panel closed and reopened.

## Project layout

| Path | What it does |
| --- | --- |
| `src/extension.ts` | Activation and the `codestoryline.show` command |
| `src/panel.ts` | The webview panel: caching, loading/error states, follow-up conversations per part, jump-to-lines and highlight |
| `src/storyline.ts` | Claude API calls: the storyline (prompt, tool schema, validation) and streamed follow-up answers |
| `src/store.ts` | Saved storylines with history: one JSON file per source file in the extension's global storage, the last 10 versions each, with the file text and the follow-up questions |
| `src/models.ts` | The model list and picker |
| `media/main.js` | Webview: card layout, code blocks, the arrows (plain SVG), canvas move and zoom, the ask panel |
| `src/webview/highlight.ts` | Syntax highlighting for the code blocks (Prism), bundled to `dist/highlight.js` for the webview |
| `media/main.css` | Webview styles and design tokens (light, dark, high contrast) |
| `esbuild.mjs` | Bundles the extension to `dist/extension.js` and the highlighter to `dist/highlight.js`, and copies the Inter font into `dist/` |

## Writing and design rules

- **Explanations use plain words.** Everything Claude writes follows one rule: explain it the way Richard Feynman would explain it to a curious friend. Short sentences, everyday words, no buzzwords; a part summary is one sentence of at most 20 words. The rule lives in the prompts at the top of `src/storyline.ts`. If you change a prompt, bump `PROMPT_VERSION` so saved storylines from the old prompt are marked out of date.
- **The UI is greyscale and always light**, after Levra: a flat grey stage, clean white cards, no dark mode. Colours, type, spacing and motion come from the tokens at the top of `media/main.css`. The only colour is the highlighted words in code blocks, all shades of one blue (`--code-accent`); the code field itself is grey. Don't add another hue: the two kinds of arrows differ by line style (solid for data, dashed for calls), not colour. Visible text is lowercase; errors are one grey line with at most one action.

## Useful scripts

| Command | Description |
| --- | --- |
| `npm run build` | Bundle once with esbuild |
| `npm run watch` | Rebuild on every change |
| `npm run typecheck` | Run the TypeScript compiler without emitting |
| `npm run compile` | Typecheck, then build |
| `npm run package` | Produce a `.vsix` with `vsce` |

To try a packaged build: `npm run package`, then `code --install-extension code-storyline-<version>.vsix`.

## Pull requests

- Keep changes focused, and describe what you changed and how you tested it.
- Run `npm run compile` before opening the PR; it must pass.
- For UI changes, include a screenshot or short recording of the storyline panel in both a light and a dark theme.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
