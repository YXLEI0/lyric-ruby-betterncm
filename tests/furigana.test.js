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

test("按行修正：读音写成空串 = 留空（这一行不给这个词注音）", () => {
  /*
   * 当て字（帷帳 とばり 这种）在某些句子里干脆不该注音 ——
   * 面板 / 就地编辑器把读音写成空串就表示"留空"。
   */
  const ctx = newWindow();
  const W = ctx.window;
  W.WKFurigana.setTokenizer(fakeTokenizer({ 帷: "トバリ", 帳: "チョウ" }));
  const kept = Array.from(W.WKFurigana.tokens("帷帳の奥", { fixes: { 帷: "" } }) || [], (t) => [t.text, t.kana, t.blank]);
  // 留空的那一段不产生注音，但会给一个 blank 标记（annotate 用它包一层壳，好让页面上还能改回来）
  assert.deepStrictEqual(kept[0][0], "帷", "留空的是 帷：" + JSON.stringify(kept));
  assert.strictEqual(kept[0][2], true, "留空的段要标成 blank：" + JSON.stringify(kept));
  assert.ok(!kept[0][1], "留空就没有读音：" + JSON.stringify(kept));
  assert.deepStrictEqual(
    kept.filter((x) => !x[2]).map((x) => [x[0], x[1]]),
    [["帳", "ちょう"]],
    "留空的词不注，其余照旧：" + JSON.stringify(kept)
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

test("振假名：数字 + 假名只注数字那一段（1つ ひとつ，つ 不注）", async () => {
  /*
   * 真机现象：`たった1つの音をか` 里 `つ` 上面也顶着一层假名（ひとつ 盖住了 1つ）。
   * 假名本来就会读，再盖一层注音纯属噪音 —— 底字只留数字。
   * 数字后面跟的是汉字时（10日 とおか）不能截，汉字本身要注。
   */
  const ctx = newWindow();
  const W = ctx.window;
  loadScripts(ctx.dom, [VENDOR_KUROMOJI].concat(VENDOR_FILES));
  W.betterncm = {
    fs: {
      readFile(p) {
        const buf = fs.readFileSync(p);
        const u8 = new W.Uint8Array(buf.length);
        u8.set(buf);
        return u8.buffer;
      },
    },
  };
  W.WKFurigana.configure({ dicPath: path.join(ROOT, "vendor", "dict") });
  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    W.WKFurigana.load(() => resolve(true));
    const timer = setInterval(() => {
      if (W.WKFurigana.ready()) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - t0 > 30000) {
        clearInterval(timer);
        reject(new Error("词典加载超时"));
      }
    }, 50);
  });

  const one = W.WKFurigana.tokens("1つ");
  // 底字只留数字，读音也把尾巴那一截（つ）截掉：1 = ひと（和 一 = ひと 同一个规矩）
  assert.deepStrictEqual(Array.from(one, (t) => [t.text, t.kana, t.start, t.end]), [["1", "ひと", 0, 1]], "つ 不许被注：" + JSON.stringify(one));

  // 全角数字也要认（以前整行直接返回 null）
  const zen = W.WKFurigana.tokens("３つの");
  assert.deepStrictEqual(Array.from(zen, (t) => [t.text, t.kana]), [["３", "みっ"]], "全角数字也要截尾巴：" + JSON.stringify(zen));

  // 数字 + 汉字：底字不截
  const ni = W.WKFurigana.tokens("2人で");
  assert.deepStrictEqual(Array.from(ni, (t) => [t.text, t.kana]), [["2人", "ふたり"]], "汉字要留下来：" + JSON.stringify(ni));

  const hi = W.WKFurigana.tokens("10日");
  assert.deepStrictEqual(Array.from(hi, (t) => [t.text, t.kana]), [["10日", "とおか"]], "熟字训整词：" + JSON.stringify(hi));
});

test("振假名：绝对路径读不进去时，自动退到相对路径把词典读起来", async () => {
  /*
   * 真机现象：整页一个注音都没有，而控制台之外什么都看不到。
   * 原因可以是 betterncm.fs 不接受 pluginPath 拼出来的绝对路径 —— 这时必须自己
   * 再试 "vendor/dict"，并把成功的那条路径写进 status().path（面板上要显示）。
   */
  const ctx = newWindow();
  const W = ctx.window;
  loadScripts(ctx.dom, [VENDOR_KUROMOJI].concat(VENDOR_FILES));
  W.plugin = { pluginPath: "C:/nope/lyric-ruby" };
  W.betterncm = {
    fs: {
      readFile(p) {
        assert.ok(p.indexOf("C:/nope") < 0, "绝对路径这次读不到：" + p);
        const buf = fs.readFileSync(p);
        const u8 = new W.Uint8Array(buf.length);
        u8.set(buf);
        return u8.buffer;
      },
    },
  };
  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    W.WKFurigana.load(() => resolve(true));
    const timer = setInterval(() => {
      if (W.WKFurigana.ready()) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - t0 > 30000) {
        clearInterval(timer);
        reject(new Error("没有退到相对路径："));
      }
    }, 50);
  });
  const st = W.WKFurigana.status();
  assert.ok(/vendor\/dict/.test(st.path), "记录真正读成功的路径：" + JSON.stringify(st));
  const tokens = W.WKFurigana.tokens("東京の空");
  assert.deepStrictEqual(
    Array.from(tokens, (t) => [t.text, t.kana]),
    [["東京", "とうきょう"], ["空", "そら"]]
  );
});

test("振假名：全部路径都读不到时，status().error 里要带上试过的路径", async () => {
  const ctx = newWindow();
  const W = ctx.window;
  loadScripts(ctx.dom, [VENDOR_KUROMOJI].concat(VENDOR_FILES));
  W.plugin = { pluginPath: "C:/nope/lyric-ruby" };
  W.betterncm = {
    fs: {
      readFile() {
        return Promise.reject(new Error("没有这个文件"));
      },
    },
  };
  await new Promise((resolve) => {
    W.WKFurigana.load(function () {});
    const timer = setInterval(() => {
      const st = W.WKFurigana.status();
      if (!st.loading && st.error) {
        clearInterval(timer);
        assert.ok(st.tried.length >= 2, "要把试过的路径都记下来：" + JSON.stringify(st));
        resolve(true);
      }
    }, 50);
  });
  assert.ok(W.WKFurigana.status().error);
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

test("振假名：叠字符 々 整词注（日々 ひび）、数字+汉字整词读（一歩 / 万回 / 千切れる）", async () => {
  const ctx = newWindow();
  const W = ctx.window;
  loadScripts(ctx.dom, [VENDOR_KUROMOJI].concat(VENDOR_FILES));
  W.betterncm = {
    fs: {
      readFile(p) {
        const buf = fs.readFileSync(p);
        const u8 = new W.Uint8Array(buf.length);
        u8.set(buf);
        return u8.buffer;
      },
    },
  };
  W.WKFurigana.configure({ dicPath: path.join(ROOT, "vendor", "dict") });
  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    W.WKFurigana.load(() => resolve(true));
    const timer = setInterval(() => {
      if (W.WKFurigana.ready()) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - t0 > 30000) {
        clearInterval(timer);
        reject(new Error("词典加载超时"));
      }
    }, 50);
  });

  const pairs = (s) => Array.from(W.WKFurigana.tokens(s) || [], (t) => [t.text, t.kana]);
  assert.deepStrictEqual(pairs("日々"), [["日々", "ひび"]], "叠字符跟着整词注");
  assert.deepStrictEqual(pairs("あとがきで日々"), [["日々", "ひび"]], "一行里也一样");
  assert.deepStrictEqual(pairs("一歩"), [["一歩", "いっぽ"]], "一歩 いっぽ（不是 いちほ）");
  assert.deepStrictEqual(pairs("万回"), [["万回", "まんかい"]], "万回 まんかい（不是 いちまんかい）");
  assert.deepStrictEqual(pairs("一万回"), [["一万回", "いちまんかい"]], "一万回 不变");
  assert.deepStrictEqual(pairs("千切れる"), [["千切", "ちぎ"]], "千切れる ちぎれる");
  /*
   * 星々 在 IPADIC 里不是一个词（切成 星 + 々，々 的读音就是它自己），
   * 以前 々 上面什么都没有（真机现象：`あの星々は` 只注了 星）。
   * 现在 々 跟着前一个字读，并按连浊浊化：ほし → ぼし。
   */
  assert.deepStrictEqual(pairs("あの星々は"), [["星", "ほし"], ["々", "ぼし"]], "叠字符跟着前一个字读：" + JSON.stringify(pairs("あの星々は")));
});

test("单字 + 固定语法：良 よ / 皆 みな（皆一緒 かいいっしょ）/ 等 など / 達 たち / 故 ゆえ", async () => {
  /*
   * IPADIC 单独看一个字时会按音読み / 罕见训読み给：
   *   良 → リョウ（形容词词干应该 よ）
   *   皆 + 一緒 → カイ + イッショ（歌词里是 みないっしょ）
   *   等 → ヒトシ（などの 等）、達 → イタル（たち）、故 → コ（ゆえ）
   * 这些读音由后面的语法定，改单字那条，整词（良質 / 皆無 / 等分 / 故郷）不动。
   */
  const ctx = newWindow();
  const W = ctx.window;
  loadScripts(ctx.dom, [VENDOR_KUROMOJI].concat(VENDOR_FILES));
  W.betterncm = {
    fs: {
      readFile(p) {
        const buf = fs.readFileSync(p);
        const u8 = new W.Uint8Array(buf.length);
        u8.set(buf);
        return u8.buffer;
      },
    },
  };
  W.WKFurigana.configure({ dicPath: path.join(ROOT, "vendor", "dict") });
  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    W.WKFurigana.load(() => resolve(true));
    const timer = setInterval(() => {
      if (W.WKFurigana.ready()) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - t0 > 30000) {
        clearInterval(timer);
        reject(new Error("词典加载超时"));
      }
    }, 50);
  });

  const pairs = (s) => Array.from(W.WKFurigana.tokens(s) || [], (t) => [t.text, t.kana]);
  assert.deepStrictEqual(pairs("良"), [["良", "よ"]], "单独一个 良：" + JSON.stringify(pairs("良")));
  assert.deepStrictEqual(pairs("良、"), [["良", "よ"]], "后面是标点也一样");
  assert.deepStrictEqual(pairs("良かった"), [["良", "よ"]], "形容词活用照旧");
  assert.deepStrictEqual(pairs("良質"), [["良質", "りょうしつ"]], "整词 りょう 不动");
  assert.deepStrictEqual(pairs("良心"), [["良心", "りょうしん"]], "整词 りょう 不动");

  assert.deepStrictEqual(pairs("皆一緒"), [["皆", "みな"], ["一緒", "いっしょ"]], "皆一緒 みないっしょ：" + JSON.stringify(pairs("皆一緒")));
  assert.deepStrictEqual(pairs("皆一緒に"), [["皆", "みな"], ["一緒", "いっしょ"]], "皆一緒に 也一样");
  assert.deepStrictEqual(pairs("皆無"), [["皆無", "かいむ"]], "整词 かい 不动");
  assert.deepStrictEqual(pairs("皆勤"), [["皆勤", "かいきん"]], "整词 かい 不动");
  assert.deepStrictEqual(pairs("皆さん"), [["皆", "みな"]], "皆さん みな");

  assert.deepStrictEqual(pairs("等"), [["等", "など"]], "单独一个 等：" + JSON.stringify(pairs("等")));
  assert.deepStrictEqual(pairs("等、"), [["等", "など"]], "后面是标点也一样");
  assert.deepStrictEqual(pairs("等しい"), [["等", "ひと"]], "等しい 是 ひとしい，不是 など：" + JSON.stringify(pairs("等しい")));
  assert.deepStrictEqual(pairs("等分"), [["等分", "とうぶん"]], "整词 とう 不动");
  assert.deepStrictEqual(pairs("達"), [["達", "たち"]], "单独一个 達：" + JSON.stringify(pairs("達")));
  assert.deepStrictEqual(pairs("達する"), [["達", "たっ"]], "達する 是 たっする，不是 たち：" + JSON.stringify(pairs("達する")));
  assert.deepStrictEqual(pairs("故"), [["故", "ゆえ"]], "单独一个 故：" + JSON.stringify(pairs("故")));
  assert.deepStrictEqual(pairs("故郷"), [["故郷", "こきょう"]], "整词 こ 不动");

  /*
   * 候选：同一个写法在 IPADIC 里的**所有**读法（不是 tokenizer 选中的那一条）。
   * 灯 七个、弄る 两个；行く 的候选只取词干（い / ゆ），按钮上显示整个词的读音。
   */
  const vars = (line, at, word) => Array.from(W.WKFurigana.variants(line, at, word) || [], (v) => [v.kana, v.label]);
  assert.deepStrictEqual(
    vars("灯", 0, "灯"),
    [["あかり", "あかり"], ["ひ", "ひ"], ["とう", "とう"], ["とぼし", "とぼし"], ["あかし", "あかし"], ["ともし", "ともし"], ["とも", "とも"]],
    "灯 的全部读音：" + JSON.stringify(vars("灯", 0, "灯"))
  );
  assert.deepStrictEqual(vars("弄る", 0, "弄"), [["いじく", "いじくる"], ["いじ", "いじる"]], "弄る いじくる / いじる");
  assert.deepStrictEqual(vars("空", 0, "空"), [["そら", "そら"], ["から", "から"], ["くう", "くう"]], "空 そら / から / くう");
  assert.deepStrictEqual(vars("泡沫", 0, "泡沫"), [["ほうまつ", "ほうまつ"], ["うたかた", "うたかた"]], "泡沫");
  assert.deepStrictEqual(vars("行く", 0, "行"), [["い", "いく"], ["ゆ", "ゆく"]], "行く 取词干");
  assert.deepStrictEqual(vars("入る", 0, "入"), [["はい", "はいる"], ["い", "いる"]], "入る はい / い");
});

test("词典读不出的汉字：用「字 + 送假名」探读音（掻 か）", async () => {
  /*
   * 掻 单独的 IPADIC 词条没有读音，整段留白（真机现象：「掻鳴らせ」的 掻 一直空着）。
   * 现在拿这个字去喂 掻く / 掻き / 掻る…，几种写法读音一致就按它注。
   */
  const ctx = newWindow();
  const W = ctx.window;
  loadScripts(ctx.dom, [VENDOR_KUROMOJI].concat(VENDOR_FILES));
  W.betterncm = {
    fs: {
      readFile(p) {
        const buf = fs.readFileSync(p);
        const u8 = new W.Uint8Array(buf.length);
        u8.set(buf);
        return u8.buffer;
      },
    },
  };
  W.WKFurigana.configure({ dicPath: path.join(ROOT, "vendor", "dict") });
  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    W.WKFurigana.load(() => resolve(true));
    const timer = setInterval(() => {
      if (W.WKFurigana.ready()) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - t0 > 30000) {
        clearInterval(timer);
        reject(new Error("词典加载超时"));
      }
    }, 50);
  });
  const pairs = (s) => Array.from(W.WKFurigana.tokens(s) || [], (t) => [t.text, t.kana]);
  assert.deepStrictEqual(pairs("掻鳴らせ"), [["掻", "か"], ["鳴", "な"]], "掻 要探出 か：" + JSON.stringify(pairs("掻鳴らせ")));
  assert.deepStrictEqual(pairs("轍のあと"), [["轍", "わだち"]], "轍 わだち");
});

test("按行修正：数字 + 假名只注数字（fixes / spans 两种都成立）", () => {
  /*
   * 大模型切词 / 就地编辑器给的「1つ ひとつ」也要按同一条规矩截底字，
   * 否则同一个 1つ 会出现两种注法（ひとつ 又盖到 つ 上面去）。
   */
  const ctx = newWindow();
  const W = ctx.window;
  W.WKFurigana.setTokenizer(fakeTokenizer({ 1: null, つ: "ツ", 音: "オト" }));
  const pairs = (opts) => Array.from(W.WKFurigana.tokens("たった1つの音をか", opts) || [], (t) => [t.text, t.kana]);
  assert.deepStrictEqual(pairs({ fixes: { "1つ": "ひとつ" } }), [["1", "ひとつ"], ["音", "おと"]], "fixes 也要截");
  assert.deepStrictEqual(pairs({ spans: [[3, "1つ", "ひとつ"]] }), [["1", "ひとつ"], ["音", "おと"]], "spans 也要截");
});

test("作词者的括号读音：中间夹空格也要采（舞台 (セカイ)）", () => {
  /*
   * `舞台(セカイ)` 紧贴着写的形式 vendor 本来就认；但歌词里常见 `舞台 (セカイ)`
   * （中间一个空格 / 换行），那条正则要求紧贴，于是 舞台 还是按词典读 ぶたい，
   * 括号里的官方读音被丢掉，屏幕上还多出一截 "(セカイ)"（真机现象）。
   */
  const ctx = newWindow();
  const W = ctx.window;
  W.WKFurigana.setTokenizer(fakeTokenizer({ 舞台: "ブタイ", 響: "ヒビ", に: "ニ", く: "ク" }));

  const tight = Array.from(W.WKFurigana.tokens("舞台(セカイ)") || [], (t) => [t.text, t.kana || (t.hide ? "HIDE" : "")]);
  assert.deepStrictEqual(tight, [["舞台", "セカイ"], ["(セカイ)", "HIDE"]], "紧贴写法：" + JSON.stringify(tight));

  const spaced = Array.from(W.WKFurigana.tokens("舞台 (セカイ) に響く") || [], (t) => [t.text, t.kana || (t.hide ? "HIDE" : "")]);
  assert.deepStrictEqual(
    spaced,
    [["舞台", "セカイ"], [" (セカイ)", "HIDE"], ["響", "ひび"]],
    "中间有空格也要采括号里的读音：" + JSON.stringify(spaced)
  );

  /*
   * 优先级：用户就地改的（spans）> 作词者的括号读音 > 大模型 / 面板规则（fixes）> 词典。
   * 真机事故：幕 (エンドロール) 里模型按罗马音答了 まく，把括号里的 エンドロール 顶掉了。
   */
  const byFix = Array.from(W.WKFurigana.tokens("舞台 (セカイ)", { fixes: { 舞台: "ぶたい" } }) || [], (t) => [
    t.text,
    t.kana || (t.hide ? "HIDE" : ""),
  ]);
  assert.deepStrictEqual(byFix, [["舞台", "セカイ"], [" (セカイ)", "HIDE"]], "括号读音要压过模型 / 规则：" + JSON.stringify(byFix));

  const bySpan = Array.from(W.WKFurigana.tokens("舞台 (セカイ)", { spans: [[0, "舞台", "ぶたい"]] }) || [], (t) => [
    t.text,
    t.kana || (t.hide ? "HIDE" : ""),
  ]);
  assert.deepStrictEqual(bySpan, [["舞台", "ぶたい"]], "用户自己改的读音最优先：" + JSON.stringify(bySpan));
});

test("符号读音 / 括号读音带上左边的符号（∞回 なんかい、∞ むげん）", () => {
  /*
   * ∞ 这种符号 kuromoji 一个读音都不给。括号读音 `∞回(なんかい)` 要把它一起圈进去，
   * 单独出现的 ∞ 也要有读音（むげん）。
   */
  const ctx = newWindow();
  const W = ctx.window;
  W.WKFurigana.setTokenizer(fakeTokenizer({ 回: "カイ", 不死: "フシ", 議: "ギ", 鳥: "トリ", 壊: "コワ" }));
  const pairs = (s) => Array.from(W.WKFurigana.tokens(s) || [], (t) => [t.text, t.kana || (t.hide ? "HIDE" : "")]);
  assert.deepStrictEqual(
    pairs("∞回(なんかい)オチても"),
    [["∞回", "なんかい"], ["(なんかい)", "HIDE"]],
    "∞ 要跟 回 一起注：" + JSON.stringify(pairs("∞回(なんかい)オチても"))
  );
  assert.deepStrictEqual(pairs("∞回"), [["∞", "むげん"], ["回", "かい"]], "单独的 ∞ 也要有读音：" + JSON.stringify(pairs("∞回")));
});

test("括号读音：底字是符号 / 叠字符时也要合并（〆（シメ））", () => {
  /*
   * `〆（シメ）にまった` 的 〆 不是汉字（vendor 的 KANJI 表里没有它），
   * 以前的括号正则只认汉字，括号那截一直露在屏幕上（真机现象：括号没合并）。
   * 现在 〆 也算底字：读音取括号里的，括号那段藏起来。
   */
  const ctx = newWindow();
  const W = ctx.window;
  W.WKFurigana.setTokenizer(fakeTokenizer({ に: "ニ", まっ: "マッ", た: "タ" }));
  const pairs = (s) => Array.from(W.WKFurigana.tokens(s) || [], (t) => [t.text, t.kana || (t.hide ? "HIDE" : "")]);
  assert.deepStrictEqual(pairs("〆（シメ）にまった"), [["〆", "シメ"], ["（シメ）", "HIDE"]], "全角括号：" + JSON.stringify(pairs("〆（シメ）にまった")));
  assert.deepStrictEqual(pairs("〆(シメ)にまった"), [["〆", "シメ"], ["(シメ)", "HIDE"]], "半角括号：" + JSON.stringify(pairs("〆(シメ)にまった")));
});

test("括号读音的底字按网站的范围取（假名 / 西文 / 符号都算），读音照原样显示", () => {
  /*
   * 底字的范围照 UtaTen 标的来：括号前面那一整段（汉字 + 送假名 / 西文 / 符号）都是底字。
   * 以前只认 `[汉字]+`：`怒れる人(ラングラー)` 只注到 人、`HEART(ココロ)` 一个 token 都不出
   * （整行没有汉字就被早退丢掉），括号里的官方读音全白写。
   *
   * 读音**照原样**显示：括号里写的是片假名就出片假名，不跟着面板的平假名设置走 ——
   * 那是作词者标的读法（用户明确要求）。
   */
  const ctx = newWindow();
  const W = ctx.window;
  W.WKFurigana.setTokenizer(fakeTokenizer({ 怒: "イカ", 人: "ヒト", 一度: "イチド", 嘲笑: "チョウショウ", 回: "カイ" }));
  const pairs = (s, opts) => Array.from(W.WKFurigana.tokens(s, opts) || [], (t) => [t.text, t.kana || (t.hide ? "HIDE" : "")]);

  assert.deepStrictEqual(
    pairs("怒れる人(ラングラー)"),
    [["怒れる人", "ラングラー"], ["(ラングラー)", "HIDE"]],
    "含送假名的底字整段算：" + JSON.stringify(pairs("怒れる人(ラングラー)"))
  );
  /*
   * 西文 / 纯假名底字**不算**括号读音（照 jp-furigana 的 RE_INLINE_RUBY：要求括号前是汉字）。
   * 真机反例：`More More（フップー）` 的括号是唱出来的喊话，不是写法说明 ——
   * 当读音处理会把这段歌词整段藏掉。西文词的读音交给网站 / 词典那条路。
   */
  assert.deepStrictEqual(pairs("HEART(ココロ)"), [], "西文底字不认括号读音");
  assert.deepStrictEqual(pairs("More More（フップー）"), [], "括号里的喊话不当读音");
  assert.deepStrictEqual(
    pairs("イナイイナイ×点(ばってん)"),
    [["×点", "ばってん"], ["(ばってん)", "HIDE"]],
    "左边的假名是前一个词，不许圈进来：" + JSON.stringify(pairs("イナイイナイ×点(ばってん)"))
  );
  assert.deepStrictEqual(
    pairs("一度嘲笑(わら)"),
    [["嘲笑", "わら"], ["(わら)", "HIDE"]],
    "纯汉字底字仍按拍数收窄：" + JSON.stringify(pairs("一度嘲笑(わら)"))
  );
  // 平假名写法在「全片假名」模式下也照原样（不跟着设置改）
  assert.deepStrictEqual(
    pairs("舞台(せかい)", { kana: "katakana" }),
    [["舞台", "せかい"], ["(せかい)", "HIDE"]],
    "括号里的平假名也不会被改成片假名：" + JSON.stringify(pairs("舞台(せかい)", { kana: "katakana" }))
  );
});

test("括号读音的底字只取最后一个词（助词切一刀），整句念的短语有特例表", () => {
  /*
   * 真机案例：`奇を衒った奴らの芸術（アルス）に` —— 括号里的读音只属于 芸術，
   * 不是整句 10 个字。判据是"助词切一刀"：单个助词（を が は に へ と で も の や）
   * 后面紧跟正文就是词边界。`怒れる人(ラングラー)` 这种整句念的走特例表。
   */
  const ctx = newWindow();
  const W = ctx.window;
  W.WKFurigana.setTokenizer(
    fakeTokenizer({ 奇: "キ", 衒: "テラ", 奴: "ヤツ", 芸術: "ゲイジュツ", 怒: "イカ", 人: "ヒト", 夜: "ヨル", 越: "コ" })
  );
  const pairs = (s) => Array.from(W.WKFurigana.tokens(s) || [], (t) => [t.text, t.kana || (t.hide ? "HIDE" : "")]);
  assert.deepStrictEqual(
    pairs("奇を衒った奴らの芸術（アルス）に"),
    [["奇", "き"], ["衒", "てら"], ["奴", "やつ"], ["芸術", "アルス"], ["（アルス）", "HIDE"]],
    "只注最后一个词：" + JSON.stringify(pairs("奇を衒った奴らの芸術（アルス）に"))
  );
  assert.deepStrictEqual(
    pairs("怒れる人(ラングラー)"),
    [["怒れる人", "ラングラー"], ["(ラングラー)", "HIDE"]],
    "整句念的短语（特例表）：" + JSON.stringify(pairs("怒れる人(ラングラー)"))
  );
  // 拍数对不上底字时（6 拍盖过 越えて 的容量）退回整段
  assert.deepStrictEqual(
    pairs("夜を越えて(よるをこえて)"),
    [["夜を越えて", "よるをこえて"], ["(よるをこえて)", "HIDE"]],
    "拍数比底字长太多就整段：" + JSON.stringify(pairs("夜を越えて(よるをこえて)"))
  );
});

test("留空压过模型 / 面板规则给的读音", () => {
  /*
   * 用户把某一处留空（读音写成空串）之后，模型或面板规则给的读音也不许注回来 ——
   * 不然屏幕上又冒出读音，留空等于没起作用（真机现象：留了空也不为空）。
   */
  const ctx = newWindow();
  const W = ctx.window;
  W.WKFurigana.setTokenizer(fakeTokenizer({ 人: "ヒト", 痛: "イタ" }));
  const line = "痛みと怒れる人";
  const at = line.indexOf("人");
  const pairs = (opts) =>
    Array.from(W.WKFurigana.tokens(line, opts) || [], (t) => [t.text, t.kana || "", !!t.blank]);
  assert.deepStrictEqual(pairs({ spans: [[at, "人", ""]] }), [["痛", "いた", false], ["人", "", true]], "留空就只剩 blank：" + JSON.stringify(pairs({ spans: [[at, "人", ""]] })));
  assert.deepStrictEqual(
    pairs({ spans: [[at, "人", ""]], fixes: { 人: "ひと" } }),
    [["痛", "いた", false], ["人", "", true]],
    "模型给的读音也不许注回来：" + JSON.stringify(pairs({ spans: [[at, "人", ""]], fixes: { 人: "ひと" } }))
  );
});

test("音译兜底：词典读不出的汉字按页面上的音译行反推读音", () => {
  /*
   * 表外字（霽 / 鬱 这种词典里没有的）以前只能留空或问大模型。
   * 页面上本来就有「音译」那一行（`a me a ga ri no ha re`）——
   * 拿它反推：已知的片段负责对齐，读不出的那个字吃掉中间剩下的那几拍。
   * 音译对不上这一行（换行切错 / 另一句）时必须整行放弃，一个都不许乱填。
   */
  const ctx = newWindow();
  const W = ctx.window;
  W.WKFurigana.setTokenizer(fakeTokenizer({})); // 什么词都没读过，全靠音译
  const pairs = (s, romaji) =>
    Array.from(W.WKFurigana.tokens(s, romaji ? { romaji: romaji } : undefined) || [], (t) => [t.text, t.kana || (t.hide ? "HIDE" : "")]);

  assert.deepStrictEqual(pairs("雨上がりの霽れ"), [], "没有音译时读不出就是读不出");
  assert.deepStrictEqual(
    pairs("雨上がりの霽れ", "a me a ga ri no ha re"),
    [["雨上", "あめあ"], ["霽", "は"]],
    "读不出的字要从音译里拿到读音（霽 は）：" + JSON.stringify(pairs("雨上がりの霽れ", "a me a ga ri no ha re"))
  );
  assert.deepStrictEqual(
    pairs("雨上がりの霽れ", "ki mi no ko e ga too ku"),
    [],
    "音译是另一句时不许乱填：" + JSON.stringify(pairs("雨上がりの霽れ", "ki mi no ko e ga too ku"))
  );
  // 词典读得出来的地方不许被音译盖掉
  const W2 = newWindow();
  W2.window.WKFurigana.setTokenizer(fakeTokenizer({ 空: "ソラ", に: "ニ", 虹: "ニジ", が: "ガ" }));
  const got = Array.from(W2.window.WKFurigana.tokens("空に虹が架かる", { romaji: "so ra ni ni ji ga ka ka ru" }) || [], (t) => [
    t.text,
    t.kana,
  ]);
  assert.deepStrictEqual(
    got,
    [["空", "そら"], ["虹", "にじ"], ["架", "か"]],
    "有词典读音的照旧，没读音的才补：" + JSON.stringify(got)
  );
});

test("音译兜底：会被唱出来的符号（×）也注上", () => {
  /*
   * 词典对 × 一个读音都不给，但音译里它占着一拍 —— `イナイイナイ×点` 的 × 唱 ば。
   * 现在符号也当成"读不出的格"去对齐音译；不带音译时照旧留白。
   */
  const ctx = newWindow();
  const W = ctx.window;
  W.WKFurigana.setTokenizer(fakeTokenizer({}));
  const pairs = (s, romaji) =>
    Array.from(W.WKFurigana.tokens(s, romaji ? { romaji: romaji } : undefined) || [], (t) => [t.text, t.kana]);
  assert.deepStrictEqual(pairs("イナイイナイ×点"), [], "没有音译时读不出就是读不出");
  assert.deepStrictEqual(
    pairs("イナイイナイ×点", "i na i i na i ba te n"),
    [["×", "ば"], ["点", "てん"]],
    "× 要从音译里拿到 ば：" + JSON.stringify(pairs("イナイイナイ×点", "i na i i na i ba te n"))
  );
});
