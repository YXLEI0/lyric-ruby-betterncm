/*
 * 中文 / 朝鲜语的注音数据与扫描（core/hanzi.js、core/hangul.js、core/cjk.js）。
 *
 * 断言的是"日语里实际怎么标这些音"，不是"跑出来是什么就断言什么"：
 *   汉字按普通话（雨 ユ、爱 アイ、我 ウォ、是 シー），谚文按拼写即读音的规则
 *   （안녕 アンニョン、김치 キムチ、감사합니다 カムサハムニダ）。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const HANGUL = require("../src/core/hangul.js");
const HANZI = require("../src/core/hanzi.js");
const CJK = require("../src/core/cjk.js");

const KANA = /^[\u30A1-\u30F6\u30FC]+$/;

test("谚文：初声 + 中声 + 终声拼一拍", () => {
  const cases = [
    ["가", "カ"],
    ["거", "コ"],
    ["고", "コ"],
    ["구", "ク"],
    ["기", "キ"],
    ["개", "ケ"],
    ["사", "サ"],
    ["서", "ソ"],
    ["시", "シ"],
    ["자", "チャ"],
    ["저", "チョ"],
    ["주", "チュ"],
    ["지", "チ"],
  ];
  for (const [ch, want] of cases) assert.strictEqual(HANGUL.syllable(ch), want, ch);
});

test("谚文：整词读音（y 元音、终声、连读浊化、鼻音化）", () => {
  const cases = [
    ["안녕", "アンニョン"],
    ["사랑", "サラン"],
    ["서울", "ソウル"],
    ["김치", "キムチ"],
    ["눈물", "ヌンムル"],
    ["하늘", "ハヌル"],
    ["바다", "パダ"],
    ["한국", "ハングク"],
    ["감사합니다", "カムサハムニダ"],
    ["보고", "ポゴ"],
    ["이별", "イビョル"],
    ["거짓말", "コジンマル"],
    ["사랑해", "サランヘ"],
  ];
  for (const [w, want] of cases) assert.strictEqual(HANGUL.word(w), want, w);
});

test("谚文：整词算完再按音节拆开（鼻音化要看邻居）", () => {
  const pieces = HANGUL.wordPieces("감사");
  assert.deepStrictEqual(
    pieces.map((p) => [p.ch, p.kana]),
    [["감", "カム"], ["사", "サ"]]
  );
  // 非谚文字符原样留着，kana 是空串
  const mixed = HANGUL.wordPieces("a가");
  assert.deepStrictEqual(mixed, [{ ch: "a", kana: "" }, { ch: "가", kana: "カ" }]);
  assert.strictEqual(HANGUL.isHangul("가"), true);
  assert.strictEqual(HANGUL.isHangul("a"), false);
});

test("汉字表：覆盖够广、读音是纯片假名", () => {
  assert.ok(HANZI.count > 20000, "汉字表太小：" + HANZI.count);
  assert.strictEqual(Object.keys(HANZI.kana).length, HANZI.count, "count 和实际条数要一致");
  let bad = 0;
  for (const ch of Object.keys(HANZI.kana)) {
    if (!KANA.test(HANZI.kana[ch])) bad++;
  }
  assert.strictEqual(bad, 0, "有读音不是纯片假名的：" + bad + " 条");
});

test("汉字表：歌词里最常见的那些字读音要对", () => {
  const cases = [
    ["我", "ウォ"],
    ["爱", "アイ"],
    ["雨", "ユ"],
    ["你", "ニ"],
    ["是", "シー"],
    ["的", "デ"],
    ["了", "レ"],
    ["天", "ティェン"],
    ["球", "チュウ"],
    ["一", "イ"],
    ["眼", "イェン"],
    ["泪", "レイ"],
    // j / q / x 后面的 i 是实打实的 /i/，读长音（气 チー）
    ["气", "チー"],
    ["机", "ジー"],
    ["西", "シー"],
  ];
  for (const [ch, want] of cases) assert.strictEqual(HANZI.kana[ch], want, ch);
  // 表里没有的字返回 undefined（调用方按"不注音"处理）
  assert.strictEqual(HANZI.kana["\u9FFF"], undefined);
});

test("扫描：汉字一个字一个词、位置对", () => {
  CJK.configure({ hanzi: HANZI, hangul: HANGUL });
  const text = "我爱 Rainie Love";
  const toks = CJK.scan(text, { han: true });
  assert.deepStrictEqual(
    toks.map((t) => [t.text, t.start, t.end, t.kana]),
    [
      ["我", 0, 1, "ウォ"],
      ["爱", 1, 2, "アイ"],
    ]
  );
  assert.strictEqual(CJK.hasHan(text), true);
  assert.strictEqual(CJK.hasHangul(text), false);
});

test("扫描：谚文一个音节一个词，读音按整词算", () => {
  CJK.configure({ hanzi: HANZI, hangul: HANGUL });
  const toks = CJK.scan("안녕 내 사랑", { hangul: true });
  assert.deepStrictEqual(
    toks.map((t) => [t.text, t.kana]),
    [
      ["안", "アン"],
      ["녕", "ニョン"],
      ["내", "ネ"],
      ["사", "サ"],
      ["랑", "ラン"],
    ]
  );
});

test("扫描：关掉的那一类不产出 token；两批混排按位置排序", () => {
  CJK.configure({ hanzi: HANZI, hangul: HANGUL });
  const text = "我 사랑";
  assert.strictEqual(CJK.scan(text, { han: true }).length, 1);
  assert.strictEqual(CJK.scan(text, { hangul: true }).length, 2);
  const both = CJK.scan(text, { han: true, hangul: true });
  assert.deepStrictEqual(
    both.map((t) => t.start),
    [0, 2, 3]
  );
});

test("扫描：查不到读音的字不产出 token（宁可留白）", () => {
  CJK.configure({ hanzi: { kana: { 我: "ウォ" }, count: 1 }, hangul: HANGUL });
  const toks = CJK.scan("我鑫", { han: true });
  assert.deepStrictEqual(
    toks.map((t) => t.text),
    ["我"]
  );
});
