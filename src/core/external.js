/*
 * 外部网站读音来源（UtaTen）：搜索结果 / 歌词页的解析，以及"网站行 -> 当前歌词行"的对齐。
 *
 * 为什么不直接 fetch：UtaTen 要求站点 Referer，而且跨域请求会被浏览器的 CORS 拦住。
 * 真正的请求由 main.js 用一个 utaten.com 的隐形 iframe 发（见 fetchExternalHtml），
 * 这里只做纯文本/HTML 的解析与对齐 —— 测试里可以拿一段固定 HTML 直接验。
 *
 * 挂到 globalThis.WKExternal。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WKExternal = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /*
   * 「读音」不一定全是假名：UtaTen 里 `口吻` 这种词标的就是拉丁字母（`kiss`），
   * 网站原样显示在注音位置上。只认假名会把这类读音整条丢掉，页面上就只剩光秃秃的底字。
   */
  var KANA = /^[\u3041-\u3096\u30A1-\u30FA\u30FC\u30FB]+$|^[A-Za-z][A-Za-z'’.\-\s]*$/;

  function str(v) {
    return String(v == null ? "" : v);
  }

  /** 比较用的键：去掉空白（全角空格也算），不分大小写 */
  function keyOf(s) {
    return str(s).replace(/[\s\u3000]+/g, "").toLowerCase();
  }

  function allowedURL(value) {
    try {
      var u = new URL(str(value));
      return (
        u.protocol === "https:" &&
        !u.username &&
        !u.password &&
        (u.hostname === "utaten.com" ||
          u.hostname === "www.utaten.com" ||
          u.hostname === "uta-net.com" ||
          u.hostname === "www.uta-net.com")
      );
    } catch (e) {
      return false;
    }
  }

  /** 这个地址是哪一家（utaten / utanet / ""） */
  function providerOfURL(value) {
    try {
      var u = new URL(str(value));
      if (u.hostname === "utaten.com" || u.hostname === "www.utaten.com") return "utaten";
      if (u.hostname === "uta-net.com" || u.hostname === "www.uta-net.com") return "utanet";
    } catch (e) {
      /* 不是 URL */
    }
    return "";
  }

  function docOf(html) {
    if (typeof DOMParser === "undefined") throw new Error("没有 DOMParser");
    return new DOMParser().parseFromString(str(html), "text/html");
  }

  /** 搜索结果页的候选（歌名 / 歌手 / 歌词页地址） */
  function parseSearch(html, provider) {
    var doc = docOf(html);
    var out = [];
    var p = provider === "utanet" ? "utanet" : "utaten";
    /*
     * 两家的搜索结果结构完全不同：
     *   UtaTen：`.searchResult__title a`，歌手在 `.searchResult__artist > p a`
     *   Uta-net：歌词页链接是 `a[href^="/song/"]`，歌手是 `a[href^="/artist/"]`
     * 都要求在一行（tr）里，避免把侧栏推荐当成候选。
     */
    var selector = p === "utanet" ? 'a[href^="/song/"]' : ".searchResult__title a[href]";
    var base = p === "utanet" ? "https://www.uta-net.com/" : "https://utaten.com/";
    var links = doc.querySelectorAll(selector);
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var row = a.closest ? a.closest("tr") : null;
      if (!row) continue;
      var title = (a.querySelector(".songlist-title") || a).textContent || "";
      title = title.replace(/^\s+|\s+$/g, "");
      var url = "";
      try {
        url = new URL(a.getAttribute("href"), base).href;
      } catch (e) {
        url = "";
      }
      if (!title || !url || !allowedURL(url)) continue;
      var dup = false;
      for (var d = 0; d < out.length; d++) if (out[d].url === url) dup = true;
      if (dup) continue;
      var artists = [];
      var artistNodes = row.querySelectorAll(p === "utanet" ? 'a[href^="/artist/"]' : ".searchResult__artist > p a");
      for (var j = 0; j < artistNodes.length; j++) {
        var at = artistNodes[j].textContent || "";
        at = at.replace(/^\s+|\s+$/g, "");
        if (at) artists.push(at);
      }
      out.push({ title: title, artists: artists, url: url });
    }
    return out;
  }

  /** 歌词页：`.lyricBody .hiragana` 里一个 ruby 一个词，返回每行的 segments */
  function parseLyric(html, url) {
    var doc = docOf(html);
    var block = doc.querySelector(".lyricBody .hiragana");
    if (!block) throw new Error("UtaTen 页面没有振假名歌词");
    var titleNode = doc.querySelector(".newLyricTitle__main");
    var title = "";
    if (titleNode) {
      var copy = titleNode.cloneNode(true);
      var spans = copy.querySelectorAll("span");
      for (var s = 0; s < spans.length; s++) if (spans[s].parentNode) spans[s].parentNode.removeChild(spans[s]);
      title = (copy.textContent || "").replace(/^\s+|\s+$/g, "");
    }
    var artists = [];
    var artistNodes = doc.querySelectorAll('h3 a[href^="/artist/"]');
    for (var a = 0; a < artistNodes.length; a++) {
      var at = (artistNodes[a].textContent || "").replace(/^\s+|\s+$/g, "");
      if (at) artists.push(at);
    }

    var lines = [];
    var segments = [];
    function flush() {
      if (!segments.length) return;
      segments[0].text = segments[0].text.replace(/^\s+/, "");
      var last = segments.length - 1;
      segments[last].text = segments[last].text.replace(/\s+$/, "");
      var kept = [];
      for (var i = 0; i < segments.length; i++) if (segments[i].text) kept.push(segments[i]);
      var text = "";
      for (var k = 0; k < kept.length; k++) text += kept[k].text;
      if (text) lines.push({ text: text, segments: kept });
      segments = [];
    }
    function walk(node) {
      if (node.nodeType === 3) {
        var t = str(node.nodeValue).replace(/[\r\n]+/g, "");
        if (t) segments.push({ text: t });
        return;
      }
      if (node.nodeType !== 1) return;
      var name = node.nodeName;
      if (name === "SCRIPT" || name === "STYLE" || name === "IFRAME") return;
      if (name === "BR") {
        flush();
        return;
      }
      var cls = typeof node.className === "string" ? node.className : "";
      if (name === "RUBY" || /(^|\s)ruby(\s|$)/.test(cls)) {
        var rb = node.querySelector(".rb, rb");
        var rt = node.querySelector(".rt, rt");
        if (rb && rt) {
          var reading = str(rt.textContent).replace(/^\s+|\s+$/g, "").replace(/[\s\u3000・]/g, "");
          var base = str(rb.textContent);
          if (base) {
            if (reading && KANA.test(reading)) segments.push({ text: base, rt: reading });
            else segments.push({ text: base });
          }
          return;
        }
      }
      for (var c = 0; c < node.childNodes.length; c++) walk(node.childNodes[c]);
    }
    walk(block);
    flush();
    var hasReading = false;
    for (var i = 0; i < lines.length; i++) {
      for (var j = 0; j < lines[i].segments.length; j++) if (lines[i].segments[j].rt) hasReading = true;
    }
    if (!hasReading) throw new Error("UtaTen 没有可用读音");
    return { provider: "utaten", url: str(url), title: title, artists: artists, lines: lines };
  }

  /**
   * Uta-net 的歌词页：日文在 `#kashi-area`，罗马音在 `#kashi-area-roma`，
   * **两边的行是一一对应的**（这是它唯一能用的读音来源）。
   * 行数对不上就不收 —— 错一行的代价是整首错位。
   */
  function textLines(el) {
    if (!el) return [];
    var copy = el.cloneNode(true);
    var junk = copy.querySelectorAll("script,style,iframe");
    for (var j = 0; j < junk.length; j++) if (junk[j].parentNode) junk[j].parentNode.removeChild(junk[j]);
    var brs = copy.querySelectorAll("br");
    for (var b = 0; b < brs.length; b++) {
      var nl = copy.ownerDocument.createTextNode("\n");
      brs[b].parentNode.replaceChild(nl, brs[b]);
    }
    var parts = String(copy.textContent || "").split(/\r?\n/);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var t = parts[i].replace(/^\s+|\s+$/g, "");
      if (t) out.push(t);
    }
    return out;
  }

  function parseUtanet(html, url, candidate) {
    var doc = docOf(html);
    var jp = textLines(doc.querySelector("#kashi-area"));
    var roma = textLines(doc.querySelector("#kashi-area-roma"));
    if (!jp.length || jp.length !== roma.length) {
      throw new Error("Uta-net 日文与罗马音行数对不上");
    }
    var artists = [];
    var nodes = doc.querySelectorAll("h1 .artist-name");
    for (var a = 0; a < nodes.length; a++) {
      var at = (nodes[a].textContent || "").replace(/^\s+|\s+$/g, "");
      if (at) artists.push(at);
    }
    var heading = doc.querySelector("h1 > span:first-child");
    var title = heading ? (heading.textContent || "").replace(/^\s+|\s+$/g, "") : "";
    if (!title || !artists.length) throw new Error("Uta-net 歌曲信息读不出来");
    if (candidate && candidate.title && keyOf(title) !== keyOf(candidate.title)) {
      throw new Error("Uta-net 歌名对不上");
    }
    var lines = [];
    for (var i = 0; i < jp.length; i++) lines.push({ text: jp[i], romaji: roma[i] });
    return {
      provider: "utanet",
      url: str(url),
      title: candidate && candidate.title ? candidate.title : title,
      artists: artists,
      lines: lines,
    };
  }

  /** 去掉空白后的文本 + 每个字在原文里的下标（对齐用） */
  function compact(text) {
    var s = str(text);
    var out = "";
    var map = [];
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (/[\s\u3000]/.test(ch)) continue;
      out += ch;
      map.push(i);
    }
    return { text: out, map: map };
  }

  /**
   * 把网站歌词做成"去空白后的整行 -> 读音片段"的索引。
   * 同一行出现两次但读音不同（副歌重复、写法差异）就不收录 —— 宁可不套，也不套错。
   *
   * 两家的结构不一样：
   *   UtaTen：每行 `segments`（带 rt 的片段）→ 直接切出读音
   *   Uta-net：每行只有 `romaji`（整行罗马音）→ 注音时再对齐成读音（见 main.js）
   *
   * 索引里同时收**连续 2~3 行拼起来**的版本：网易云的歌词行常常比网站长
   * （`光、未来` + `相のうた 追う` 在客户端是一行），只按单行索引就永远对不上，
   * 整行退回词典 —— 真机现象就是 `相` 被读成 そう（未来相 みらいそう）而不是网站给的 あい。
   */
  function buildIndex(record) {
    var entries = {};
    if (!record || !record.lines) return { entries: entries, count: 0, provider: "" };
    var provider = record.provider === "utanet" ? "utanet" : "utaten";
    var prepared = [];
    for (var i = 0; i < record.lines.length; i++) {
      prepared.push(prepareLine(record.lines[i], provider));
    }
    var count = prepared.length;

    function put(text, stamp, entry) {
      if (!text) return;
      if (Object.prototype.hasOwnProperty.call(entries, text)) {
        var old = entries[text];
        var oldStamp = old ? old.stamp : null;
        if (oldStamp !== stamp) entries[text] = null;
        return;
      }
      entry.stamp = stamp;
      entries[text] = entry;
    }

    for (var from = 0; from < count; from++) {
      var first = prepared[from];
      if (!first) continue;
      // 单行
      put(first.text, first.stamp, first.entry);
      // 连续 2~3 行拼成一行（客户端长行）；任一行拼不上就停
      var joined = first.text;
      var segs = first.segs ? first.segs.slice() : null;
      var romaji = first.romaji || null;
      for (var n = 2; n <= 3 && from + n - 1 < count; n++) {
        var next = prepared[from + n - 1];
        if (!next) break;
        if (segs && next.segs) {
          var shift = joined.length;
          var merged = segs.slice();
          for (var k = 0; k < next.segs.length; k++) {
            merged.push({ from: next.segs[k].from + shift, to: next.segs[k].to + shift, rt: next.segs[k].rt });
          }
          segs = merged;
          var mergedStamp = JSON.stringify(merged);
          put(joined + next.text, mergedStamp, { segs: merged, provider: provider });
        } else if (romaji && next.romaji) {
          romaji = romaji + " " + next.romaji;
          put(joined + next.text, romaji, { romaji: romaji, provider: provider });
        } else {
          break;
        }
        joined += next.text;
      }
    }
    /*
     * 再做两份"归一化"索引（新旧字形折过、去空白）：
     *   canonMap  —— 折过的整行文本 -> 条目（完全一致那一档）
     *   canonList —— 数组，用来找"客户端这行是网站那一行的中间一段"
     * 都只收有读音片段（segs）的条目：Uta-net 那种只有罗马音的走另一条路。
     */
    var canonMap = {};
    var canonList = [];
    for (var t in entries) {
      if (!Object.prototype.hasOwnProperty.call(entries, t)) continue;
      var e = entries[t];
      if (!e || !e.segs || !e.segs.length) continue;
      var key = canon(t);
      if (Object.prototype.hasOwnProperty.call(canonMap, key)) {
        var prev = canonMap[key];
        if (!prev || JSON.stringify(prev.segs) !== JSON.stringify(e.segs)) canonMap[key] = null;
      } else {
        canonMap[key] = e;
      }
      canonList.push({ key: key, segs: e.segs });
    }
    return { entries: entries, count: count, provider: provider, canonMap: canonMap, canonList: canonList };
  }

  /** 一行网站歌词 -> 去空白文本 + 读音片段（对不上返回 null） */
  function prepareLine(line, provider) {
    if (!line || !line.text) return null;
    var c = compact(line.text);
    if (!c.text) return null;
    if (provider === "utanet") {
      if (typeof line.romaji !== "string" || !line.romaji) return null;
      return { text: c.text, romaji: line.romaji, stamp: line.romaji, entry: { romaji: line.romaji, provider: provider } };
    }
    if (!line.segments) return null;
    var segs = [];
    var cur = 0;
    for (var j = 0; j < line.segments.length; j++) {
      var seg = line.segments[j];
      var sc = compact(seg.text);
      if (seg.rt && sc.text.length) segs.push({ from: cur, to: cur + sc.text.length, rt: seg.rt });
      cur += sc.text.length;
    }
    if (cur !== c.text.length) return null; // 片段拼起来和整行对不上，不要
    return { text: c.text, segs: segs, stamp: JSON.stringify(segs), entry: { segs: segs, provider: provider } };
  }

  /**
   * 当前歌词行在网站索引里的读音 token（对不上返回 null）。
   *
   * 关键：下标必须用**当前这一行**的空白映射（c.map），不能用网站那一行的。
   * 两行去掉空白后一模一样才配对，但空白的**位置**可以不同 ——
   * RNP 会在词之间插空格（`内緒話も 独り言も`），网站那行没有空格。
   * 拿网站的下标去切当前行，整体右移一格：`独` 的读音落到空格上、
   * `言` 的读音落到 `り` 上 —— 真机现象就是行里多出一个"ひと"、り 顶着 ごと。
   */
  function tokensFor(lineText, index) {
    var hit = matchEntry(lineText, index);
    if (!hit) return null;
    var text = str(lineText);
    var out = [];
    for (var i = 0; i < hit.segs.length; i++) {
      var seg = hit.segs[i];
      if (!(seg.to > seg.from)) continue;
      var from = Math.max(0, seg.from);
      var to = Math.min(hit.map.length, seg.to);
      if (!(to > from)) continue;
      var start = hit.map[from];
      var end = hit.map[to - 1] + 1;
      if (!(start >= 0) || !(end > start)) continue;
      out.push({ text: text.slice(start, end), start: start, end: end, kana: seg.rt });
    }
    return out.length ? out : null;
  }

  /**
   * 把当前歌词行对到网站上那一行，返回 { segs, map }。
   *
   * 三种写法差异都要认：
   *   ① 括号读音（`MY HEART(マイココロ)`）是客户端才有的 —— 对齐时连括号一起去掉；
   *   ② 客户端只切了网站那一行的**一段**：网站 `惹かれ 逢って 存在 綴る セカイ 共鳴らせたなら`、
   *      客户端只有 `綴る セカイ 共鳴らせたなら`（后面 / 中间那截都算）——
   *      取落在本行里的那几段；
   *   ③ 新旧字形：网站写 `警鐘亂打`、客户端写 `警鐘乱打` —— 折成同一个字再比。
   *      几个候选给出的读音必须完全一致，不一致就宁可不套（副歌重复、写法差异）。
   */
  function matchEntry(lineText, index) {
    if (!index || !index.entries) return null;
    var c = stripInlineBrackets(lineText);
    if (!c.text) return null;
    var key = canon(c.text);
    // ① 完全一样（字形差异已经折过）
    var exact = index.canonMap && index.canonMap[key];
    if (exact && exact.segs && exact.segs.length) return { segs: exact.segs, map: c.map };
    if (key.length < 3) return null; // 太短的行（标点 / 语气词）套上去只会套错
    /*
     * ② 这一段在网站某一行的中间：把那一行的读音片段整体平移过来，只留落在本行里的。
     */
    var list = index.canonList || [];
    var hit = null;
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var at = e.key.indexOf(key);
      if (at < 0) continue;
      var segs = [];
      for (var j = 0; j < e.segs.length; j++) {
        var from = e.segs[j].from - at;
        var to = e.segs[j].to - at;
        if (to <= 0 || from >= key.length) continue;
        segs.push({ from: Math.max(0, from), to: Math.min(key.length, to), rt: e.segs[j].rt });
      }
      if (!segs.length) continue;
      var stamp = JSON.stringify(segs);
      if (!hit) hit = { segs: segs, stamp: stamp, map: c.map };
      else if (hit.stamp !== stamp) return null; // 几个候选读音不一样，别猜
    }
    return hit ? { segs: hit.segs, map: hit.map } : null;
  }

  /**
   * 新旧字形折叠：网站常用舊字體（亂 / 體 / 學…），客户端是常用漢字。
   * 一对一替换，长度不变 —— 下标可以直接沿用。
   */
  var VARIANT_CHARS = {
    亂: "乱", 體: "体", 學: "学", 樂: "楽", 氣: "気", 燈: "灯", 戰: "戦", 劍: "剣",
    歲: "歳", 齒: "歯", 櫻: "桜", 龍: "竜", 藝: "芸", 廣: "広", 邊: "辺", 變: "変",
    滿: "満", 靜: "静", 德: "徳", 關: "関", 驛: "駅", 鹽: "塩", 歐: "欧", 彈: "弾",
    擴: "拡", 隱: "隠", 濕: "湿", 燒: "焼", 說: "説", 讀: "読", 實: "実", 對: "対",
    當: "当", 爭: "争", 緣: "縁", 譽: "誉", 譯: "訳", 綠: "緑", 雙: "双", 雜: "雑",
    黃: "黄", 黑: "黒", 點: "点", 麵: "麺", 戶: "戸", 亞: "亜",
  };
  function canon(s) {
    var t = str(s);
    var out = "";
    for (var i = 0; i < t.length; i++) {
      var ch = t.charAt(i);
      out += Object.prototype.hasOwnProperty.call(VARIANT_CHARS, ch) ? VARIANT_CHARS[ch] : ch;
    }
    return out;
  }

  /** 去掉括号读音（`(かな)`）和空白后的匹配文本 + 每个字在原文里的下标 */
  var RE_INLINE_BRACKET = /[（(][ \t\u3000]*[\u3041-\u3096\u30A1-\u30FA\u30FC\u30FB]{1,24}[ \t\u3000]*[）)]/g;
  function stripInlineBrackets(text) {
    var s = str(text);
    var hidden = [];
    RE_INLINE_BRACKET.lastIndex = 0;
    var m;
    while ((m = RE_INLINE_BRACKET.exec(s))) hidden.push([m.index, m.index + m[0].length]);
    var out = "";
    var map = [];
    for (var i = 0; i < s.length; i++) {
      var hid = false;
      for (var h = 0; h < hidden.length; h++) {
        if (i >= hidden[h][0] && i < hidden[h][1]) {
          hid = true;
          break;
        }
      }
      if (hid) continue;
      if (/[\s\u3000]/.test(s.charAt(i))) continue;
      out += s.charAt(i);
      map.push(i);
    }
    return { text: out, map: map };
  }

  /** Uta-net：这一行的罗马音（对不上返回 ""；括号读音同样不算） */
  function romajiFor(lineText, index) {
    if (!index || !index.entries) return "";
    var c = stripInlineBrackets(lineText);
    if (!c.text) return "";
    var e = index.entries[c.text];
    return e && typeof e.romaji === "string" ? e.romaji : "";
  }

  /** 搜索结果里挑一条：歌名归一化后相等，且歌手有一个对得上 */
  function pick(candidates, title, artist) {
    var wantTitle = keyOf(title);
    if (!wantTitle || !candidates || !candidates.length) return null;
    var wantArtists = String(artist == null ? "" : artist)
      .split(/[\/、,&]/)
      .map(function (s) {
        return keyOf(s);
      })
      .filter(Boolean);
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (!c || keyOf(c.title) !== wantTitle) continue;
      if (!wantArtists.length) return c;
      for (var j = 0; j < c.artists.length; j++) {
        var got = keyOf(c.artists[j]);
        if (!got) continue;
        for (var k = 0; k < wantArtists.length; k++) {
          var w = wantArtists[k];
          if (got === w || got.indexOf(w) >= 0 || w.indexOf(got) >= 0) return c;
        }
      }
    }
    return null;
  }

  /**
   * 搜索地址。Uta-net 的搜索页只认歌名（`Aselect=2&Bselect=3`），歌手在结果里核对。
   */
  function searchURL(title, artist, provider) {
    var t = str(title).replace(/^\s+|\s+$/g, "");
    if (!t || t.length > 200) return "";
    if (provider === "utanet") {
      return "https://www.uta-net.com/search/?Aselect=2&Bselect=3&Keyword=" + encodeURIComponent(t);
    }
    var u = "https://utaten.com/search?title=" + encodeURIComponent(t);
    var a = str(artist).replace(/^\s+|\s+$/g, "");
    if (a) u += "&artist_name=" + encodeURIComponent(a);
    return u;
  }

  return {
    allowedURL: allowedURL,
    providerOfURL: providerOfURL,
    parseSearch: parseSearch,
    parseLyric: parseLyric,
    parseUtanet: parseUtanet,
    buildIndex: buildIndex,
    tokensFor: tokensFor,
    romajiFor: romajiFor,
    pick: pick,
    searchURL: searchURL,
    keyOf: keyOf,
  };
});
