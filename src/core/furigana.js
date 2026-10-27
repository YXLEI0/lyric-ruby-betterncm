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
    if (!d.core.hasKanji(s)) return null;
    var kana = (opts && opts.kana) || "hiragana";
    var key = cacheKey(s, kana);
    var hit = cache.get(key);
    if (hit) return hit.length ? hit : null;
    /*
     * 分词直接用原文。中文行（含简体字）不会走到这里 —— main.js 按行分流，
     * 中文行走中文读音那档（core/cjk.js），日文行才进来查日语读音。
     */
    var segs = null;
    try {
      segs = d.core.tokensToSegments(d.tokenizer.tokenize(s), { kana: kana });
    } catch (e) {
      segs = null;
    }
    var out = [];
    if (segs && segs.length) {
      for (var i = 0; i < segs.length; i++) {
        var seg = segs[i];
        if (!seg || seg.hidden) continue;
        if (!seg.rt) continue; // 没有读音的片段（标点 / 假名 / 拉丁）不注
        // at 是这一片段在整行里的起点；长度按底字算
        var at = typeof seg.at === "number" ? seg.at : s.indexOf(seg.text);
        if (at < 0) continue;
        // 底字取原文那一段（位置一一对应），读音来自换过写法的分词结果
        var text0 = s.substr(at, seg.text.length);
        if (!text0) continue;
        out.push({ text: text0, start: at, end: at + text0.length, kana: seg.rt, kind: "kanji" });
      }
    }
    remember(key, out);
    return out.length ? out : null;
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
    /** 给测试用：直接塞一个分词器 */
    setTokenizer: function (tokenizer) {
      state.tokenizer = tokenizer;
      state.loadedAt = Date.now();
      cache.clear();
    },
  };
});
