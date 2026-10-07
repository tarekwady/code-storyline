import assert from "node:assert/strict";
import { test } from "node:test";
import { modelInfo, supportsFallback } from "../src/models";
import { capitalize, when } from "../src/time";

const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const now = at(2026, 10, 7, 14, 30);

test("times read short and relative", () => {
  assert.equal(when(now - 20_000, now), "just now");
  assert.equal(when(now - 5 * 60_000, now), "5 min ago");
  assert.match(when(at(2026, 10, 7, 9, 5), now), /^today \S/);
  assert.match(when(at(2026, 10, 6, 22, 0), now), /^yesterday \S/);
  assert.equal(when(at(2026, 10, 3, 12, 0), now), "4 days ago");
  // Older than a week: a date in the reader's locale, with the year only when it differs.
  assert.doesNotMatch(when(at(2026, 9, 1, 12, 0), now), /2026/);
  assert.match(when(at(2025, 9, 1, 12, 0), now), /2025/);
});

test("capitalize only touches the first letter", () => {
  assert.equal(capitalize("today 10:42"), "Today 10:42");
  assert.equal(capitalize(""), "");
});

test("known models get a short name; unknown ids are shown as they are", () => {
  assert.deepEqual(modelInfo("claude-sonnet-5-5"), { label: "sonnet 5.5", name: "Claude Sonnet 5.5" });
  assert.deepEqual(modelInfo("my-custom-model"), { label: "my-custom-model", name: "my-custom-model" });
});

test("server-side fallback is only requested where the model supports it", () => {
  assert.equal(supportsFallback("claude-sonnet-5-5"), true);
  assert.equal(supportsFallback("claude-opus-5-5"), true);
  assert.equal(supportsFallback("claude-sonnet-4-5"), false);
  assert.equal(supportsFallback("claude-haiku-4-5"), false);
});
