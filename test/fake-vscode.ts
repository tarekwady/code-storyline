// A small stand-in for the parts of the `vscode` API the tested modules touch, so tests run in plain Node.
// test/run.mjs points every `import "vscode"` at this file.
import * as fs from "node:fs";
import * as path from "node:path";

export interface FakeUri {
  fsPath: string;
  toString(): string;
}

const uri = (p: string): FakeUri => ({ fsPath: p, toString: () => `file:///${p.split(path.sep).join("/")}` });

export const Uri = {
  file: uri,
  joinPath: (base: FakeUri, ...parts: string[]) => uri(path.join(base.fsPath, ...parts)),
};

export const workspace = {
  fs: {
    createDirectory: async (u: FakeUri) => void fs.mkdirSync(u.fsPath, { recursive: true }),
    writeFile: async (u: FakeUri, bytes: Uint8Array) => fs.writeFileSync(u.fsPath, bytes),
    readFile: async (u: FakeUri) => fs.readFileSync(u.fsPath),
    delete: async (u: FakeUri) => fs.rmSync(u.fsPath),
  },
  getConfiguration: () => ({ get: () => undefined, inspect: () => undefined, update: async () => {} }),
};

export const window = {};
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
