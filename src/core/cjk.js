/*
 * 中文 / 朝鲜语的注音扫描：把一行文字里的汉字和谚文切成"每个字一个注音"。
 *
 * 和 core/letters.js 分工：那个扫西文字母（拉丁 / 西里尔 / 希腊），这个扫汉字与谚文。
 * 两者扫出来的字符集不重叠，注音层把两批 token 按位置合在一起就行。
 *
 * 读音从哪来：
 *   - 汉字：查 core/hanzi.js（一个汉字 -> 一片假名，构建期由 pinyin-pro 生成）
 *   - 谚文：core/hangul.js 现拼（谚文是拼写即读音，不需要词表）
 *
 * 查不到读音的字不产出 token（宁可留白，也不猜）。
 *
 * 挂到 globalThis.WKCJK。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WKCJK = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var HAN = /[\u4E00-\u9FFF]/;
  var HANGUL = /[\uAC00-\uD7A3]/;

  /*
   * 运行时依赖：插件里从全局取（core/hanzi.js、core/hangul.js 先注入），
   * 测试里用 configure() 直接递进来。
   */
  var injected = { hanzi: null, hangul: null };

  function deps() {
    return {
      hanzi: injected.hanzi || (typeof WKHanzi !== "undefined" ? WKHanzi : null),
      hangul: injected.hangul || (typeof WKHangul !== "undefined" ? WKHangul : null),
    };
  }

  function hasHan(text) {
    return !!text && HAN.test(String(text));
  }

  function hasHangul(text) {
    return !!text && HANGUL.test(String(text));
  }

  /**
   * @param {string} text 一段文字
   * @param {{han?:boolean, hangul?:boolean}} opts 要扫哪几种
   * @returns {Array<{text:string,start:number,end:number,kana:string,kind:string}>}
   */
  function scan(text, opts) {
    var s = String(text == null ? "" : text);
    var out = [];
    if (!s) return out;
    var o = opts || {};
    var d = deps();
    if (o.han && d.hanzi) {
      var table = d.hanzi.kana || {};
      for (var i = 0; i < s.length; i++) {
        var ch = s.charAt(i);
        if (!HAN.test(ch)) continue;
        if (Object.prototype.hasOwnProperty.call(table, ch)) {
          out.push({ text: ch, start: i, end: i + 1, kana: table[ch], kind: "han" });
        }
      }
    }
    if (o.hangul && d.hangul) {
      // 谚文要整词算（鼻音化 / 浊化看邻居），算完再拆成一个个音节
      var i2 = 0;
      while (i2 < s.length) {
        if (!HANGUL.test(s.charAt(i2))) {
          i2++;
          continue;
        }
        var j = i2;
        while (j < s.length && HANGUL.test(s.charAt(j))) j++;
        var run = s.slice(i2, j);
        var pieces = d.hangul.wordPieces(run);
        for (var k = 0; k < pieces.length; k++) {
          if (!pieces[k].kana) continue;
          out.push({ text: pieces[k].ch, start: i2 + k, end: i2 + k + 1, kana: pieces[k].kana, kind: "hangul" });
        }
        i2 = j;
      }
    }
    out.sort(function (a, b) {
      return a.start - b.start;
    });
    return out;
  }

  return {
    configure: function (d) {
      injected.hanzi = (d && d.hanzi) || null;
      injected.hangul = (d && d.hangul) || null;
    },
    hasHan: hasHan,
    hasHangul: hasHangul,
    scan: scan,
    HAN: HAN,
    HANGUL: HANGUL,
  };
});
