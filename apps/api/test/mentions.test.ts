import assert from "node:assert/strict";
import test from "node:test";
import { hasMention } from "../src/mentions";

test("finds a mention from WhatsApp's mention list or an @number in the text", () => {
  assert.equal(hasMention("تم", ["962790000000@s.whatsapp.net"]), true);
  assert.equal(hasMention("تم @962790000000", []), true);
  assert.equal(hasMention("تم @٩٦٢٧٩٠٠٠٠٠٠٠", null), true);
  assert.equal(hasMention("تم", []), false);
  assert.equal(hasMention("سعر 7 راكب", undefined), false);
  assert.equal(hasMention("email@test", [null, ""]), false);
});
