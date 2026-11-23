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
    // 全角数字（１２３）也要认：歌词里很常见
    var d = String(value == null ? "" : value).replace(/[\uFF10-\uFF19]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
    });
    d = d.replace(/[^0-9]/g, "");
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

  /**
   * 英语数词的片假名读法：10 -> テン、12 -> トゥエルブ、105 -> ワンハンドレッドファイブ。
   *
   * 为什么单独一条：歌词里的数字常按英文念（`24` トゥエンティフォー、`10` テン），
   * 日语那套（ジュウ / ヒャクゴ）和"逐个数字念"（ワンゼロファイブ）都覆盖不到它。
   * 按英语数词拼（and 不念，日语里通常也不补 アンド）；超过 999999 不猜。
   *
   * @param {string|number} value 阿拉伯数字（全角也认）
   * @returns {string|null} 片假名读音；认不出来返回 null
   */
  var EN_ONE = [
    "ゼロ", "ワン", "ツー", "スリー", "フォー", "ファイブ", "シックス", "セブン", "エイト", "ナイン",
    "テン", "イレブン", "トゥエルブ", "サーティーン", "フォーティーン", "フィフティーン",
    "シックスティーン", "セブンティーン", "エイティーン", "ナインティーン",
  ];
  var EN_TEN = ["", "", "トゥエンティ", "サーティー", "フォーティー", "フィフティー", "シックスティー", "セブンティー", "エイティー", "ナインティー"];

  /** 十位后面接个位时，长音符去掉（トゥエンティー + ワン → トゥエンティワン） */
  function dropLong(s) {
    return s.charAt(s.length - 1) === "ー" ? s.slice(0, -1) : s;
  }

  function enUnder100(n) {
    if (n < 20) return EN_ONE[n];
    var t = Math.floor(n / 10);
    var o = n % 10;
    return o ? dropLong(EN_TEN[t]) + EN_ONE[o] : EN_TEN[t];
  }

  function enUnder1000(n) {
    var h = Math.floor(n / 100);
    var rest = n % 100;
    var out = "";
    if (h) out += (h === 1 ? "ワン" : EN_ONE[h]) + "ハンドレッド";
    if (rest) out += enUnder100(rest);
    return out;
  }

  function englishKana(value) {
    var d = String(value == null ? "" : value).replace(/[\uFF10-\uFF19]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
    });
    d = d.replace(/[^0-9]/g, "");
    if (!d) return null;
    d = d.replace(/^0+/, "");
    if (!d) return "ゼロ";
    if (d.length > 6) return null; // 超过 999999：不猜
    var n = Number(d);
    if (!isFinite(n)) return null;
    var th = Math.floor(n / 1000);
    var rest = n % 1000;
    var out = "";
    if (th) out += (th === 1 ? "ワン" : enUnder1000(th)) + "サウザンド";
    if (rest) out += enUnder1000(rest);
    return out || "ゼロ";
  }

  return {
    reading: reading,
    /** 英语数词的片假名（10 テン / 105 ワンハンドレッドファイブ） */
    englishKana: englishKana,
    /** 一行里的数字段（调试 / 面板用） */
    scan: function (text) {
      var s = String(text == null ? "" : text);
      var out = [];
      var re = /[0-9\uFF10-\uFF19]+/g;
      var m;
      while ((m = re.exec(s))) out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
      return out;
    },
  };
});
