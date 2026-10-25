import assert from "node:assert/strict";
import test from "node:test";
import { isCancellationReaction } from "../src/reactions";

test("recognizes common WhatsApp cancellation reactions", () => {
  for (const reaction of ["❌", "✖️", "✕", "❎", "X", "x"]) {
    assert.equal(isCancellationReaction(reaction), true);
  }
});

test("does not treat unrelated reactions as cancellation", () => {
  for (const reaction of [undefined, "", "👍", "✅", "cancel"]) {
    assert.equal(isCancellationReaction(reaction), false);
  }
});

test("recognizes a like in every skin tone", async () => {
  const { isLikeReaction } = await import("../src/reactions");
  for (const like of ["👍", "👍️", "👍🏻", "👍🏼", "👍🏽", "👍🏾", "👍🏿"]) assert.equal(isLikeReaction(like), true, like);
  for (const other of ["", "❤️", "👎", "👍👍"]) assert.equal(isLikeReaction(other), false, other);
});
