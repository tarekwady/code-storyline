import * as vscode from "vscode";

export const DEFAULT_MODEL = "claude-sonnet-5-5";

interface ModelOption {
  id: string;
  name: string;
  /** Short lowercase name for the bar */
  label: string;
  /** One plain sentence on when to pick it */
  detail: string;
  /** Rough cost of one storyline for a ~300-line file */
  cost: string;
}

/** Cheapest first. Prices from Anthropic's price list, per million tokens read / written. */
const MODELS: ModelOption[] = [
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    label: "haiku 4.5",
    detail: "Fastest and cheapest. Fine for short, simple files.",
    cost: "about 1¢ · $1 / $5",
  },
  {
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    label: "sonnet 5.5",
    detail: "The default. Newer and cheaper than Sonnet 4.5, a good everyday choice.",
    cost: "about 2¢ · $2 / $10",
  },
  {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    label: "sonnet 4.5",
    detail: "The older Sonnet. Quick and clear.",
    cost: "about 3¢ · $3 / $15",
  },
  {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    label: "opus 5.5",
    detail: "Reads long or tricky files more carefully. Slower.",
    cost: "about 5¢ · $4 / $20",
  },
  {
    id: "claude-fable-5-1",
    name: "Claude Fable 5.1",
    label: "fable 5.1",
    detail: "Anthropic's most capable model. The slowest and most expensive.",
    cost: "10¢ or more · $10 / $50",
  },
];

/**
 * Newer models can decline a request in some safety categories. On these, the API is asked to
 * retry a declined request on Anthropic's recommended fallback model instead of giving up.
 */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

export function supportsFallback(model: string): boolean {
  return FALLBACK_MODELS.has(model);
}

export function currentModel(): string {
  return vscode.workspace.getConfiguration("codestoryline").get<string>("model") || DEFAULT_MODEL;
}

export function modelInfo(id: string): { label: string; name: string } {
  const known = MODELS.find((m) => m.id === id);
  return known ? { label: known.label, name: known.name } : { label: id, name: id };
}

/** Shows the model list and saves the choice. Returns the new model id, or undefined if nothing changed. */
export async function chooseModel(): Promise<string | undefined> {
  const current = currentModel();
  type Item = vscode.QuickPickItem & { id?: string };
  const items: Item[] = MODELS.map((m) => ({
    id: m.id,
    label: m.id === current ? `$(check) ${m.name}` : m.name,
    description: m.cost,
    detail: m.detail,
  }));
  if (!MODELS.some((m) => m.id === current)) {
    items.unshift({ id: current, label: `$(check) ${current}`, description: "your own model id" });
  }
  items.push({ label: "", kind: vscode.QuickPickItemKind.Separator }, { label: "$(edit) Type another model id…" });

  const picked = await vscode.window.showQuickPick(items, {
    title: "Which Claude model should explain your code?",
    placeHolder: "Costs are rough, for one storyline of a 300-line file · prices per million tokens read / written",
    matchOnDetail: true,
  });
  if (!picked) return undefined;

  let id = picked.id;
  if (!id) {
    id = (
      await vscode.window.showInputBox({
        title: "Claude model id",
        prompt: "Any model id from Anthropic's model list, for example claude-sonnet-5-5",
        value: current,
        validateInput: (v) => (/^[A-Za-z0-9][A-Za-z0-9._@:-]*$/.test(v.trim()) ? undefined : "Use the model id, like claude-sonnet-5-5"),
      })
    )?.trim();
    if (!id) return undefined;
  }
  if (id === current) return undefined;

  await vscode.workspace.getConfiguration("codestoryline").update("model", id, vscode.ConfigurationTarget.Global);
  return id;
}
