import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeStoryline, StorylineError } from "../src/storyline";

test("renumbers parts 1..n and remaps their connections", () => {
  const story = normalizeStoryline(
    {
      blocks: [
        { id: 10, title: "a", explanation: "x", startLine: 1, endLine: 2, connections: [] },
        { id: 20, title: "b", explanation: "y", startLine: 3, endLine: 4, connections: [{ from: 10, kind: "call", reason: "runs a" }] },
      ],
    },
    10,
  );
  assert.deepEqual(
    story.blocks.map((b) => b.id),
    [1, 2],
  );
  assert.deepEqual(story.blocks[1].connections, [{ from: 1, kind: "call", reason: "runs a" }]);
});

test("drops connections that point forward, to itself, nowhere, or twice", () => {
  const story = normalizeStoryline(
    {
      blocks: [
        { id: 1, title: "a", explanation: "", startLine: 1, endLine: 1, connections: [{ from: 2, kind: "data", reason: "forward" }] },
        {
          id: 2,
          title: "b",
          explanation: "",
          startLine: 2,
          endLine: 2,
          connections: [
            { from: 2, kind: "data", reason: "itself" },
            { from: 99, kind: "data", reason: "nowhere" },
            { from: 1, kind: "data", reason: "first" },
            { from: 1, kind: "call", reason: "twice" },
          ],
        },
      ],
    },
    10,
  );
  assert.deepEqual(story.blocks[0].connections, []);
  assert.deepEqual(story.blocks[1].connections, [{ from: 1, kind: "data", reason: "first" }]);
});

test("clamps line ranges to the file and puts reversed ranges in order", () => {
  const story = normalizeStoryline(
    {
      blocks: [
        { id: 1, title: "a", explanation: "", startLine: -5, endLine: 500, connections: [] },
        { id: 2, title: "b", explanation: "", startLine: 9, endLine: 4, connections: [] },
      ],
    },
    20,
  );
  assert.deepEqual([story.blocks[0].startLine, story.blocks[0].endLine], [1, 20]);
  assert.deepEqual([story.blocks[1].startLine, story.blocks[1].endLine], [4, 9]);
});

test("fills in what's missing and treats unknown kinds as data", () => {
  const story = normalizeStoryline(
    { blocks: [{ startLine: 1, endLine: 1 }, { startLine: 2, endLine: 2, connections: [{ from: undefined }, { from: 1, kind: "?" }] }] },
    5,
  );
  assert.equal(story.blocks[0].title, "part 1");
  assert.equal(story.blocks[0].explanation, "");
  assert.deepEqual(story.blocks[0].connections, []);
  assert.deepEqual(story.blocks[1].connections, [{ from: 1, kind: "data", reason: "" }]);
});

test("refuses an empty storyline", () => {
  assert.throws(() => normalizeStoryline({ blocks: [] }, 10), StorylineError);
  assert.throws(() => normalizeStoryline(undefined, 10), StorylineError);
});
