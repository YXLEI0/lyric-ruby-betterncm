/*
 * 生成 src/core/kanji-readings.js：常用汉字（常用漢字 2136 字）的音读 / 训读表。
 *
 * 数据来自 https://github.com/davidluzgouveia/kanji-data（MIT，见
 * tools/vendor/kanji/LICENSE-kanji-data.txt），放在 tools/vendor/kanji/kanji-jouyou.json。
 *
 * 为什么要这张表：注音层查的是"分词之后这个词"的读音（間違 まちが），单字被切开时
 * 只看得到这一个字的**词内读法**。用户想双击一个字把所有音读 / 训读都列出来
 * （間 かん / けん / あいだ / ま），只能靠一张按字列读音的表。
 *
 * 用法：node tools/build-kanji-readings.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "tools", "vendor", "kanji", "kanji-jouyou.json");
const OUT = path.join(ROOT, "src", "core", "kanji-readings.js");

/** "ゆめ.みる" -> "ゆめ"；"あいだ" 原样。去重、去空。 */
function baseKun(reading) {
  const s = String(reading || "");
  const head = s.split(".")[0];
  return head.replace(/[^\u3041-\u3096\u30A1-\u30FA\u30FC]/g, "");
}

function list(value, mapFn) {
  const out = [];
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    const r = mapFn(item);
    if (r && out.indexOf(r) < 0) out.push(r);
  }
  return out;
}

const data = JSON.parse(fs.readFileSync(SRC, "utf8"));
const table = {};
let chars = 0;
for (const ch of Object.keys(data)) {
  if (!/^[\u4E00-\u9FFF]$/.test(ch)) continue;
  const entry = data[ch] || {};
  // 音读在数据里已经是平假名（かん / けん）；训读带送假名（ゆめ.みる）
  const on = list(entry.readings_on, (s) => String(s || "").replace(/[^\u3041-\u3096\u30A1-\u30FA\u30FC]/g, ""));
  const kun = list(entry.readings_kun, baseKun);
  if (!on.length && !kun.length) continue;
  table[ch] = {};
  if (on.length) table[ch].on = on;
  if (kun.length) table[ch].kun = kun;
  chars++;
}

const body = [
  "/*",
  " * 常用汉字的音读 / 训读表（生成文件，别手改）。",
  " *",
  " *   生成器：tools/build-kanji-readings.js",
  " *   数据源：davidluzgouveia/kanji-data（MIT）里的常用漢字 2136 字",
  " *",
  " * 结构：{ 字: { on: [音读...], kun: [训读...] } }，都是平假名（训读已去掉送假名部分，",
  " * `ゆめ.みる` 只留 `ゆめ`）。注音层切出来的底字如果是单个汉字，就地编辑器会把这两组",
  " * 都列进候选（标成「（音）」「（训）」），这样 `間` 不管当前这句读 ま 还是 あいだ，",
  " * 都能一键换成 かん / けん。",
  " *",
  " * 挂到 globalThis.WKKanjiReadings。",
  " */",
  "(function (root, factory) {",
  '  if (typeof module === "object" && module.exports) module.exports = factory();',
  "  else root.WKKanjiReadings = factory();",
  '})(typeof globalThis !== "undefined" ? globalThis : this, function () {',
  '  "use strict";',
  "",
  "  var table = " + JSON.stringify(table) + ";",
  "",
  "  function of(ch) {",
  "    return table[ch] || null;",
  "  }",
  "",
  "  return {",
  "    table: table,",
  "    count: " + chars + ",",
  "    onOf: function (ch) {",
  "      var e = table[ch];",
  "      return e && e.on ? e.on : [];",
  "    },",
  "    kunOf: function (ch) {",
  "      var e = table[ch];",
  "      return e && e.kun ? e.kun : [];",
  "    },",
  "    of: of,",
  "  };",
  "});",
  "",
].join("\n");

fs.writeFileSync(OUT, body, "utf8");
console.log("写入", path.relative(ROOT, OUT), chars, "字", Math.round(body.length / 1024) + " KB");
