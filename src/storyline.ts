import Anthropic from "@anthropic-ai/sdk";
import { supportsFallback } from "./models";

type Message = Anthropic.Beta.Messages.BetaMessage;
type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;

export type ConnectionKind = "data" | "call";

export interface Connection {
  /** id of an earlier block that feeds into this one */
  from: number;
  kind: ConnectionKind;
  reason: string;
}

export interface StoryBlock {
  id: number;
  title: string;
  explanation: string;
  /** 1-based, inclusive */
  startLine: number;
  /** 1-based, inclusive */
  endLine: number;
  connections: Connection[];
}

export interface Storyline {
  blocks: StoryBlock[];
}

export interface Turn {
  role: "user" | "assistant";
  text: string;
}

/** Bump when the prompt changes, so cached storylines from the old prompt are not reused. */
export const PROMPT_VERSION = 2;

const TOOL_NAME = "emit_storyline";

// The plain-language rules shared by the storyline and the follow-up answers.
const PLAIN_WORDS = `How to write:
- Explain it the way Richard Feynman would explain it to a curious friend: plain words a beginner knows, short sentences, concrete over abstract. Say what actually happens.
- No buzzwords or filler. Avoid words like leverage, utilize, robust, seamless, orchestrate, encapsulate, facilitate, instantiate, abstraction, paradigm, mechanism, functionality, and a vague "handles" or "logic".
- If a technical word is unavoidable, use it once and let the sentence make its meaning clear.`;

const STORYLINE_PROMPT = `You help people understand a code file by telling its story in plain words.

Split the file into an ordered list of parts, in the order a reader should meet them (usually top to bottom). A part is one step of the story: getting set up, a piece of data, a helper, the main job, and so on. Use 3 to 10 parts; merge small neighbours instead of listing every line.

For each part give:
- title: 2 to 5 everyday words, lowercase, saying what it does ("reads the settings", "turns rows into a list"). Use a code name only when there is no plain way to say it.
- explanation: one short sentence, at most 20 words, saying what this part does and why the file needs it. Don't repeat the title.
- startLine and endLine: 1-based, inclusive, using the line numbers shown in the file.
- connections: the earlier parts this one depends on. kind "data" when it uses something made there (a value, a setting, a type); kind "call" when it runs code from there. reason: at most 8 plain words.

${PLAIN_WORDS}

Connections may only point to parts with a smaller id. Return the result by calling the ${TOOL_NAME} tool exactly once.`;

const ASK_PROMPT = `You help someone understand one part of a code file. They have already read a one-sentence summary of that part and now have a question.

${PLAIN_WORDS}
- Answer the question directly in your first sentence.
- Keep it short: usually 2 to 5 sentences. Go longer only when they ask you to go deeper, and even then stay plain.
- When they ask for it simpler, use fewer and easier words, not more words.
- A small everyday comparison is welcome when it really helps; skip it when it doesn't.
- Point at the real code: quote short pieces in \`backticks\` and mention line numbers.
- Only say what the file shows. If the answer depends on code outside this file, say so plainly.
- No headings. Use a short numbered list only for steps that happen in order.`;

const STORYLINE_TOOL: Anthropic.Beta.Messages.BetaTool = {
  name: TOOL_NAME,
  description: "Return the storyline of the file as an ordered list of parts.",
  input_schema: {
    type: "object",
    properties: {
      blocks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "integer", description: "1-based position in the story" },
            title: { type: "string", description: "2 to 5 everyday words, lowercase" },
            explanation: { type: "string", description: "One plain sentence, at most 20 words" },
            startLine: { type: "integer" },
            endLine: { type: "integer" },
            connections: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  from: { type: "integer", description: "id of an earlier part" },
                  kind: { type: "string", enum: ["data", "call"] },
                  reason: { type: "string", description: "At most 8 plain words" },
                },
                required: ["from", "kind", "reason"],
              },
            },
          },
          required: ["id", "title", "explanation", "startLine", "endLine", "connections"],
        },
      },
    },
    required: ["blocks"],
  },
};

/** What the webview should offer next to an error message. */
export type ErrorAction = "settings" | "retry";

export class StorylineError extends Error {
  constructor(
    message: string,
    readonly action: ErrorAction = "retry",
  ) {
    super(message);
  }
}

export interface FileContext {
  apiKey: string;
  model: string;
  fileName: string;
  languageId: string;
  text: string;
}

/**
 * Both calls go through the beta endpoint so that, on models that support it, a request declined by a
 * safety check is retried server-side on Anthropic's recommended fallback model instead of failing.
 */
function fallbackParams(model: string) {
  return supportsFallback(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {};
}

function numbered(text: string): { lines: string[]; numbered: string } {
  const lines = text.split(/\r?\n/);
  return { lines, numbered: lines.map((line, i) => `${i + 1}| ${line}`).join("\n") };
}

export async function generateStoryline(file: FileContext, signal?: AbortSignal): Promise<Storyline> {
  const client = new Anthropic({ apiKey: file.apiKey });
  const { lines, numbered: body } = numbered(file.text);

  let response: Message;
  try {
    // Streamed so long files and models that think first don't hit request timeouts.
    const stream = client.beta.messages.stream(
      {
        ...fallbackParams(file.model),
        model: file.model,
        max_tokens: 32000,
        system: STORYLINE_PROMPT,
        tools: [STORYLINE_TOOL],
        // "auto" rather than a forced tool choice: newer models reject forced tool use.
        tool_choice: { type: "auto" },
        messages: [
          {
            role: "user",
            content: `File: ${file.fileName} (language: ${file.languageId}, ${lines.length} lines)\n\n<file>\n${body}\n</file>\n\nCall ${TOOL_NAME} with the storyline.`,
          },
        ],
      },
      { signal },
    );
    response = await stream.finalMessage();
  } catch (err) {
    throw toStorylineError(err);
  }

  if (response.stop_reason === "refusal") {
    throw new StorylineError("Claude declined to read this file.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new StorylineError("This file is too long for one storyline. Try a smaller file.");
  }

  const toolUse = response.content.find(
    (b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use" && b.name === TOOL_NAME,
  );
  if (!toolUse) {
    throw new StorylineError("Claude didn't send a storyline back.");
  }
  return normalize(toolUse.input, lines.length);
}

/**
 * Answers a follow-up question about one block, streaming the text through onText.
 * `history` holds the earlier turns of this block's conversation; `question` is the new one.
 */
export async function askAboutBlock(opts: {
  file: FileContext;
  block: StoryBlock;
  history: Turn[];
  question: string;
  onText: (delta: string) => void;
  signal?: AbortSignal;
}): Promise<string> {
  const { file, block } = opts;
  const client = new Anthropic({ apiKey: file.apiKey });
  const { numbered: body } = numbered(file.text);

  // The first question carries which part it is about; later ones are plain follow-ups.
  const turns = [...opts.history, { role: "user" as const, text: opts.question }];
  const messages: MessageParam[] = turns.map((t, i) => ({
    role: t.role,
    content:
      i === 0
        ? `I'm looking at part ${block.id}, "${block.title}" (lines ${block.startLine}–${block.endLine}). Its summary: ${block.explanation}\n\nMy question: ${t.text}`
        : t.text,
  }));

  try {
    const stream = client.beta.messages.stream(
      {
        ...fallbackParams(file.model),
        model: file.model,
        max_tokens: 16000,
        system: [
          { type: "text", text: ASK_PROMPT },
          {
            type: "text",
            text: `The whole file, with line numbers:\n<file name="${file.fileName}" language="${file.languageId}">\n${body}\n</file>`,
            // Follow-ups resend the same file; caching it makes them cheaper and faster.
            cache_control: { type: "ephemeral" },
          },
        ],
        messages,
      },
      { signal: opts.signal },
    );
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        opts.onText(event.delta.text);
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") {
      throw new StorylineError("Claude declined to answer this.");
    }
    return final.content
      .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  } catch (err) {
    throw err instanceof StorylineError ? err : toStorylineError(err);
  }
}

/** Defensive clean-up: the model output is untrusted shape-wise. */
function normalize(input: unknown, lineCount: number): Storyline {
  const raw = (input as { blocks?: unknown })?.blocks;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new StorylineError("Claude sent back an empty storyline.");
  }

  const clampLine = (n: unknown) => Math.min(Math.max(1, Math.round(Number(n) || 1)), Math.max(1, lineCount));

  // Re-number blocks 1..n in story order and remap connection ids accordingly.
  const idMap = new Map<number, number>();
  raw.forEach((b, i) => idMap.set(Number((b as StoryBlock).id), i + 1));

  const blocks: StoryBlock[] = raw.map((b: any, i) => {
    const id = i + 1;
    let startLine = clampLine(b.startLine);
    let endLine = clampLine(b.endLine);
    if (endLine < startLine) [startLine, endLine] = [endLine, startLine];

    const seen = new Set<number>();
    const connections: Connection[] = (Array.isArray(b.connections) ? b.connections : [])
      .map((c: any) => ({
        from: idMap.get(Number(c?.from)) ?? -1,
        kind: (c?.kind === "call" ? "call" : "data") as ConnectionKind,
        reason: String(c?.reason ?? "").trim(),
      }))
      .filter((c: Connection) => c.from >= 1 && c.from < id && !seen.has(c.from) && seen.add(c.from));

    return {
      id,
      title: String(b.title ?? `part ${id}`).trim(),
      explanation: String(b.explanation ?? "").trim(),
      startLine,
      endLine,
      connections,
    };
  });

  return { blocks };
}

function toStorylineError(err: unknown): Error {
  if (err instanceof Anthropic.AuthenticationError) {
    return new StorylineError("Your Anthropic API key was rejected.", "settings");
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new StorylineError("That Claude model wasn't found. Check the model setting.", "settings");
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new StorylineError("Too many requests right now. Wait a moment, then try again.");
  }
  if (err instanceof Anthropic.APIUserAbortError) {
    return new StorylineError("Stopped.");
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new StorylineError("Couldn't reach Claude. Check your internet connection.");
  }
  if (err instanceof Anthropic.APIError) {
    return new StorylineError(`Claude returned an error (${err.status ?? "unknown"}): ${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}
