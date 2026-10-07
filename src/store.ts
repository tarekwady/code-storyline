import { createHash } from "node:crypto";
import * as vscode from "vscode";
import type { Storyline, Turn } from "./storyline";

/** One storyline as it was made: the exact file text, the result, and the questions asked about it. */
export interface Version {
  id: string;
  createdAt: number;
  model: string;
  promptVersion: number;
  /** sha256 of `text` */
  hash: string;
  text: string;
  storyline: Storyline;
  /** Follow-up conversations, per block id */
  threads: Record<number, Turn[]>;
}

interface FileRecord {
  v: 1;
  uri: string;
  /** Newest first */
  versions: Version[];
}

/** How many storylines each file keeps. The oldest is dropped when a new one is made. */
const MAX_VERSIONS = 10;

export const hashText = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * Saved storylines with their history: one JSON file per source file in the extension's private
 * global storage, so they survive restarts and never touch the user's project.
 */
export class StorylineStore {
  private readonly dir: vscode.Uri;
  private readonly records = new Map<string, FileRecord>();

  constructor(storage: vscode.Uri) {
    this.dir = vscode.Uri.joinPath(storage, "storylines");
  }

  async versions(uri: vscode.Uri): Promise<Version[]> {
    return (await this.load(uri)).versions;
  }

  async add(uri: vscode.Uri, made: Omit<Version, "id" | "createdAt" | "threads">): Promise<Version> {
    const record = await this.load(uri);
    const version: Version = { ...made, id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, createdAt: Date.now(), threads: {} };
    record.versions.unshift(version);
    record.versions.length = Math.min(record.versions.length, MAX_VERSIONS);
    await this.save(uri);
    return version;
  }

  /** Writes the file's record after a version changed in place (a new question and answer). */
  async save(uri: vscode.Uri): Promise<void> {
    const record = this.records.get(uri.toString());
    if (!record) return;
    await vscode.workspace.fs.createDirectory(this.dir);
    await vscode.workspace.fs.writeFile(this.fileFor(uri), new TextEncoder().encode(JSON.stringify(record)));
  }

  async clear(uri: vscode.Uri): Promise<void> {
    this.records.set(uri.toString(), { v: 1, uri: uri.toString(), versions: [] });
    try {
      await vscode.workspace.fs.delete(this.fileFor(uri));
    } catch {
      // Nothing saved yet.
    }
  }

  private fileFor(uri: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(this.dir, `${createHash("sha256").update(uri.toString()).digest("hex").slice(0, 32)}.json`);
  }

  private async load(uri: vscode.Uri): Promise<FileRecord> {
    const key = uri.toString();
    const known = this.records.get(key);
    if (known) return known;
    let record: FileRecord = { v: 1, uri: key, versions: [] };
    try {
      const saved = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(this.fileFor(uri))));
      if (saved?.v === 1 && Array.isArray(saved.versions)) record = saved;
    } catch {
      // Nothing saved for this file yet, or the file is unreadable: start fresh.
    }
    this.records.set(key, record);
    return record;
  }
}
