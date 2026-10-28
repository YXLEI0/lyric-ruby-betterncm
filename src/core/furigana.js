/*
 * 日语歌词的振假名：给汉字标上读音（平假名 / 片假名）。
 *
 * 和 core/cjk.js 分工：
 *   - 这个模块只管**日语行**：分词交给 kuromoji + IPADIC（离线，词典在插件目录的 dict/ 下），
 *     切出来的汉字片段由 vendor/furigana.js 对齐出「底字 -> 读音」；
 *   - 中文 / 朝鲜语那档（core/cjk.js）只管非日语行，两边的入口在 main.js 的 extraTokens 里分岔。
 *
 * 为什么要有 kuromoji：歌词里的读音靠单字表必错（今日 きょう、一人 ひとり、生きる いきる
 * 都要看词和活用）。IPADIC 有词形 + 读音，这一层就够用了。
 *
 * 词典是懒加载的：默认不碰那 17 MB 数据，等真正出现日语行、且面板里开着振假名时才读，
 * 读完通过 onReady 通知上层重扫（这时页面上还没注音的行会被补上）。
 *
 * 挂到 globalThis.WKFurigana。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WKFurigana = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /*
   * 运行时依赖：
   *   - kuromoji（vendor/kuromoji.js）与 FuriganaCore（vendor/furigana.js）从全局取；
   *   - 测试里用 configure({ tokenizer }) 直接递一个分词器进来，不必加载 17 MB 词典。
   */
  var injected = { tokenizer: null, core: null, dicPath: null };

  var state = {
    tokenizer: null,
    loading: false,
    error: null,
    loadedAt: 0,
    onReady: null,
  };

  // 行文本 -> 片段（kana 变体也分开缓存：面板切平/片假名不会读到旧的）
  var cache = new Map();
  var CACHE_MAX = 4000;

  function deps() {
    return {
      core: injected.core || (typeof FuriganaCore !== "undefined" ? FuriganaCore : null),
      tokenizer: injected.tokenizer || state.tokenizer,
    };
  }

  function configure(next) {
    next = next || {};
    if (next.tokenizer) state.tokenizer = next.tokenizer;
    if (next.core) injected.core = next.core;
    if (next.dicPath) injected.dicPath = next.dicPath;
    if (next.onReady !== undefined) state.onReady = next.onReady;
    if (next.tokenizer) state.loadedAt = Date.now();
  }

  function ready() {
    return !!deps().tokenizer;
  }

  function status() {
    return {
      ready: ready(),
      loading: state.loading,
      error: state.error ? String(state.error.message || state.error) : null,
      cached: cache.size,
      loadedAt: state.loadedAt,
    };
  }

  /** 插件目录里的 dict/（BetterNCM 会把包解到 pluginPath 下） */
  function guessDicPath() {
    if (injected.dicPath) return injected.dicPath;
    // 打包后词典在 <插件目录>/vendor/dict 下（见 tools/build.js 的 vendorEntries）
    if (typeof plugin !== "undefined" && plugin && plugin.pluginPath) return plugin.pluginPath + "/vendor/dict";
    return "vendor/dict";
  }

  /**
   * 让 kuromoji 用 betterncm.fs 读词典。
   *
   * kuromoji 的浏览器版走 XHR（相对 URL 解析到页面 origin，读不到插件目录），
   * vendor/kuromoji.js 里留了 globalThis.__FURIGANA_DICT_LOADER__ 这个钩子。
   */
  function installLoader() {
    var g = typeof globalThis !== "undefined" ? globalThis : root;
    g.__FURIGANA_DICT_LOADER__ = function (path) {
      if (typeof betterncm === "undefined" || !betterncm.fs) {
        return Promise.reject(new Error("没有 betterncm.fs，读不到词典"));
      }
      return Promise.resolve()
        .then(function () {
          return betterncm.fs.readFile(path);
        })
        .then(function (data) {
          if (data instanceof ArrayBuffer) return data;
          if (data && typeof data.arrayBuffer === "function") return data.arrayBuffer();
          if (data && data.buffer instanceof ArrayBuffer) return data.buffer;
          /*
           * 跨 realm 的 ArrayBuffer / TypedArray（jsdom、iframe 里很常见）过不了
           * instanceof，但字节还在 —— 按 byteLength 兜一层，拷成自己的 buffer。
           */
          if (data && typeof data.byteLength === "number") return new Uint8Array(data).buffer;
          throw new Error("无法识别 betterncm.fs.readFile 的返回类型");
        });
    };
  }

  /**
   * 异步加载词典。失败只记一笔（面板能看到），不影响其它注音功能。
   * @param {function} [onReady] 加载成功后的回调（上层用来重扫）
   */
  function load(onReady) {
    if (onReady) state.onReady = onReady;
    if (ready() || state.loading) return;
    var g = typeof globalThis !== "undefined" ? globalThis : root;
    if (typeof g.kuromoji === "undefined") {
      state.error = new Error("kuromoji 没注入（检查 manifest 的 injects 顺序）");
      return;
    }
    state.loading = true;
    state.error = null;
    installLoader();
    var dicPath = guessDicPath();
    try {
      g.kuromoji.builder({ dicPath: dicPath }).build(function (err, tokenizer) {
        state.loading = false;
        if (err) {
          state.error = err;
          if (typeof console !== "undefined" && console.warn) console.warn("[歌词注音] 振假名词典加载失败：", err);
          return;
        }
        state.tokenizer = tokenizer;
        state.loadedAt = Date.now();
        cache.clear();
        if (state.onReady) {
          try {
            state.onReady();
          } catch (e) {
            /* 上层重扫失败不该影响词典就绪 */
          }
        }
      });
    } catch (e) {
      state.loading = false;
      state.error = e;
    }
  }

  /** 一分钟内只试一次自动加载（词典文件缺失时别每个文本节点都去敲磁盘） */
  var lastAutoLoad = 0;
  function autoLoad(onReady) {
    if (ready() || state.loading) return;
    var now = Date.now();
    if (lastAutoLoad && now - lastAutoLoad < 60000) return;
    lastAutoLoad = now;
    load(onReady);
  }

  function cacheKey(text, kana) {
    return kana + "\u0000" + text;
  }

  function remember(key, segs) {
    if (cache.size >= CACHE_MAX) {
      // Map 保持插入顺序：丢最早的一批
      var drop = cache.size - CACHE_MAX + 1;
      var it = cache.keys();
      for (var i = 0; i < drop; i++) {
        var next = it.next();
        if (next.done) break;
        cache.delete(next.value);
      }
    }
    cache.set(key, segs);
    return segs;
  }

  /**
   * 一行歌词的注音片段。
   *
   * @param {string} text 一行的可见原文
   * @param {{kana?:string}} [opts] kana: "hiragana"（默认）| "katakana"
   * @returns {Array<{text:string,start:number,end:number,kana:string,kind:string}>|null}
   *          词典没就绪 / 没有汉字时返回 null（调用方按"这一行没有振假名"处理）
   */
  function tokens(text, opts) {
    var s = String(text == null ? "" : text);
    if (!s) return null;
    var d = deps();
    if (!d.core || !d.tokenizer) {
      autoLoad();
      return null;
    }
    // 只有数字的行也要注（kuromoji 不给阿拉伯数字读音，由 core/numbers.js 补）
    // 全角数字（１２３）同样算 —— 歌词里经常是全角的
    if (!d.core.hasKanji(s) && !/[0-9\uFF10-\uFF19]/.test(s)) return null;
    var kana = (opts && opts.kana) || "hiragana";
    var key =
      cacheKey(s, kana) +
      "\u0001" +
      fixesKey(opts && opts.fixes) +
      "\u0002" +
      spansKey(opts && opts.spans);
    var hit = cache.get(key);
    if (hit) return hit.length ? hit : null;
    /*
     * 分词直接用原文。中文行（含简体字）不会走到这里 —— main.js 按行分流，
     * 中文行走中文读音那档（core/cjk.js），日文行才进来查日语读音。
     */
    /*
     * 这一行专用的读音修正（调用方按行算好再传进来）。
     *
     * 刻意**不做全局词表**：同一个词在不同句子里读音就不一样
     * （解 と / かい / ほど，明日 あした / あす），钉死一个必然出错。
     * 所以修正只对"这一行"生效，键是行文本里的词。
     */
    var fixed = fixesIn(s, (opts && opts.fixes) || null, kana);
    var suppressed = suppressedIn(s, opts && opts.fixes);
    /*
     * 就地编辑器按**位置**存的那几条（`[[起点, 底字, 读音], ...]`）。
     *
     * 为什么要按位置：同一个字在一行里出现两次时，用户只想改其中一处
     * （`魂辛辛` 里 辛辛 是 からがら，不是 からし + からし）。按"词"存的话
     * 改一处等于把这一行里所有相同的字都改了。
     */
    var spans = spansIn(s, opts && opts.spans, kana);
    // 按位置存的"留空"（编辑器里把读音清空）也要并进 suppressed
    suppressed = suppressed.concat(spansSuppressedIn(s, opts && opts.spans));
    var segs = null;
    /*
     * 全角数字先折成半角再分词（长度一一对应，下标不用换算）。
     *
     * 为什么必须折：kuromoji 只认半角，「３つ」会当成一个无读音的怪词，整行读不出来；
     * 折成「3つ」之后它就能切出「数字 + 助数词」，读音是 みっつ。
     */
    var tokText = s.replace(/[\uFF10-\uFF19]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
    });
    try {
      segs = d.core.tokensToSegments(d.tokenizer.tokenize(tokText), { kana: kana });
    } catch (e) {
      segs = null;
    }
    var out = [];
    for (var f0 = 0; f0 < fixed.length; f0++) {
      var clashed = false;
      for (var sp = 0; sp < spans.length; sp++) {
        if (spans[sp].start < fixed[f0].end && fixed[f0].start < spans[sp].end) {
          clashed = true;
          break;
        }
      }
      if (!clashed) out.push(fixed[f0]);
    }
    for (var sp2 = 0; sp2 < spans.length; sp2++) out.push(spans[sp2]);
    function coveredByFixed(a, b) {
      for (var q = 0; q < out.length; q++) {
        if (out[q].start < b && a < out[q].end) return true;
      }
      return false;
    }
    if (segs && segs.length) {
      for (var i = 0; i < segs.length; i++) {
        var seg = segs[i];
        if (!seg) continue;
        /*
         * 作词者自己写的括号注音「漢字(かな)」：括号那一段标了 hidden —— 它是读法不是歌词，
         * 交给注音层藏起来（否则屏幕上会同时出现假名注音和原句里的括号假名）。
         */
        if (seg.hidden) {
          var hAt = typeof seg.at === "number" ? seg.at : s.indexOf(seg.text);
          if (hAt >= 0 && seg.text) {
            out.push({ text: s.substr(hAt, seg.text.length) || seg.text, start: hAt, end: hAt + seg.text.length, hide: true, kind: "hide" });
          }
          continue;
        }
        if (!seg.rt) {
          /*
           * 词典对这几个字一个读音都没给（表外字 / 生词：掻 / 謎 / 轍）。
           * 逐字探一次：拿这个字去喂"字 + 送假名"的各种写法，看词典给出的读音里
           * 有没有一致的 —— `掻く` `掻き` 都读 か，就按 か 注。
           *
           * 为什么值得做：这类字以前整段留白（真机现象：「掻鳴らせ」的 掻 一直空着），
           * 而它们恰恰是歌词里最需要注音的那批字。宁可给出一个一致的猜测，
           * 也不要在屏幕上空着。探不出来的（霽 / 燦 这种词典里根本没有的）仍然留白，
           * 交给大模型（见 candidates 的 no-reading）。
           */
          var nat = typeof seg.at === "number" ? seg.at : s.indexOf(seg.text);
          if (nat >= 0 && seg.text) {
            for (var pc = 0; pc < seg.text.length; pc++) {
              var ch = seg.text.charAt(pc);
              if (!/[\u4E00-\u9FFF\u3005]/.test(ch)) continue;
              if (coveredByFixed(nat + pc, nat + pc + 1)) continue;
              var pr = probeKanjiReading(ch);
              if (!pr) continue;
              out.push({
                text: s.substr(nat + pc, 1),
                start: nat + pc,
                end: nat + pc + 1,
                kana: toKanaMode(pr, kana),
                kind: "probe",
              });
            }
          }
          continue; // 没有读音的片段（标点 / 假名 / 拉丁）不注
        }
        // at 是这一片段在整行里的起点；长度按底字算
        var at = typeof seg.at === "number" ? seg.at : s.indexOf(seg.text);
        if (at < 0) continue;
        // 底字取原文那一段（位置一一对应），读音来自换过写法的分词结果
        var text0 = s.substr(at, seg.text.length);
        if (!text0) continue;
        /*
         * 数字 + 假名（`1つ` ひとつ / `2人` ふたり / `10日` とおか）：
         * 只给数字那一小段注音，后面的假名留在底字外面。
         *
         * 为什么：假名本来就会读，再盖一层注音（真机现象：「1つ」的 つ 上面
         * 也顶着一层假名）纯属噪音。后面跟的是**汉字**时（10日）就不能截 ——
         * 汉字自己需要读音，截掉就漏标了。
         */
        var baseLen = text0.length;
        if (seg.num && seg.num.len > 0 && seg.num.len < baseLen) {
          if (!/[\u4E00-\u9FFF\u3400-\u4DBF\u3005]/.test(text0.slice(seg.num.len))) baseLen = seg.num.len;
        }
        text0 = text0.slice(0, baseLen);
        if (!text0) continue;
        if (coveredByFixed(at, at + text0.length)) continue; // 用户已经指定了这段怎么读
        var gone = false;
        for (var q2 = 0; q2 < suppressed.length; q2++) {
          if (suppressed[q2][0] < at + text0.length && at < suppressed[q2][1]) {
            gone = true;
            break;
          }
        }
        if (gone) continue; // 用户把这段的注音留空了
        out.push({ text: text0, start: at, end: at + text0.length, kana: seg.rt, kind: "kanji" });
      }
    }
    /*
     * 数字：kuromoji 对阿拉伯数字不给读音（`105` 的 reading 是 `*`），这里自己补。
     * 已经有读音的段（`1つ` ひとつ）不重复注：跟它重叠的数字段跳过。
     */
    if (typeof WKNumbers !== "undefined" && WKNumbers.reading) {
      var runs = WKNumbers.scan(s);
      for (var r = 0; r < runs.length; r++) {
        var run = runs[r];
        var covered = false;
        for (var q = 0; q < out.length; q++) {
          if (out[q].start < run.end && run.start < out[q].end) {
            covered = true;
            break;
          }
        }
        if (covered) continue;
        var numGone = false;
        for (var q3 = 0; q3 < suppressed.length; q3++) {
          if (suppressed[q3][0] < run.end && run.start < suppressed[q3][1]) {
            numGone = true;
            break;
          }
        }
        if (numGone) continue;
        var numKana = WKNumbers.reading(run.text);
        if (!numKana) continue;
        out.push({
          text: run.text,
          start: run.start,
          end: run.end,
          kana: kana === "katakana" ? numKana : numKana.replace(/[\u30A1-\u30F6]/g, function (c) {
            return String.fromCharCode(c.charCodeAt(0) - 0x60);
          }),
          kind: "num",
        });
      }
      out.sort(function (a, b) {
        return a.start - b.start;
      });
    }
    remember(key, out);
    return out.length ? out : null;
  }

  /**
   * 这一行里"该问模型"的汉字段：(a) 词典没给出读音，(b) 读音跟官方音译对不上。
   *
   * @param {string} text 一行原文
   * @param {string} [romaji] 同一行的官方音译（NCM 的罗马音层），没有就不比较
   * @param {{kana?:string}} [opts]
   * @returns {Array<{text:string,start:number,end:number,why:string}>}
   */
  function candidates(text, romaji, opts) {
    var s = String(text == null ? "" : text);
    if (!s) return [];
    var d = deps();
    if (!d.core || !d.tokenizer) return [];
    var kana = (opts && opts.kana) || "hiragana";
    var toks = tokens(s, { kana: kana }) || [];
    var out = [];
    /*
     * (a) 没读音：**逐字**看有没有被 tokens() 覆盖。
     *
     * 为什么按字不按整段：`掻鳴らせ` 里 鳴 有读音、掻 没有，整段比的话"有交集=覆盖"，
     * 掻 就被判成"已经注过了"，永远不会去问模型（真机现象：掻 一直空着）。
     * 连着的几个没读音的字合成一条（`謎謎` 问一次就够）。
     */
    var re = /[\u4E00-\u9FFF\u3005]/g;
    var m;
    var run = null;
    while ((m = re.exec(s))) {
      var a = m.index;
      var b = a + 1;
      var covered = false;
      for (var i = 0; i < toks.length; i++) {
        if (toks[i].start <= a && a < toks[i].end) {
          covered = true;
          break;
        }
      }
      if (covered) {
        if (run) {
          out.push(run);
          run = null;
        }
        continue;
      }
      if (run && run.end === a) {
        run.end = b;
        run.text = s.slice(run.start, b);
      } else {
        if (run) out.push(run);
        run = { text: m[0], start: a, end: b, why: "no-reading" };
      }
    }
    if (run) out.push(run);
    /*
     * (b) 跟音译对不上：用官方的罗马音推一遍读音，跟词典给的比。
     * 只比"两边都读得出来"的段 —— 一边空的交给 (a)。
     */
    if (romaji && d.core.romajiToKana && d.core.segmentsFromReading) {
      var rk = null;
      try {
        rk = d.core.romajiToKana(String(romaji));
      } catch (e) {
        rk = null;
      }
      if (rk) {
        var derived = null;
        try {
          derived = d.core.segmentsFromReading(s, rk, d.core.tokensToSegments(d.tokenizer.tokenize(s), { kana: kana }), { kana: kana });
        } catch (e2) {
          derived = null;
        }
        if (derived && derived.length) {
          for (var q = 0; q < derived.length; q++) {
            var seg = derived[q];
            if (!seg || !seg.rt) continue;
            var at = typeof seg.at === "number" ? seg.at : s.indexOf(seg.text);
            if (at < 0) continue;
            var mine = null;
            for (var t = 0; t < toks.length; t++) {
              if (toks[t].start === at) {
                mine = toks[t];
                break;
              }
            }
            if (!mine) continue;
            if (sameReading(mine.kana, seg.rt)) continue;
            out.push({ text: mine.text, start: mine.start, end: mine.end, why: "romaji-mismatch" });
          }
        }
      }
    }
    return out;
  }

  /** 两边读音比一下：长音、促音、浊音的写法差异不算"对不上" */
  function sameReading(a, b) {
    var norm = function (x) {
      return String(x == null ? "" : x)
        .replace(/[\u30A1-\u30F6]/g, function (c) {
          return String.fromCharCode(c.charCodeAt(0) - 0x60);
        })
        .replace(/ー/g, "")
        .replace(/っ/g, "")
        .replace(/[\u3099\u309A]/g, "");
    };
    var x = norm(a);
    var y = norm(b);
    if (!x || !y) return false;
    return x === y || x.indexOf(y) >= 0 || y.indexOf(x) >= 0;
  }

  /*
   * 单个汉字的读音：拿它去喂"字 + 送假名"的几种写法，看词典给出的一不一致。
   *
   * 只用来兜"词典对这个字在**这一行**里给不出读音"那种情况（表外字 / 生词）。
   * 例：掻 单独 IPADIC 没有读音，但 掻く / 掻き 都是 か → 取 か。
   * 探不出来（霽 / 燦 这种词典里根本没有的）返回 null，留给大模型。
   *
   * 结论按字缓存（探一次要分词十来次，别每轮都做）。
   */
  var probeCache = new Map();
  var PROBE_TAILS = ["く", "き", "る", "れ", "す", "つ", "う", "い", "む"];
  function probeKanjiReading(ch) {
    if (!ch) return null;
    if (probeCache.has(ch)) return probeCache.get(ch);
    var d = deps();
    var best = null;
    if (d.core && d.tokenizer) {
      var counts = {};
      for (var i = 0; i < PROBE_TAILS.length; i++) {
        var segs = null;
        try {
          segs = d.core.tokensToSegments(d.tokenizer.tokenize(ch + PROBE_TAILS[i]), { kana: "katakana" });
        } catch (e) {
          segs = null;
        }
        if (!segs) continue;
        for (var j = 0; j < segs.length; j++) {
          var sg = segs[j];
          if (!sg || !sg.rt) continue;
          if (!sg.text || sg.text.charAt(0) !== ch) continue;
          // 读音必须是纯假名、而且短（一个字最多三拍）
          if (!/^[\u30A1-\u30F6\u30FC]{1,3}$/.test(sg.rt)) continue;
          counts[sg.rt] = (counts[sg.rt] || 0) + 1;
        }
      }
      var bestN = 0;
      for (var k in counts) {
        if (Object.prototype.hasOwnProperty.call(counts, k) && counts[k] > bestN) {
          bestN = counts[k];
          best = k;
        }
      }
      // 至少两种写法一致才算数（只命中一种可能只是那个词的特例）
      if (bestN < 2) best = null;
    }
    probeCache.set(ch, best);
    return best;
  }

  /** 平假名 / 片假名互转（用户两种写法都可能填） */
  function toKanaMode(kana, mode) {    var t = String(kana == null ? "" : kana);
    if (mode === "katakana") {
      return t.replace(/[\u3041-\u3096]/g, function (c) {
        return String.fromCharCode(c.charCodeAt(0) + 0x60);
      });
    }
    return t.replace(/[\u30A1-\u30F6]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0x60);
    });
  }

  /** {词: 读音} -> 稳定的字符串（进缓存键） */
  function fixesKey(fixes) {
    if (!fixes) return "";
    var keys = [];
    for (var k in fixes) if (Object.prototype.hasOwnProperty.call(fixes, k)) keys.push(k);
    keys.sort();
    var out = "";
    for (var i = 0; i < keys.length; i++) out += keys[i] + "=" + fixes[keys[i]] + ";";
    return out;
  }

  /** [[起点, 底字, 读音], ...] -> 稳定的字符串（进缓存键） */
  function spansKey(spans) {
    if (!spans || !spans.length) return "";
    var parts = [];
    for (var i = 0; i < spans.length; i++) {
      var sp = spans[i];
      if (!sp) continue;
      parts.push(String(sp[0]) + ":" + String(sp[1]) + "=" + String(sp[2]));
    }
    parts.sort();
    return parts.join(";");
  }

  /**
   * 按位置存的修正：`[[起点, 底字, 读音], ...]`（就地编辑器写的）。
   *
   * 起点在整行里对不上（用户改了别的行 / 行文本变了）就整条丢掉 ——
   * 宁可回到词典读音，也不要把读音安到错的位置上。
   */
  function spansIn(s, spans, mode) {
    var out = [];
    if (!spans || !spans.length) return out;
    for (var i = 0; i < spans.length; i++) {
      var sp = spans[i];
      if (!sp) continue;
      var at = typeof sp[0] === "number" ? sp[0] : parseInt(sp[0], 10);
      var word = String(sp[1] == null ? "" : sp[1]);
      var kana = String(sp[2] == null ? "" : sp[2]).trim();
      if (!(at >= 0) || !word) continue;
      if (!kana) continue; // 空读音 = 留空，交给 suppress
      if (s.substr(at, word.length) !== word) continue; // 位置对不上：这条作废
      out.push({ text: word, start: at, end: at + word.length, kana: toKanaMode(kana, mode), kind: "inline" });
    }
    out.sort(function (a, b) {
      return a.start - b.start;
    });
    return out;
  }

  /** 按位置存的"留空"条目占的区间（读音写成空串 = 这一段不注音） */
  function spansSuppressedIn(s, spans) {
    var out = [];
    if (!spans || !spans.length) return out;
    for (var i = 0; i < spans.length; i++) {
      var sp = spans[i];
      if (!sp) continue;
      var at = typeof sp[0] === "number" ? sp[0] : parseInt(sp[0], 10);
      var word = String(sp[1] == null ? "" : sp[1]);
      var kana = String(sp[2] == null ? "" : sp[2]).trim();
      if (!(at >= 0) || !word || kana) continue;
      if (s.substr(at, word.length) !== word) continue;
      out.push([at, at + word.length]);
    }
    return out;
  }

  /**
   * 把"这一行的读音修正"套到行文本上：长的词先匹配，重叠的跳过。
   * @param {string} s 行文本
   * @param {Object} fixes {词: 假名}
   * @param {string} mode hiragana | katakana
   */
  function fixesIn(s, fixes, mode) {
    var out = [];
    if (!fixes) return out;
    var list = [];
    for (var k in fixes) if (Object.prototype.hasOwnProperty.call(fixes, k)) list.push([k, fixes[k]]);
    list.sort(function (a, b) {
      return b[0].length - a[0].length;
    });
    var taken = [];
    for (var i = 0; i < list.length; i++) {
      var word = list[i][0];
      var kana = String(list[i][1] || "").trim();
      if (!word) continue;
      if (!kana) continue; // 空读音 = 留空，交给调用方按 suppress 处理
      var from = 0;
      while (from <= s.length - word.length) {
        var at = s.indexOf(word, from);
        if (at < 0) break;
        from = at + 1;
        var clash = false;
        for (var t = 0; t < taken.length; t++) {
          if (taken[t][0] < at + word.length && at < taken[t][1]) {
            clash = true;
            break;
          }
        }
        if (clash) continue;
        taken.push([at, at + word.length]);
        out.push({ text: word, start: at, end: at + word.length, kana: toKanaMode(kana, mode), kind: "override" });
      }
    }
    out.sort(function (a, b) {
      return a.start - b.start;
    });
    return out;
  }

  /** fixes 里"值为空"的词 = 这一行不要注音，返回它们占的区间 */
  function suppressedIn(s, fixes) {
    var out = [];
    if (!fixes) return out;
    for (var k in fixes) {
      if (!Object.prototype.hasOwnProperty.call(fixes, k)) continue;
      if (String(fixes[k] == null ? "" : fixes[k]).trim()) continue;
      if (!k) continue;
      var from = 0;
      while (from <= s.length - k.length) {
        var at = s.indexOf(k, from);
        if (at < 0) break;
        from = at + 1;
        out.push([at, at + k.length]);
      }
    }
    return out;
  }

  function clearCache() {
    cache.clear();
  }

  return {
    configure: configure,
    load: load,
    autoLoad: autoLoad,
    ready: ready,
    status: status,
    tokens: tokens,
    clearCache: clearCache,
    candidates: candidates,
    /** 给测试用：直接塞一个分词器 */
    setTokenizer: function (tokenizer) {
      state.tokenizer = tokenizer;
      state.loadedAt = Date.now();
      cache.clear();
    },
  };
});
