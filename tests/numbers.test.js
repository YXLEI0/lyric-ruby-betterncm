/*
 * 数字的日语读音（core/numbers.js）。
 *
 * kuromoji 对阿拉伯数字不给读音（105 的 reading 是 *），所以这层得自己算；
 * 和助数词黏在一起时（1つ ひとつ）词典自己会给，这里不重复注。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { loadCore } = require("./helpers.js");

const ctx = loadCore("<!doctype html><html><body></body></html>", { reader: false, files: ["core/numbers.js"] });
const N = ctx.window.WKNumbers;

test("数字读音：基本读法", () => {
  assert.strictEqual(N.reading("1"), "イチ");
  assert.strictEqual(N.reading("10"), "ジュウ");
  assert.strictEqual(N.reading("39"), "サンジュウキュウ");
  assert.strictEqual(N.reading("105"), "ヒャクゴ");
  assert.strictEqual(N.reading("2020"), "ニセンニジュウ");
  assert.strictEqual(N.reading("1"), "イチ");
});

test("数字读音：连浊 / 促音", () => {
  assert.strictEqual(N.reading("300"), "サンビャク");
  assert.strictEqual(N.reading("600"), "ロッピャク");
  assert.strictEqual(N.reading("800"), "ハッピャク");
  assert.strictEqual(N.reading("3000"), "サンゼン");
  assert.strictEqual(N.reading("8000"), "ハッセン");
});

test("数字读音：万 / 亿 / 零 + 认不出来返回 null", () => {
  assert.strictEqual(N.reading("10000"), "イチマン");
  assert.strictEqual(N.reading("12000"), "イチマンニセン");
  assert.strictEqual(N.reading("0"), "ゼロ");
  assert.strictEqual(N.reading("000"), "ゼロ");
  assert.strictEqual(N.reading("abc"), null);
  assert.strictEqual(N.reading(""), null);
});

test("英语数词：10 テン、12 トゥエルブ、105 ワンハンドレッドファイブ", () => {
  // 歌词里的数字常按英文念：整串英语数词既不是日语读法，也不是逐位念
  assert.strictEqual(N.englishKana("10"), "テン");
  assert.strictEqual(N.englishKana("12"), "トゥエルブ");
  assert.strictEqual(N.englishKana("21"), "トゥエンティワン");
  assert.strictEqual(N.englishKana("105"), "ワンハンドレッドファイブ");
  assert.strictEqual(N.englishKana("100"), "ワンハンドレッド");
  assert.strictEqual(N.englishKana("1000"), "ワンサウザンド");
  assert.strictEqual(N.englishKana("2020"), "ツーサウザンドトゥエンティ");
  // 全角数字、前导 0、认不出来
  assert.strictEqual(N.englishKana("１０"), "テン");
  assert.strictEqual(N.englishKana("007"), "セブン");
  assert.strictEqual(N.englishKana("abc"), null);
  assert.strictEqual(N.englishKana("1234567"), null, "超过 999999 不猜");
});

test("数字扫描：找出一行里的数字段", () => {
  // 比数组而不是对象：scan 返回的对象来自 jsdom 那个 realm，原型和这边不一样
  assert.deepStrictEqual(
    Array.from(N.scan("105℃の君と 2020年"), (r) => [r.text, r.start, r.end]),
    [
      ["105", 0, 3],
      ["2020", 8, 12],
    ]
  );
});
