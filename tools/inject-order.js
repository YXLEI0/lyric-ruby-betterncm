/*
 * 注入顺序的唯一事实来源。
 *
 * manifest.json 的 injects.Main 决定"注入哪些文件、按什么顺序"，
 * 而构建（tools/build.js）和自检（tools/check.js）都要校验这件事 ——
 * 两边各写一份的话，迟早一份跟着长、另一份没长（build 原来只校验 6 个文件，
 * 剩下的 7 个放哪都通过，于是 install 能装出 check 会拒绝的包）。
 *
 * 这份清单要手工维护：新增一个 core 模块时，改这里 + manifest.json。
 * check 会把两边对不上报出来。
 */
"use strict";

const WANT_ORDER = [
  "core/letters.js",
  "core/dict.js",
  "core/enwords.js",
  "core/reading.js",
  "core/loan.js",
  "core/songs.js",
  "core/langs.js",
  "core/correct.js",
  "core/llm.js",
  "core/usage.js",
  "core/learn.js",
  "core/annotate.js",
  "main.js",
];

module.exports = { WANT_ORDER };
