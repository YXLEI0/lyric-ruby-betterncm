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

  var KANA = /^[\u3041-\u3096\u30FC]+$/;

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
        (u.hostname === "utaten.com" || u.hostname === "www.utaten.com")
      );
    } catch (e) {
      return false;
    }
  }

  function docOf(html) {
    if (typeof DOMParser === "undefined") throw new Error("没有 DOMParser");
    return new DOMParser().parseFromString(str(html), "text/html");
  }

  /** 搜索结果页的候选（歌名 / 歌手 / 歌词页地址） */
  function parseSearch(html) {
    var doc = docOf(html);
    var out = [];
    var links = doc.querySelectorAll(".searchResult__title a[href]");
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var row = a.closest ? a.closest("tr") : null;
      if (!row) continue;
      var title = (a.querySelector(".songlist-title") || a).textContent || "";
      title = title.replace(/^\s+|\s+$/g, "");
      var url = "";
      try {
        url = new URL(a.getAttribute("href"), "https://utaten.com/").href;
      } catch (e) {
        url = "";
      }
      if (!title || !url || !allowedURL(url)) continue;
      var dup = false;
      for (var d = 0; d < out.length; d++) if (out[d].url === url) dup = true;
      if (dup) continue;
      var artists = [];
      var artistNodes = row.querySelectorAll(".searchResult__artist > p a");
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
   */
  function buildIndex(record) {
    var entries = {};
    if (!record || !record.lines) return { entries: entries, count: 0 };
    for (var i = 0; i < record.lines.length; i++) {
      var line = record.lines[i];
      if (!line || !line.text || !line.segments) continue;
      var c = compact(line.text);
      if (!c.text) continue;
      var segs = [];
      var cur = 0;
      for (var j = 0; j < line.segments.length; j++) {
        var seg = line.segments[j];
        var sc = compact(seg.text);
        if (seg.rt && sc.text.length) segs.push({ from: cur, to: cur + sc.text.length, rt: seg.rt });
        cur += sc.text.length;
      }
      if (cur !== c.text.length) continue; // 片段拼起来和整行对不上，不要
      var stamp = JSON.stringify(segs);
      if (Object.prototype.hasOwnProperty.call(entries, c.text)) {
        if (JSON.stringify(entries[c.text].segs) !== stamp) entries[c.text] = null;
        continue;
      }
      entries[c.text] = { segs: segs, map: c.map };
    }
    return { entries: entries, count: record.lines.length };
  }

  /** 当前歌词行在网站索引里的读音 token（对不上返回 null） */
  function tokensFor(lineText, index) {
    if (!index || !index.entries) return null;
    var c = compact(lineText);
    if (!c.text || !Object.prototype.hasOwnProperty.call(index.entries, c.text)) return null;
    var e = index.entries[c.text];
    if (!e) return null;
    var out = [];
    for (var i = 0; i < e.segs.length; i++) {
      var seg = e.segs[i];
      if (!(seg.to > seg.from)) continue;
      var start = e.map[seg.from];
      var end = e.map[seg.to - 1] + 1;
      if (!(start >= 0) || !(end > start)) continue;
      out.push({ text: str(lineText).slice(start, end), start: start, end: end, kana: seg.rt });
    }
    return out;
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

  function searchURL(title, artist) {
    var t = str(title).replace(/^\s+|\s+$/g, "");
    if (!t || t.length > 200) return "";
    var u = "https://utaten.com/search?title=" + encodeURIComponent(t);
    var a = str(artist).replace(/^\s+|\s+$/g, "");
    if (a) u += "&artist_name=" + encodeURIComponent(a);
    return u;
  }

  return {
    allowedURL: allowedURL,
    parseSearch: parseSearch,
    parseLyric: parseLyric,
    buildIndex: buildIndex,
    tokensFor: tokensFor,
    pick: pick,
    searchURL: searchURL,
    keyOf: keyOf,
  };
});
