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

test("charges only complete five-dinar units for each listed price", () => {
  assert.equal(calculateCommissionFils([5], 750), 750);
  assert.equal(calculateCommissionFils([6], 750), 750);
  assert.equal(calculateCommissionFils([7], 750), 750);
  assert.equal(calculateCommissionFils([9], 750), 750);
  assert.equal(calculateCommissionFils([10], 750), 1500);
  assert.equal(calculateCommissionFils([6, 7], 750), 1500);
});
