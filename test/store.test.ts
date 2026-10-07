import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import * as vscode from "vscode";
import { hashText, StorylineStore } from "../src/store";

const dir = mkdtempSync(join(tmpdir(), "storyline-store-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const root = vscode.Uri.file(dir);
const made = (n: number) => ({
  model: "claude-sonnet-5-5",
  promptVersion: 2,
  hash: hashText(`v${n}`),
  text: `v${n}`,
  storyline: { blocks: [{ id: 1, title: `t${n}`, explanation: "", startLine: 1, endLine: 1, connections: [] }] },
});

test("keeps the newest 10 storylines per file, newest first", async () => {
  const file = vscode.Uri.file("C:/project/a.ts");
  const store = new StorylineStore(root);
  assert.deepEqual(await store.versions(file), []);
  for (let n = 1; n <= 12; n++) await store.add(file, made(n));
  const versions = await store.versions(file);
  assert.equal(versions.length, 10);
  assert.equal(versions[0].text, "v12");
  assert.equal(versions[9].text, "v3");
});

test("history and questions survive a restart", async () => {
  const file = vscode.Uri.file("C:/project/b.ts");
  const store = new StorylineStore(root);
  const version = await store.add(file, made(1));
  version.threads[1] = [
    { role: "user", text: "why?" },
    { role: "assistant", text: "because." },
  ];
  await store.save(file);

  const reopened = await new StorylineStore(root).versions(file);
  assert.equal(reopened.length, 1);
  assert.equal(reopened[0].id, version.id);
  assert.equal(reopened[0].threads[1][1].text, "because.");
});

test("files are kept apart, and clearing one leaves the others", async () => {
  const one = vscode.Uri.file("C:/project/c.ts");
  const two = vscode.Uri.file("C:/project/d.ts");
  const store = new StorylineStore(root);
  await store.add(one, made(1));
  await store.add(two, made(2));
  await store.clear(one);

  const reopened = new StorylineStore(root);
  assert.equal((await reopened.versions(one)).length, 0);
  assert.equal((await reopened.versions(two)).length, 1);
});

test("hashText tells texts apart", () => {
  assert.equal(hashText("a"), hashText("a"));
  assert.notEqual(hashText("a"), hashText("a "));
});
