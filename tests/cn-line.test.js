/*
 * 「这一行是中文还是日文」的判据（core/cn-line.js）。
 *
 * 日语歌里夹中文行很常见（中文版歌词、双语字幕），整首有假名不代表这一行是日语 ——
 * 中文行要走中文读音那档，日文行才查日语读音。判据只看"有没有中文特有的字形 / 标点 /
 * 虚词"，不转换文本。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { loadCore } = require("./helpers.js");

const ctx = loadCore("<!doctype html><html><body></body></html>", {
  reader: false,
  files: ["core/cn-line.js"],
});
const L = ctx.window.WKCnLine;

test("中文行：简体特有字形、中文标点、语气词、两个以上虚词", () => {
  // 简体特有字形（日文正文里不写这些写法）
  for (const line of ["我爱上你", "时间过去", "这是什么", "我们走吧", "还在这里"]) {
    assert.strictEqual(L.isChineseLine(line), true, "这是中文行：" + line);
  }
  // 中文标点 / 语气词
  assert.strictEqual(L.isChineseLine("你好，世界"), true, "中文逗号");
  assert.strictEqual(L.isChineseLine("你还好吗"), true, "语气词 吗");
  // 纯汉字、但两个以上中文虚词（没有简体特有字形）
  assert.strictEqual(L.isChineseLine("风中有朵雨做的云"), true, "的 是 中文虚词");
});

test("日文行不许被抢：有假名、或纯汉字但不像中文", () => {
  // 有假名就是日文行
  for (const line of ["きらめく光の中で", "そんな筈はないだろ", "東京の空", "ずっと light と clover"]) {
    assert.strictEqual(L.isChineseLine(line), false, "有假名 / 混排，不是纯中文行：" + line);
  }
  // 纯汉字但不是中文：日文里常见的写法
  for (const line of ["東京", "日本", "音楽", "愛してる"]) {
    assert.strictEqual(L.isChineseLine(line), false, "这行不是中文：" + line);
  }
});

test("判据只做判断，不改文本（没有转换表）", () => {
  // 模块只暴露 isChineseLine：调用方不该指望它把 爱 换成 愛
  assert.strictEqual(typeof L.isChineseLine, "function");
  assert.strictEqual(typeof L.toJapanese, "undefined", "转换接口已经删掉了");
});

test("日语标题行不许被判成中文：全角冒号 / 全角括号都不算中文标点", () => {
  /*
   * 真机事故：`通称：愛情対象年齢` 被注成了 トンチェン / アイチン / ドゥイシャン / ニェンリン
   * —— 整整一行普通话读音。原因是判据把全角冒号当成了中文标点，
   * 而日文标题行本来就在用 `：`（`通称：`、`第一話：`）。
   */
  for (const line of ["通称：愛情対象年齢", "年齢", "愛情対象年齢", "（ツンデレ・ガール）", "第一話：出会い"]) {
    assert.strictEqual(L.isChineseLine(line), false, "这不是中文行：" + line);
  }
  // 真正的中文行照样认得出来
  assert.strictEqual(L.isChineseLine("你好，世界"), true, "中文逗号仍然是中文行");
});

test("日文里也在用的那几个简体字不许当证据（里 / 机 / 后 / 丑 / 剥 / 云）", () => {
  /*
   * 这几个人工核对过的字日文正文里也写（里山 / 机上 / 皇后 / 丑三つ時 / 剥がす / 云々），
   * 留在"只在中文里出现"的表里，纯汉字的日文行会被整行判成中文。
   */
  assert.strictEqual(L.isChineseLine("机上の空論"), false, "有假名，不是中文行");
  assert.strictEqual(L.isChineseLine("万里"), false, "万里 是日文也用的词");
  assert.strictEqual(L.isChineseLine("云云"), false, "云々 的 云");
});

test("hasChineseEvidence：比 isChineseLine 宽一档（一个中文虚词也算）", () => {
  /*
   * 整首歌判成中文歌之后，纯汉字行要先排除"有一点中文味道"的，
   * 剩下的才按日语词典的可读性去认日语标题行。`毫不得意` 只有一个 不
   * （虚词要两个才算中文行），但它显然不是日文。
   */
  assert.strictEqual(L.hasChineseEvidence("毫不得意"), true, "不 / 得 都算中文痕迹");
  assert.strictEqual(L.hasChineseEvidence("不用害怕"), true, "不");
  assert.strictEqual(L.isChineseLine("不用害怕"), false, "只有一个虚词：按 isChineseLine 还不算中文行");
  // 一点中文痕迹都没有的纯汉字行
  for (const line of ["(G・U・T・S雫)", "愛情対象年齢", "東京"]) {
    assert.strictEqual(L.hasChineseEvidence(line), false, "没有中文痕迹：" + line);
  }
});
