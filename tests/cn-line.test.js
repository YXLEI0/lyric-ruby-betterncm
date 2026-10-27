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
