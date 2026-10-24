import assert from "node:assert/strict";
import test from "node:test";
import { calculateCommissionFils, extractPriceAfterLabel } from "../src/pricing";

test("extracts the amount immediately following the Arabic price label", () => {
  assert.equal(extractPriceAfterLabel("سعر 25 راكب"), 25);
  assert.equal(extractPriceAfterLabel("السعر: ٧ أوردر"), 7);
  assert.equal(extractPriceAfterLabel("مطلوب توصيل، سعر: ۱۲"), 12);
  assert.equal(extractPriceAfterLabel("راكب 25 د.أ"), null);
  assert.equal(extractPriceAfterLabel("سعر 0"), null);
});

test("rounds each listed price to the nearest five-dinar unit", () => {
  assert.equal(calculateCommissionFils([5], 750), 750);
  assert.equal(calculateCommissionFils([6], 750), 750);
  assert.equal(calculateCommissionFils([7], 750), 750);
  assert.equal(calculateCommissionFils([8], 750), 1500);
  assert.equal(calculateCommissionFils([9], 750), 1500);
  assert.equal(calculateCommissionFils([10], 750), 1500);
  assert.equal(calculateCommissionFils([12], 750), 1500);
  assert.equal(calculateCommissionFils([13], 750), 2250);
  assert.equal(calculateCommissionFils([6, 8], 750), 2250);
});
