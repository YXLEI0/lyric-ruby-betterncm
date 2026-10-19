/*
 * 谚文（朝鲜语 / 韩语）-> 片假名。
 *
 * 谚文是拼写即读音的文字：一个字 = 初声 + 中声 + 终声，查三张表就能拼出来，
 * 不需要词典。所以这一层是纯规则，输出稳定、可复现。
 *
 * 口径（照日语里实际怎么标韩语）：
 *   가 カ / 서 ソ / 고 コ / 김 キム / 개 ケ
 *   안녕 アンニョン（ㅕ 这类 y 元音走「イ段 + 小元音」）
 *   사랑 サラン / 김치 キムチ / 눈물 ヌンムル / 하늘 ハヌル
 *   감사합니다 カムサハムニダ（终声 ㅂ + ㄴ 鼻音化成 ム，后面那个 ㄷ 跟着浊化成 ダ）
 *
 * 两条连读规则（只在同一个词内部看下一/上一个音节）：
 *   - 鼻音化：终声 ㄱ/ㄷ/ㅂ + 初声 ㄴ/ㅁ -> ン/ン/ム（합니다 ハムニダ）
 *   - 浊化：清音初声 ㄱ/ㄷ/ㅂ/ㅈ 前面是元音或 ㄴ/ㅁ/ㅇ/ㄹ 收尾时读 ガ/ダ/バ/ジャ
 *     （바다 パダ、한국 ハングク、보고 ポゴ）
 *
 * 挂到 globalThis.WKHangul。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WKHangul = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var S_BASE = 0xac00;
  var S_LAST = 0xd7a3;
  var V_COUNT = 21;
  var T_COUNT = 28;

  var A = 0;
  var I = 1;
  var U = 2;
  var E = 3;
  var O = 4;

  /** 初声 19 个：清音 / 浊音（连读时用）五段 */
  var INITIAL = [
    { plain: ["カ", "キ", "ク", "ケ", "コ"], voiced: ["ガ", "ギ", "グ", "ゲ", "ゴ"] }, // ㄱ
    { plain: ["ッカ", "ッキ", "ック", "ッケ", "ッコ"], voiced: ["ッカ", "ッキ", "ック", "ッケ", "ッコ"] }, // ㄲ
    { plain: ["ナ", "ニ", "ヌ", "ネ", "ノ"], voiced: null }, // ㄴ
    { plain: ["タ", "ティ", "トゥ", "テ", "ト"], voiced: ["ダ", "ディ", "ドゥ", "デ", "ド"] }, // ㄷ
    { plain: ["ッタ", "ッティ", "ットゥ", "ッテ", "ット"], voiced: null }, // ㄸ
    { plain: ["ラ", "リ", "ル", "レ", "ロ"], voiced: null }, // ㄹ
    { plain: ["マ", "ミ", "ム", "メ", "モ"], voiced: null }, // ㅁ
    { plain: ["パ", "ピ", "プ", "ペ", "ポ"], voiced: ["バ", "ビ", "ブ", "ベ", "ボ"] }, // ㅂ
    { plain: ["ッパ", "ッピ", "ップ", "ッペ", "ッポ"], voiced: null }, // ㅃ
    { plain: ["サ", "シ", "ス", "セ", "ソ"], voiced: null }, // ㅅ
    { plain: ["ッサ", "ッシ", "ッス", "ッセ", "ッソ"], voiced: null }, // ㅆ
    null, // ㅇ（没有初声）
    { plain: ["チャ", "チ", "チュ", "チェ", "チョ"], voiced: ["ジャ", "ジ", "ジュ", "ジェ", "ジョ"] }, // ㅈ
    { plain: ["ッチャ", "ッチ", "ッチュ", "ッチェ", "ッチョ"], voiced: null }, // ㅉ
    { plain: ["チャ", "チ", "チュ", "チェ", "チョ"], voiced: null }, // ㅊ
    { plain: ["カ", "キ", "ク", "ケ", "コ"], voiced: null }, // ㅋ
    { plain: ["タ", "ティ", "トゥ", "テ", "ト"], voiced: null }, // ㅌ
    { plain: ["パ", "ピ", "プ", "ペ", "ポ"], voiced: null }, // ㅍ
    { plain: ["ハ", "ヒ", "フ", "ヘ", "ホ"], voiced: null }, // ㅎ
  ];

  /**
   * 中声 21 个：vowel 主元音段，y = 前面带 y（走イ段 + 小元音），w = 前面带 w
   * （跟初声拼时那个 w 一般省掉：과 カ、괜 ケン、뭐 モ），alone = 初声是 ㅇ 时的整段。
   */
  var MEDIAL = [
    { v: A, alone: "ア" }, // ㅏ
    { v: E, alone: "エ" }, // ㅐ
    { v: A, y: "ャ", alone: "ヤ" }, // ㅑ
    { v: E, y: "ェ", alone: "イェ" }, // ㅒ
    { v: O, alone: "オ" }, // ㅓ
    { v: E, alone: "エ" }, // ㅔ
    { v: O, y: "ョ", alone: "ヨ" }, // ㅕ
    { v: E, y: "ェ", alone: "イェ" }, // ㅖ
    { v: O, alone: "オ" }, // ㅗ
    { v: A, w: true, alone: "ワ" }, // ㅘ
    { v: E, w: true, alone: "ウェ" }, // ㅙ
    { v: E, w: true, alone: "ウェ" }, // ㅚ
    { v: O, y: "ョ", alone: "ヨ" }, // ㅛ
    { v: U, alone: "ウ" }, // ㅜ
    { v: O, w: true, alone: "ウォ" }, // ㅝ
    { v: E, w: true, alone: "ウェ" }, // ㅞ
    { v: I, w: true, alone: "ウィ" }, // ㅟ
    { v: U, y: "ュ", alone: "ユ" }, // ㅠ
    { v: U, alone: "ウ" }, // ㅡ
    { v: I, w: true, alone: "ウィ" }, // ㅢ
    { v: I, alone: "イ" }, // ㅣ
  ];

  var FINAL = [
    "", "ク", "ク", "ク", "ン", "ン", "ン", "ッ", "ル", "ル", "ム", "ル", "ル", "ル", "プ", "ル",
    "ム", "プ", "プ", "ッ", "ッ", "ン", "ッ", "ッ", "ク", "ッ", "プ", "ッ",
  ];

  /** 终声种类：0 无 / 1 ㄱ系 / 2 ㄷ系 / 3 ㅂ系 / 4 ㄴㅁㅇ / 5 其它 */
  var FINAL_KIND = [
    0, 1, 1, 1, 4, 4, 4, 2, 5, 1, 4, 5, 5, 5, 3, 5, 4, 3, 3, 2, 2, 4, 2, 2, 1, 2, 3, 2,
  ];

  function isHangul(ch) {
    var c = ch.charCodeAt(0);
    return c >= S_BASE && c <= S_LAST;
  }

  function parts(ch) {
    var idx = ch.charCodeAt(0) - S_BASE;
    if (idx < 0 || idx > S_LAST - S_BASE) return null;
    return {
      ini: Math.floor(idx / (V_COUNT * T_COUNT)),
      med: Math.floor((idx % (V_COUNT * T_COUNT)) / T_COUNT),
      fin: idx % T_COUNT,
    };
  }

  /** 一个字 -> 片假名；voiced = 初声是否浊化，nasalize = 终声是否鼻音化 */
  function syllableEx(ch, opts) {
    if (!isHangul(ch)) return "";
    var p = parts(ch);
    if (!p) return "";
    var m = MEDIAL[p.med];
    var kana;
    if (p.ini === 11) {
      kana = m.alone;
    } else {
      var row = INITIAL[p.ini];
      if (m.y) {
        // y 元音：走イ段 + 小元音（녀 ニョ、별 ピョル）
        kana = row.plain[I] + m.y;
        if (opts && opts.voiced && row.voiced) kana = row.voiced[I] + m.y;
      } else {
        var table = opts && opts.voiced && row.voiced ? row.voiced : row.plain;
        kana = table[m.v];
      }
    }
    var fin = FINAL[p.fin];
    if (opts && opts.nasalize && fin) {
      var kind = FINAL_KIND[p.fin];
      if (kind === 1) fin = "ン";
      else if (kind === 2) fin = "ン";
      else if (kind === 3) fin = "ム";
    }
    return kana + fin;
  }

  /** 一个谚文音节 -> 片假名（不看上下文；单字/查表用） */
  function syllable(ch) {
    return syllableEx(ch, null);
  }

  /** 这一拍的终声是不是"响的"（元音 / ㄴㅁㅇㄹ 或会被鼻音化的 ㄱㄷㅂ） */
  function endsVoiced(fin) {
    if (!fin) return true;
    var kind = FINAL_KIND[fin];
    return kind === 4 || kind === 3 || kind === 7; // 4 = ㄴㅁㅇ, 3 = ㅂ(会变 ム), 7 不存在
  }

  /** 一串谚文（一个词）-> 片假名：词内做鼻音化和浊化 */
  function word(text) {
    var pieces = wordPieces(text);
    var out = "";
    for (var i = 0; i < pieces.length; i++) out += pieces[i].kana;
    return out;
  }

  /**
   * 一串文字 -> 逐个谚文音节的读音 [{ ch, kana }]（非谚文字符原样带 kana=""）。
   * 注音层要「一个音节一个 ruby」，但鼻音化 / 浊化要看同一个词里的邻居，
   * 所以必须整词算完再拆开。
   */
  function wordPieces(text) {
    var s = String(text == null ? "" : text);
    var out = [];
    var prevFin = -1;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (!isHangul(ch)) {
        out.push({ ch: ch, kana: "" });
        prevFin = -1;
        continue;
      }
      var p = parts(ch);
      var nextNasal = false;
      var next = s.charAt(i + 1);
      if (isHangul(next)) {
        var np = parts(next);
        nextNasal = !!np && (np.ini === 2 || np.ini === 6);
      }
      var voiced = prevFin !== -1 && endsVoiced(prevFin);
      out.push({ ch: ch, kana: syllableEx(ch, { voiced: voiced, nasalize: nextNasal }) });
      prevFin = p.fin;
    }
    return out;
  }

  return {
    isHangul: isHangul,
    syllable: syllable,
    word: word,
    wordPieces: wordPieces,
    RE: /[\uAC00-\uD7A3]/,
  };
});
