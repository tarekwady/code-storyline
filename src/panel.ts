import * as path from "node:path";
import * as vscode from "vscode";
import type { ApiKeys } from "./apiKey";
import { chooseModel, currentModel, modelInfo } from "./models";
import { hashText, type StorylineStore, type Version } from "./store";
import { capitalize, when } from "./time";
import {
  askAboutBlock,
  generateStoryline,
  PROMPT_VERSION,
  StorylineError,
  type FileContext,
  type Storyline,
  type Turn,
} from "./storyline";

type Pending = { blockId: number; text: string };
/** What the webview offers next to a message: set the API key, choose a model, try again, or make a (new) storyline. */
type Action = "key" | "model" | "retry" | "make";
/** A line under the meta line when the storyline on screen no longer matches the file or settings. */
type Notice = { text: string; action: "update" } | null;

type ToWebview =
  | { type: "loading"; fileName: string }
  | {
      type: "storyline";
      fileName: string;
      languageId: string;
      storyline: Storyline;
      lines: string[];
      threads: Record<number, Turn[]>;
      pending: Pending | null;
      notice: Notice;
    }
  | { type: "notice"; notice: Notice }
  | { type: "error"; fileName?: string; message: string; action?: Action }
  | { type: "answer-delta"; blockId: number; text: string }
  | { type: "answer-done"; blockId: number; text: string }
  | { type: "answer-error"; blockId: number; question: string; message: string; action?: Action };

type FromWebview =
  | { type: "ready" }
  | { type: "regenerate" }
  | { type: "history" }
  | { type: "set-key" }
  | { type: "choose-model" }
  | { type: "reveal"; startLine: number; endLine: number; open: boolean }
  | { type: "unhighlight" }
  | { type: "copy"; text: string }
  | { type: "ask"; blockId: number; question: string };

/** The saved storyline on screen, and which file it belongs to. */
interface Shown {
  uri: vscode.Uri;
  fileName: string;
  languageId: string;
  version: Version;
}

/**
 * How a run decides what to show:
 * - "open": the saved storyline that best fits the file; make one only if the file has none.
 * - "model": a saved storyline from the chosen model for this exact text; otherwise make one.
 * - "regenerate": always make a new one (it joins the history).
 */
type RunMode = "open" | "model" | "regenerate";

export class StorylinePanel {
  private static current: StorylinePanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly highlight = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("editor.rangeHighlightBackground"),
    isWholeLine: true,
  });
  private documentUri: vscode.Uri | undefined;
  private sourceColumn = vscode.ViewColumn.One;
  private shown: Shown | undefined;
  /** A loading or error message to replay when the webview reloads; undefined while a storyline is shown. */
  private status: ToWebview | undefined;
  private generating: AbortController | undefined;
  private pending: (Pending & { versionId: string; controller: AbortController }) | undefined;

  static show(context: vscode.ExtensionContext, store: StorylineStore, keys: ApiKeys, editor: vscode.TextEditor): void {
    if (!StorylinePanel.current) {
      const panel = vscode.window.createWebviewPanel(
        "codestoryline",
        "storyline",
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        {
          enableScripts: true,
          localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, "media"),
            vscode.Uri.joinPath(context.extensionUri, "dist"),
          ],
        },
      );
      StorylinePanel.current = new StorylinePanel(panel, context, store, keys);
      void vscode.commands.executeCommand("setContext", "codestoryline.panelOpen", true);
    } else {
      StorylinePanel.current.panel.reveal(vscode.ViewColumn.Beside, true);
    }
    StorylinePanel.current.sourceColumn = editor.viewColumn ?? vscode.ViewColumn.One;
    void StorylinePanel.current.run(editor.document, "open");
  }

  /** The "Choose Model" command: same flow as the model button in the panel. */
  static async chooseModel(): Promise<void> {
    if (StorylinePanel.current) await StorylinePanel.current.pickModel();
    else await chooseModel();
  }

  /** The "Regenerate Storyline" command. */
  static async regenerate(): Promise<void> {
    const panel = StorylinePanel.current;
    if (panel?.documentUri) await panel.run(await vscode.workspace.openTextDocument(panel.documentUri), "regenerate");
  }

  /** The "Show History" command. */
  static async history(): Promise<void> {
    await StorylinePanel.current?.pickFromHistory();
  }

  /** The "Set API Key" command: if a storyline is waiting for a key, it carries on once one is saved. */
  static async setApiKey(keys: ApiKeys): Promise<void> {
    if (StorylinePanel.current) await StorylinePanel.current.askForKey();
    else await keys.set();
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly store: StorylineStore,
    private readonly keys: ApiKeys,
  ) {
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.svg");
    panel.webview.html = this.html();
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.webview.onDidReceiveMessage((msg: FromWebview) => this.onMessage(msg), null, this.disposables);
    vscode.workspace.onDidChangeConfiguration(
      (e) => {
        if (!e.affectsConfiguration("codestoryline.model")) return;
        this.postNotice();
      },
      null,
      this.disposables,
    );
    // Saving the file can make the storyline on screen out of date (or current again).
    vscode.workspace.onDidSaveTextDocument(
      (doc) => doc.uri.toString() === this.shown?.uri.toString() && this.postNotice(),
      null,
      this.disposables,
    );
  }

  private async onMessage(msg: FromWebview): Promise<void> {
    switch (msg.type) {
      case "ready":
        // The webview (re)loaded, e.g. after being hidden: replay the current state.
        if (this.status) void this.panel.webview.postMessage(this.status);
        else if (this.shown) this.postStoryline();
        break;
      case "regenerate":
        if (this.documentUri) await this.run(await vscode.workspace.openTextDocument(this.documentUri), "regenerate");
        break;
      case "history":
        await this.pickFromHistory();
        break;
      case "choose-model":
        await this.pickModel();
        break;
      case "set-key":
        await this.askForKey();
        break;
      case "reveal":
        await this.reveal(msg.startLine, msg.endLine, msg.open);
        break;
      case "unhighlight":
        for (const editor of this.editorsShowingFile()) editor.setDecorations(this.highlight, []);
        break;
      case "ask":
        await this.ask(msg.blockId, msg.question);
        break;
      case "copy":
        await vscode.env.clipboard.writeText(msg.text);
        break;
    }
  }

  /** Asks for the key; if the panel was stopped by a missing or rejected key, tries again with the new one. */
  private async askForKey(): Promise<void> {
    if (!(await this.keys.set())) return;
    const waiting = this.status?.type === "error" && this.status.action === "key";
    if (waiting && this.documentUri) await this.run(await vscode.workspace.openTextDocument(this.documentUri), "open");
  }

  /** Lets the person pick a model, then shows that model's storyline (a saved one when there is one). */
  private async pickModel(): Promise<void> {
    const model = await chooseModel();
    if (!model) return;
    if (this.documentUri) await this.run(await vscode.workspace.openTextDocument(this.documentUri), "model");
  }

  private async run(document: vscode.TextDocument, mode: RunMode): Promise<void> {
    this.generating?.abort();
    this.pending?.controller.abort();
    this.documentUri = document.uri;
    const fileName = path.basename(document.fileName);
    this.panel.title = `storyline · ${fileName}`;

    const model = currentModel();
    const text = document.getText();
    const hash = hashText(text);
    const saved = await this.store.versions(document.uri);
    const base = { uri: document.uri, fileName, languageId: document.languageId };

    if (mode !== "regenerate") {
      const exact = saved.find((v) => v.hash === hash && v.model === model && v.promptVersion === PROMPT_VERSION);
      if (exact) return this.show({ ...base, version: exact });
      // Opening a file never spends money on its own: show what was saved, with a note if it's out of date.
      const best = saved.find((v) => v.hash === hash) ?? saved[0];
      if (mode === "open" && best) return this.show({ ...base, version: best });
    }

    const apiKey = await this.keys.get();
    if (!apiKey) {
      this.setStatus({ type: "error", fileName, message: "Add your Anthropic API key to start.", action: "key" });
      return;
    }
    if (!text.trim()) {
      this.setStatus({ type: "error", fileName, message: "This file is empty, so there is no story to tell yet." });
      return;
    }

    const controller = new AbortController();
    this.generating = controller;
    this.setStatus({ type: "loading", fileName });
    try {
      const storyline = await generateStoryline({ apiKey, model, fileName, languageId: document.languageId, text }, controller.signal);
      const version = await this.store.add(document.uri, { model, promptVersion: PROMPT_VERSION, hash, text, storyline });
      if (this.generating === controller) this.show({ ...base, version });
    } catch (err) {
      if (this.generating === controller) {
        this.setStatus({
          type: "error",
          fileName,
          message: err instanceof Error ? err.message : String(err),
          action: err instanceof StorylineError ? err.action : "retry",
        });
      }
    } finally {
      if (this.generating === controller) this.generating = undefined;
    }
  }

  /** The history button: every saved storyline of this file, newest first. */
  private async pickFromHistory(): Promise<void> {
    if (!this.documentUri) return;
    const uri = this.documentUri;
    const document = await vscode.workspace.openTextDocument(uri);
    const fileName = path.basename(document.fileName);
    const hash = hashText(document.getText());
    const saved = await this.store.versions(uri);

    type Item = vscode.QuickPickItem & { version?: Version; clear?: true };
    const items: Item[] = saved.map((v) => {
      const questions = Object.values(v.threads).reduce((n, t) => n + t.filter((turn) => turn.role === "user").length, 0);
      return {
        version: v,
        label: `${v.id === this.shown?.version.id ? "$(check) " : ""}${capitalize(when(v.createdAt))}`,
        description: modelInfo(v.model).name,
        detail: [
          `${v.storyline.blocks.length} parts`,
          questions ? `${questions} question${questions === 1 ? "" : "s"}` : "",
          v.hash === hash ? "matches the file now" : "the file has changed since",
        ]
          .filter(Boolean)
          .join(" · "),
      };
    });
    if (saved.length) {
      items.push({ label: "", kind: vscode.QuickPickItemKind.Separator }, { label: "$(trash) Delete this file's history", clear: true });
    }

    const picked = await vscode.window.showQuickPick(items, {
      title: `Storylines of ${fileName}`,
      placeHolder: saved.length ? "Newest first. Pick one to show it." : "No saved storylines for this file yet.",
    });
    if (!picked) return;

    if (picked.clear) {
      const answer = await vscode.window.showWarningMessage(
        `Delete all ${saved.length} saved storylines of ${fileName}, with their questions and answers?`,
        { modal: true },
        "Delete",
      );
      if (answer !== "Delete") return;
      this.pending?.controller.abort();
      await this.store.clear(uri);
      this.setStatus({ type: "error", fileName, message: "History deleted for this file.", action: "make" });
      return;
    }
    if (picked.version) this.show({ uri, fileName, languageId: document.languageId, version: picked.version });
  }

  private async ask(blockId: number, question: string): Promise<void> {
    const shown = this.shown;
    const block = shown?.version.storyline.blocks.find((b) => b.id === blockId);
    question = question.trim();
    if (!shown || !block || !question || this.pending) return;

    const apiKey = await this.keys.get();
    if (!apiKey) {
      this.post({ type: "answer-error", blockId, question, message: "Add your Anthropic API key first.", action: "key" });
      return;
    }

    const version = shown.version;
    const thread = (version.threads[blockId] ??= []);
    const history = [...thread];
    thread.push({ role: "user", text: question });
    const controller = new AbortController();
    const pending = { versionId: version.id, blockId, text: "", controller };
    this.pending = pending;
    const isShown = () => this.shown?.version.id === pending.versionId;

    // Questions are about the exact text this storyline was made from, answered by the chosen model.
    const file: FileContext = { apiKey, model: currentModel(), fileName: shown.fileName, languageId: shown.languageId, text: version.text };
    try {
      const answer = await askAboutBlock({
        file,
        block,
        history,
        question,
        signal: controller.signal,
        onText: (delta) => {
          pending.text += delta;
          if (isShown()) this.post({ type: "answer-delta", blockId, text: delta });
        },
      });
      const text = answer || pending.text;
      thread.push({ role: "assistant", text });
      await this.store.save(shown.uri);
      if (isShown()) this.post({ type: "answer-done", blockId, text });
    } catch (err) {
      // Drop the unanswered question so the conversation sent to Claude stays question, answer, question, answer.
      thread.pop();
      if (isShown() && !controller.signal.aborted) {
        this.post({
          type: "answer-error",
          blockId,
          question,
          message: err instanceof Error ? err.message : String(err),
          action: err instanceof StorylineError ? err.action : "retry",
        });
      }
    } finally {
      if (this.pending === pending) this.pending = undefined;
    }
  }

  private show(shown: Shown): void {
    this.shown = shown;
    this.status = undefined;
    this.postStoryline();
  }

  private async postStoryline(): Promise<void> {
    const shown = this.shown!;
    const { version } = shown;
    const pending = this.pending?.versionId === version.id ? { blockId: this.pending.blockId, text: this.pending.text } : null;
    this.post({
      type: "storyline",
      fileName: shown.fileName,
      languageId: shown.languageId,
      storyline: version.storyline,
      lines: version.text.split(/\r?\n/),
      threads: version.threads,
      pending,
      notice: this.notice(),
    });
  }

  private postNotice(): void {
    if (this.shown) this.post({ type: "notice", notice: this.notice() });
  }

  /** Says why the storyline on screen may be out of date: the file changed, another model, or an older prompt. */
  private notice(): Notice {
    const shown = this.shown;
    if (!shown) return null;
    const { version } = shown;
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === shown.uri.toString());
    if (doc && hashText(doc.getText()) !== version.hash) {
      return { text: "the file changed since this storyline was made, so some lines may have moved.", action: "update" };
    }
    if (version.model !== currentModel()) {
      return { text: `made with ${modelInfo(version.model).label}, not ${modelInfo(currentModel()).label}.`, action: "update" };
    }
    if (version.promptVersion !== PROMPT_VERSION) {
      return { text: "made by an older version of code storyline.", action: "update" };
    }
    return null;
  }

  private setStatus(msg: ToWebview): void {
    this.status = msg;
    this.shown = undefined;
    this.post(msg);
  }

  private editorsShowingFile(): vscode.TextEditor[] {
    const uri = this.documentUri?.toString();
    return uri ? vscode.window.visibleTextEditors.filter((e) => e.document.uri.toString() === uri) : [];
  }

  /**
   * Highlights a part's lines. Selecting a part only touches an editor where the file is already
   * visible; `open` (the panel's "show in code") brings the file up, opening it if needed.
   */
  private async reveal(startLine: number, endLine: number, open: boolean): Promise<void> {
    if (!this.documentUri) return;
    // Prefer the editor the file is already open in, so we don't open a duplicate.
    const visible = this.editorsShowingFile()[0];
    if (!visible && !open) return;
    const doc = visible?.document ?? (await vscode.workspace.openTextDocument(this.documentUri));
    const editor = open
      ? await vscode.window.showTextDocument(doc, { viewColumn: visible?.viewColumn ?? this.sourceColumn })
      : visible;

    const start = Math.min(Math.max(0, startLine - 1), doc.lineCount - 1);
    const end = Math.min(Math.max(start, endLine - 1), doc.lineCount - 1);
    const range = new vscode.Range(start, 0, end, doc.lineAt(end).text.length);

    if (open) editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    editor.setDecorations(this.highlight, [range]);
  }

  private post(msg: ToWebview): void {
    void this.panel.webview.postMessage(msg);
  }

  private html(): string {
    const webview = this.panel.webview;
    const asset = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, ...p));
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join("");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${asset("media", "main.css")}" />
  <title>storyline</title>
</head>
<body>
  <header class="bar">
    <h1 id="file" class="bar-title">storyline</h1>
    <p id="notice" class="bar-notice" hidden></p>
  </header>

  <div class="workspace">
  <main id="stage" class="stage">
    <div id="state" class="state">
      <p class="state-line">open a file, then run show code storyline.</p>
    </div>
    <div id="board" class="board" hidden>
      <svg id="arrows" class="arrows" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"></svg>
    </div>
  </main>

  <aside id="ask" class="ask" aria-label="Ask about this part" aria-hidden="true" inert>
    <header class="ask-head">
      <p id="ask-label" class="label"></p>
      <div class="ask-actions">
        <button id="ask-open" class="ghost" type="button" title="Open the file at these lines">show in code</button>
        <button id="ask-close" class="ghost" type="button">close</button>
      </div>
    </header>
    <div id="ask-scroll" class="ask-scroll">
      <h2 id="ask-title" class="ask-title"></h2>
      <p id="ask-text" class="ask-text"></p>
      <div id="ask-links" class="ask-links"></div>
      <div id="ask-thread" class="thread" aria-live="polite"></div>
    </div>
    <footer class="ask-foot">
      <div id="ask-chips" class="chips"></div>
      <form id="ask-form" class="composer">
        <label class="visually-hidden" for="question">Your question</label>
        <textarea id="question" rows="1" placeholder="ask about this part…"></textarea>
        <button id="send" class="send" type="submit" aria-label="Send question">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
        </button>
      </form>
    </footer>
  </aside>
  </div>

  <script nonce="${nonce}" src="${asset("dist", "highlight.js")}"></script>
  <script nonce="${nonce}" src="${asset("media", "main.js")}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    StorylinePanel.current = undefined;
    void vscode.commands.executeCommand("setContext", "codestoryline.panelOpen", false);
    this.generating?.abort();
    this.pending?.controller.abort();
    this.highlight.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}
