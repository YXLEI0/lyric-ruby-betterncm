/*
 * 振假名（日语汉字标读音）。
 *
 * 两条路线都测：
 *   1. 用假分词器测 core/furigana.js 的切片 / 平片假名 / 缓存 / 兜底（快，不开词典）；
 *   2. 真的把 vendor/kuromoji.js + vendor/dict 读起来跑一遍（慢 1~3 秒，验词典能用）。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { loadCore, loadScripts, CORE_FILES, VENDOR_FILES, VENDOR_KUROMOJI, ROOT } = require("./helpers.js");

/** 一个够用的假分词器：按给定的表切词，读音是片假名（kuromoji 的 reading 也是片假名） */
function fakeTokenizer(table) {
  return {
    tokenize(text) {
      const out = [];
      let i = 0;
      while (i < text.length) {
        let hit = null;
        for (const surface of Object.keys(table)) {
          if (text.startsWith(surface, i)) {
            hit = surface;
            break;
          }
        }
        if (hit) {
          out.push({ surface_form: hit, reading: table[hit], pronunciation: table[hit] });
          i += hit.length;
        } else {
          const ch = text.charAt(i);
          out.push({ surface_form: ch, reading: ch, pronunciation: ch });
          i += 1;
        }
      }
      return out;
    },
  };
}

function newWindow(html) {
  const ctx = loadCore(
    html || '<!doctype html><html><body><ul class="lyric"><li class="line"><p>そんな筈はないだろ</p></li></ul></body></html>',
    { reader: false, files: CORE_FILES }
  );
  // 文本层（vendor/furigana.js）是纯函数，30 KB，所有用例都注入
  loadScripts(ctx.dom, VENDOR_FILES);
  return ctx;
}

test("振假名：汉字片段拿到读音，假名 / 标点原样留着", () => {
  const ctx = newWindow();
  const W = ctx.window;
  W.WKFurigana.setTokenizer(
    fakeTokenizer({ そんな: "ソンナ", 筈: "ハズ", は: "ハ", ない: "ナイ", だろ: "ダロ" })
  );

  const tokens = W.WKFurigana.tokens("そんな筈はないだろ");
  assert.deepStrictEqual(
    Array.from(tokens, (t) => [t.text, t.kana]),
    [["筈", "はず"]],
    "只有汉字那一拍要注音（默认平假名）：" + JSON.stringify(tokens)
  );
  // 位置是整行里的下标：注音层要按它切底字
  assert.strictEqual(tokens[0].start, 3);
  assert.strictEqual(tokens[0].end, 4);

  // 片假名写法
  const kata = W.WKFurigana.tokens("そんな筈はないだろ", { kana: "katakana" });
  assert.strictEqual(kata[0].kana, "ハズ", "面板切成片假名时要跟着变");
});

test("振假名：送假名不注音（食べる -> 食 た），熟字训整词注", () => {
  const ctx = newWindow();
  const W = ctx.window;
  W.WKFurigana.setTokenizer(
    fakeTokenizer({ 食べる: "タベル", 今日: "キョウ", 東京: "トウキョウ", の: "ノ", 空: "ソラ" })
  );

  const t1 = W.WKFurigana.tokens("食べる");
  assert.deepStrictEqual(
    Array.from(t1, (t) => [t.text, t.kana]),
    [["食", "た"]],
    "送假名要留在底字外面：" + JSON.stringify(t1)
  );

  const t2 = W.WKFurigana.tokens("今日の東京の空");
  assert.deepStrictEqual(
    Array.from(t2, (t) => [t.text, t.kana]),
    [["今日", "きょう"], ["東京", "とうきょう"], ["空", "そら"]],
    "熟字训按词注：" + JSON.stringify(t2)
  );
});

test("振假名：没有汉字 / 没有分词器 / 读不出读音时不产出 token（宁可留白）", () => {
  const ctx = newWindow();
  const W = ctx.window;
  // 还没装分词器：返回 null，并自动尝试加载词典（测试里没有 betterncm.fs，失败也不该抛）
  assert.strictEqual(W.WKFurigana.tokens("そんな筈はないだろ"), null, "没有词典时返回 null");
  assert.strictEqual(W.WKFurigana.ready(), false);

  W.WKFurigana.setTokenizer(fakeTokenizer({ そんな: "ソンナ", は: "ハ", ない: "ナイ" }));
  assert.strictEqual(W.WKFurigana.tokens("そんなはない"), null, "这一行没有汉字");
  assert.deepStrictEqual(W.WKFurigana.tokens(""), null);

  // 词典读不出（reading 是 *）的字不注
  W.WKFurigana.setTokenizer({
    tokenize: (text) => [{ surface_form: text, reading: "*", pronunciation: "*" }],
  });
  assert.strictEqual(W.WKFurigana.tokens("謎"), null, "读不出读音就不注");
});

test("振假名：同一行第二次直接命中缓存", () => {
  const ctx = newWindow();
  const W = ctx.window;
  let calls = 0;
  const base = fakeTokenizer({ 東京: "トウキョウ" });
  W.WKFurigana.setTokenizer({
    tokenize(text) {
      calls++;
      return base.tokenize(text);
    },
  });
  const a = W.WKFurigana.tokens("東京");
  const b = W.WKFurigana.tokens("東京");
  assert.strictEqual(calls, 1, "同一行只分词一次");
  assert.deepStrictEqual(a, b);
  W.WKFurigana.clearCache();
  W.WKFurigana.tokens("東京");
  assert.strictEqual(calls, 2, "清缓存之后要重新分词");
});

test("按行修正：fixes 只对这一行生效（同一个词换个句子可以不一样）", () => {
  /*
   * 同一个词在不同句子里读音不同（解 と / かい / ほど、明日 あした / あす），
   * 所以修正不是全局词表，而是调用方按"这一行"算好再传进来。
   */
  const ctx = newWindow();
  const W = ctx.window;
  W.WKFurigana.setTokenizer(fakeTokenizer({ 明日: "アス", 解: "カイ", 好き: "スキ" }));

  // 这一行里 明日 读 あした
  assert.deepStrictEqual(
    Array.from(W.WKFurigana.tokens("明日も", { fixes: { 明日: "あした" } }), (t) => [t.text, t.kana]),
    [["明日", "あした"]],
    "这一行按修正读"
  );
  // 换一行、不带修正：回到词典读音
  assert.deepStrictEqual(
    Array.from(W.WKFurigana.tokens("明日は雨"), (t) => [t.text, t.kana]),
    [["明日", "あした"]],
    "没带修正就用词典（词典本身把 明日 读 あした）"
  );
  // 同一行里 解 可以读 と
  assert.deepStrictEqual(
    Array.from(W.WKFurigana.tokens("解けない", { fixes: { 解: "と" } }), (t) => [t.text, t.kana]),
    [["解", "と"]],
    "按修正读"
  );

  // 片假名写法：用户填平假名也会跟着切成片假名
  assert.deepStrictEqual(
    Array.from(W.WKFurigana.tokens("明日も", { fixes: { 明日: "あした" }, kana: "katakana" }), (t) => [t.text, t.kana]),
    [["明日", "アシタ"]],
    "写法要跟着模式转"
  );
});

test("按行修正：长词优先，重叠的短词不重复注", () => {
  const ctx = newWindow();
  const W = ctx.window;
  W.WKFurigana.setTokenizer(fakeTokenizer({ 大: "ダイ", 好き: "スキ", 大好き: "ダイスキ" }));
  assert.deepStrictEqual(
    Array.from(W.WKFurigana.tokens("大好き", { fixes: { 大: "おお", 大好き: "だいすき" } }), (t) => [t.text, t.kana]),
    [["大好き", "だいすき"]],
    "长词压过短词，且只注一次"
  );
});

test("振假名：真的读出 IPADIC 的读音（kuromoji + vendor/dict）", async () => {
  const ctx = newWindow();
  const W = ctx.window;
  // 注入第三方底座（按注入顺序：kuromoji -> furigana）
  loadScripts(ctx.dom, [VENDOR_KUROMOJI].concat(VENDOR_FILES));
  assert.ok(W.kuromoji, "kuromoji 要挂到窗口上");
  assert.ok(W.FuriganaCore, "furigana.js 要挂到窗口上");

  // 测试里没有 betterncm.fs：直接给一个读本机文件的实现（返回 ArrayBuffer）
  W.betterncm = {
    fs: {
      readFile(p) {
        const buf = fs.readFileSync(p);
        // 用窗口 realm 的 ArrayBuffer：跨 realm 的 instanceof 判不过，这里就按真实形态造
        const u8 = new W.Uint8Array(buf.length);
        u8.set(buf);
        return u8.buffer;
      },
    },
  };
  W.WKFurigana.configure({ dicPath: path.join(ROOT, "vendor", "dict") });

  const ready = await new Promise((resolve, reject) => {
    const t0 = Date.now();
    W.WKFurigana.load(() => resolve(true));
    const timer = setInterval(() => {
      if (W.WKFurigana.ready()) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - t0 > 30000) {
        clearInterval(timer);
        reject(new Error("词典加载超时：" + JSON.stringify(W.WKFurigana.status())));
      }
    }, 50);
  });
  assert.ok(ready);

  const tokens = W.WKFurigana.tokens("そんな筈はないだろ");
  assert.deepStrictEqual(
    Array.from(tokens, (t) => [t.text, t.kana]),
    [["筈", "はず"]],
    "真词典也要读对：" + JSON.stringify(tokens)
  );

  const t2 = W.WKFurigana.tokens("東京の空");
  assert.deepStrictEqual(
    Array.from(t2, (t) => [t.text, t.kana]),
    [["東京", "とうきょう"], ["空", "そら"]],
    "東京 とうきょう / 空 そら：" + JSON.stringify(t2)
  );
});
