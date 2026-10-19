/*
 * 生成汉字读音表（src/core/hanzi.js）——「一个汉字 -> 一片假名」。
 *
 *   npm run build:hanzi
 *
 * 数据来自 pinyin-pro（devDependency，构建期用，不进插件包）：逐个 CJK 统一表意文字
 * 取无声调拼音，再用 tools/mandarin-kana.js 拼成片假名。运行时只查表，不做任何转换。
 *
 * 为什么整张表都要：歌词里什么字都可能有，漏一个就是那一格空着。20800 多个字听起来多，
 * 但表就是一张 flat object，查不到就是 undefined，代价只有包体积。
 *
 * 多音字按"歌词里最常见"的那一档定死（pinyin-pro 的单字默认读音对歌词大多是对的，
 * 只有几个明显的要改，见 OVERRIDE）。真要按上下文分，得在运行期做分词，
 * 那是另一个量级的工程，也会让同一句歌词的读音变得不可复现。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { pinyin } = require("pinyin-pro");
const { syllableToKatakana } = require("./mandarin-kana.js");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "src", "core", "hanzi.js");

/** 单字默认读音在歌词里明显不对的，按最常见的那一档改 */
const OVERRIDE = {
  了: "le", // pinyin-pro 给 liao，但歌词里几乎全是"了"（le）
};

/** CJK 统一表意文字基本区 */
const START = 0x4e00;
const END = 0x9fff;

function generate() {
  const table = [];
  for (let cp = START; cp <= END; cp++) {
    const ch = String.fromCharCode(cp);
    let py = "";
    try {
      py = pinyin(ch, { toneType: "none" });
    } catch (e) {
      py = "";
    }
    if (!py || py === ch) continue;
    if (Object.prototype.hasOwnProperty.call(OVERRIDE, ch)) py = OVERRIDE[ch];
    const kana = syllableToKatakana(py);
    if (!kana) continue;
    table.push([ch, kana, py]);
  }
  return table;
}

function content(rows) {
  const lines = [];
  lines.push("/*");
  lines.push(" * 汉字 -> 片假名读音（生成物，勿手改）。");
  lines.push(" *");
  lines.push(" * 来源：pinyin-pro 的单字无声调拼音 + tools/mandarin-kana.js 的拼读规则，");
  lines.push(" * 由 tools/build-hanzi.js 生成（npm run build:hanzi）。");
  lines.push(" *");
  lines.push(" * 只做「一个字一个音节」：查不到就返回 undefined，调用方按「不注音」处理。");
  lines.push(" * 多音字取歌词里最常见的那一档（见构建脚本里的 OVERRIDE）。");
  lines.push(" *");
  lines.push(" * 本表条数：" + rows.length);
  lines.push(" */");
  lines.push("(function (root, factory) {");
  lines.push('  if (typeof module === "object" && module.exports) module.exports = factory();');
  lines.push("  else root.WKHanzi = factory();");
  lines.push("})(typeof globalThis !== \"undefined\" ? globalThis : this, function () {");
  lines.push('  "use strict";');
  lines.push("");
  lines.push("  var kana = {");
  let buf = [];
  for (const [ch, kana, py] of rows) {
    buf.push(JSON.stringify(ch) + ": " + JSON.stringify(kana));
    if (buf.length === 10) {
      lines.push("    " + buf.join(", ") + ",");
      buf = [];
    }
  }
  if (buf.length) lines.push("    " + buf.join(", ") + ",");
  lines.push("  };");
  lines.push("");
  lines.push("  return {");
  lines.push("    kana: kana,");
  lines.push("    count: " + rows.length + ",");
  lines.push("  };");
  lines.push("});");
  lines.push("");
  return lines.join("\n");
}

function main() {
  const rows = generate();
  fs.writeFileSync(OUT, content(rows));
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log("已生成 " + path.relative(ROOT, OUT) + "：" + rows.length + " 个字，" + kb + " KB");
  // 抽查几个字，出问题一眼能看出来
  const pick = ["我", "爱", "雨", "你", "是", "的", "了", "天", "球", "一", "想", "声", "笑", "泪"];
  console.log(
    "  抽查：" +
      pick
        .map((c) => {
          const hit = rows.filter((r) => r[0] === c)[0];
          return c + "=" + (hit ? hit[1] + "(" + hit[2] + ")" : "?");
        })
        .join(" ")
  );
}

if (require.main === module) main();

module.exports = { generate, content, OVERRIDE };
