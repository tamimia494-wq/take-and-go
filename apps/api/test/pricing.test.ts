import assert from "node:assert/strict";
import test from "node:test";
import { calculateCommissionFils, extractPriceAfterLabel } from "../src/pricing";

test("extracts the amount following supported Arabic price labels", () => {
  assert.equal(extractPriceAfterLabel("سعر 25 راكب"), 25);
  assert.equal(extractPriceAfterLabel("السعر: ٧ أوردر"), 7);
  assert.equal(extractPriceAfterLabel("مطلوب توصيل، سعر: ۱۲"), 12);
  assert.equal(extractPriceAfterLabel("أجرة 15"), 15);
  assert.equal(extractPriceAfterLabel("اجاره: ١٠"), 10);
  assert.equal(extractPriceAfterLabel("التوصيل ٢٠"), 20);
  assert.equal(extractPriceAfterLabel("حسابه: ٥"), 5);
  assert.equal(extractPriceAfterLabel("راكب 25 د.أ"), null);
  assert.equal(extractPriceAfterLabel("سعر 0"), null);
});

test("reads توصيل exactly like سعر, with attached letters and separators", () => {
  for (const label of ["سعر", "توصيل", "أجرة"]) {
    assert.equal(extractPriceAfterLabel(`${label} 5`), 5, label);
    assert.equal(extractPriceAfterLabel(`و${label} 6`), 6, label);
    assert.equal(extractPriceAfterLabel(`بال${label} 7`), 7, label);
    assert.equal(extractPriceAfterLabel(`${label} بـ8`), 8, label);
    assert.equal(extractPriceAfterLabel(`${label}=9`), 9, label);
  }
  assert.equal(extractPriceAfterLabel("توصيله ١٠"), 10);
  assert.equal(extractPriceAfterLabel("سعر التوصيل 7"), 7);
  assert.equal(extractPriceAfterLabel("حساب 0797907580"), null);
  assert.equal(extractPriceAfterLabel("وصلت 5"), null);
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
