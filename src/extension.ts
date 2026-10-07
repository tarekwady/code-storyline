import * as vscode from "vscode";
import { ApiKeys } from "./apiKey";
import { StorylinePanel } from "./panel";
import { StorylineStore } from "./store";

export function activate(context: vscode.ExtensionContext): void {
  const store = new StorylineStore(context.globalStorageUri);
  const keys = new ApiKeys(context.secrets);
  void keys.moveFromSettings();
  void removeOldCache(context.globalState);

  context.subscriptions.push(
    vscode.commands.registerCommand("codestoryline.show", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showInformationMessage("Open a file first, then run Show Code Storyline.");
        return;
      }
      StorylinePanel.show(context, store, keys, editor);
    }),
    vscode.commands.registerCommand("codestoryline.chooseModel", () => StorylinePanel.chooseModel()),
    vscode.commands.registerCommand("codestoryline.regenerate", () => StorylinePanel.regenerate()),
    vscode.commands.registerCommand("codestoryline.history", () => StorylinePanel.history()),
    vscode.commands.registerCommand("codestoryline.setApiKey", () => StorylinePanel.setApiKey(keys)),
    vscode.commands.registerCommand("codestoryline.removeApiKey", () => keys.remove()),
  );
}

/** Storylines used to be cached in globalState without history. They now live in files; drop the old copies. */
async function removeOldCache(state: vscode.Memento): Promise<void> {
  const index = state.get<string[]>("codestoryline.cacheIndex");
  if (!index) return;
  for (const key of index) await state.update(`codestoryline.cache.${key}`, undefined);
  await state.update("codestoryline.cacheIndex", undefined);
}

export function deactivate(): void {}
