import assert from "node:assert/strict";
import test from "node:test";
import { hasSufficientCaptainReplyBalance, normalizePhone, phoneFromChatId } from "../src/money";

test("keeps 0.5 JOD reserved after the commission is taken", () => {
  assert.equal(hasSufficientCaptainReplyBalance(-1, 0), false);
  assert.equal(hasSufficientCaptainReplyBalance(500, 0), false);
  assert.equal(hasSufficientCaptainReplyBalance(501, 0), true);
  // 1 JOD with a 0.75 rider commission would leave 0.25, below the reserve.
  assert.equal(hasSufficientCaptainReplyBalance(1000, 750), false);
  assert.equal(hasSufficientCaptainReplyBalance(1249, 750), false);
  assert.equal(hasSufficientCaptainReplyBalance(1250, 750), true);
  assert.equal(hasSufficientCaptainReplyBalance(1499, 1000), false);
  assert.equal(hasSufficientCaptainReplyBalance(1500, 1000), true);
});

test("normalizes Jordanian phone numbers written in Arabic, Persian, or Western digits", () => {
  assert.equal(normalizePhone("0790139839"), "962790139839");
  assert.equal(normalizePhone("٠٧٩٠١٣٩٨٣٩"), "962790139839");
  assert.equal(normalizePhone("۰۷۹۰۱۳۹۸۳۹"), "962790139839");
  assert.equal(phoneFromChatId("٠٧٩٠١٣٩٨٣٩@s.whatsapp.net"), "962790139839");
});
