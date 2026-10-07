import * as vscode from "vscode";

const SECRET = "codestoryline.apiKey";

/**
 * The Anthropic API key lives in VS Code's encrypted secret storage, never in settings.json
 * (which is plain text and may be synced). ANTHROPIC_API_KEY is the fallback.
 */
export class ApiKeys {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async get(): Promise<string> {
    return (await this.secrets.get(SECRET)) || process.env.ANTHROPIC_API_KEY || "";
  }

  /** Asks for the key in a hidden input box. Returns true when a key was saved. */
  async set(): Promise<boolean> {
    const key = (
      await vscode.window.showInputBox({
        title: "Anthropic API key",
        prompt: "Paste your key from console.anthropic.com. It's kept in VS Code's encrypted storage on this computer, not in your settings.",
        placeHolder: "sk-ant-…",
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) =>
          value.trim() && !value.trim().startsWith("sk-ant-")
            ? { message: "Anthropic API keys usually start with sk-ant-", severity: vscode.InputBoxValidationSeverity.Warning }
            : undefined,
      })
    )?.trim();
    if (!key) return false;
    await this.secrets.store(SECRET, key);
    void vscode.window.showInformationMessage("Your Anthropic API key is saved in VS Code's encrypted storage.");
    return true;
  }

  async remove(): Promise<void> {
    await this.secrets.delete(SECRET);
    void vscode.window.showInformationMessage("Your Anthropic API key was removed from code storyline.");
  }

  /** Keys used to live in the plain-text codestoryline.apiKey setting: move one found there into secret storage. */
  async moveFromSettings(): Promise<void> {
    const config = vscode.workspace.getConfiguration("codestoryline");
    const found = config.inspect<string>("apiKey");
    const old = found?.globalValue || found?.workspaceValue || found?.workspaceFolderValue;
    if (!old) return;
    if (!(await this.secrets.get(SECRET))) await this.secrets.store(SECRET, old);
    const targets: [unknown, vscode.ConfigurationTarget][] = [
      [found?.globalValue, vscode.ConfigurationTarget.Global],
      [found?.workspaceValue, vscode.ConfigurationTarget.Workspace],
      [found?.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder],
    ];
    for (const [value, target] of targets) {
      if (!value) continue;
      try {
        await config.update("apiKey", undefined, target);
      } catch {
        // No workspace (folder) open for that target; nothing to clear there.
      }
    }
    void vscode.window.showInformationMessage(
      "Code storyline moved your Anthropic API key from settings.json to VS Code's encrypted storage.",
    );
  }
}
