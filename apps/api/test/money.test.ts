import assert from "node:assert/strict";
import test from "node:test";
import { hasSufficientCaptainReplyBalance } from "../src/money";

test("requires at least 0.75 JOD in addition to enough balance for the commission", () => {
  assert.equal(hasSufficientCaptainReplyBalance(749, 500), false);
  assert.equal(hasSufficientCaptainReplyBalance(750, 500), true);
  assert.equal(hasSufficientCaptainReplyBalance(999, 1000), false);
  assert.equal(hasSufficientCaptainReplyBalance(1000, 1000), true);
});
