/*
 * 数字的日语读音：`105` -> ヒャクゴ、`2020` -> ニセンニジュウ、`39` -> サンジュウキュウ。
 *
 * 为什么要单独做：kuromoji 对阿拉伯数字不给读音（`105` 的 reading 是 `*`），
 * 所以振假名那层会跳过它们 —— 真机上就是"数字上面什么都没有"。
 * 只有和助数词黏在一起时（`1つ`）词典才认得出，那种情况不需要这里。
 *
 * 拼音规则按日语读数的常规写法，连浊 / 促音也照做：
 *   3百 サンビャク、6百 ロッピャク、8百 ハッピャク、3千 サンゼン、8千 ハッセン
 * 超出 兆 的部分不注（歌词里没见过，猜不如不注）。
 *
 * 挂到 globalThis.WKNumbers。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WKNumbers = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var DIGIT = ["ゼロ", "イチ", "ニ", "サン", "ヨン", "ゴ", "ロク", "ナナ", "ハチ", "キュウ"];
  var BIG = ["", "マン", "オク", "チョウ"];

  /** 0..999 的一组（三位一读） */
  function group3(n) {
    var out = "";
    var h = Math.floor(n / 100);
    var t = Math.floor((n % 100) / 10);
    var o = n % 10;
    if (h) {
      if (h === 3) out += "サンビャク";
      else if (h === 6) out += "ロッピャク";
      else if (h === 8) out += "ハッピャク";
      else out += (h === 1 ? "" : DIGIT[h]) + "ヒャク";
    }
    if (t) out += (t === 1 ? "" : DIGIT[t]) + "ジュウ";
    if (o) out += DIGIT[o];
    return out;
  }

  /** 0..9999 的一组（千位单独处理，因为 3千 / 8千 有连浊） */
  function group4(n) {
    var out = "";
    var s = Math.floor(n / 1000);
    if (s) {
      if (s === 3) out += "サンゼン";
      else if (s === 8) out += "ハッセン";
      else out += (s === 1 ? "" : DIGIT[s]) + "セン";
    }
    out += group3(n % 1000);
    return out;
  }

  /**
   * @param {string|number} value 只认阿拉伯数字（可以带前导 0）
   * @returns {string|null} 片假名读音；认不出来返回 null
   */
  function reading(value) {
    var d = String(value == null ? "" : value).replace(/[^0-9]/g, "");
    if (!d) return null;
    // 去掉前导 0；全是 0 就是「ゼロ」
    d = d.replace(/^0+/, "");
    if (!d) return "ゼロ";
    if (d.length > 12) return null; // 超过 1 兆：不猜
    var groups = [];
    while (d.length) {
      groups.push(d.slice(-4));
      d = d.slice(0, -4);
    }
    var out = "";
    for (var i = groups.length - 1; i >= 0; i--) {
      var n = Number(groups[i]);
      if (!n) continue;
      var part = group4(n);
      // 万 / 億 / 兆：group4 已经处理了千位，这里只补单位
      if (i > 0) {
        if (!BIG[i]) return null;
        part += BIG[i];
      }
      out += part;
    }
    return out || "ゼロ";
  }

  return {
    reading: reading,
    /** 一行里的数字段（调试 / 面板用） */
    scan: function (text) {
      var s = String(text == null ? "" : text);
      var out = [];
      var re = /[0-9]+/g;
      var m;
      while ((m = re.exec(s))) out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
      return out;
    },
  };
});
