/*
 * 普通话音节 -> 片假名（构建期用，给 tools/build-hanzi.js 生成汉字读音表）。
 *
 * 只做"一个字一个音节"这一档：pinyin-pro 给出无声调拼音，这里按声母 / 韵母拼成
 * 日语里常见的那种写法（我 wo -> ウォ、爱 ai -> アイ、是 shi -> シー）。
 *
 * 取舍（照着日语里实际怎么标普通话来定）：
 *   - 声母按行分：b バ行、p パ行、m マ行、f ファ行、d ダ行、t タ行、n ナ行、l ラ行、
 *     g ガ行、k カ行、h ハ行、j ジャ行、q チャ行、x シャ行、zh ジャ行、ch チャ行、
 *     sh シャ行、r ラ行、z ザ行、c ツァ行、s サ行。
 *   - 韵母按「声母那一行 + 后面的元音」拼：ai アイ、ao アオ、an アン、en エン、
 *     i イ、u ウ、ü ュ、ia ャ、ie ェ、ian ェン、iong ョン……
 *   - zhi / chi / shi / ri / zi / ci / si 的 i 是舌尖元音，读成「ー」（シー / ツー）。
 *   - 零声母的 y / w 开头的音节单独列（yi イ、ye イェ、you ヨウ、wu ウ、wo ウォ…）。
 *
 * 输出一律是「ァ-ヶ + ー」，供注音直接用。
 */
"use strict";

/** 声母 -> 五个元音段的假名（a i u e o） */
const ROW = {
  b: ["バ", "ビ", "ブ", "ベ", "ボ"],
  p: ["パ", "ピ", "プ", "ペ", "ポ"],
  m: ["マ", "ミ", "ム", "メ", "モ"],
  f: ["ファ", "フィ", "フ", "フェ", "フォ"],
  d: ["ダ", "ディ", "ドゥ", "デ", "ド"],
  t: ["タ", "ティ", "トゥ", "テ", "ト"],
  n: ["ナ", "ニ", "ヌ", "ネ", "ノ"],
  l: ["ラ", "リ", "ル", "レ", "ロ"],
  g: ["ガ", "ギ", "グ", "ゲ", "ゴ"],
  k: ["カ", "キ", "ク", "ケ", "コ"],
  h: ["ハ", "ヒ", "フ", "ヘ", "ホ"],
  j: ["ジャ", "ジ", "ジュ", "ジェ", "ジョ"],
  q: ["チャ", "チ", "チュ", "チェ", "チョ"],
  x: ["シャ", "シ", "シュ", "シェ", "ショ"],
  zh: ["ジャ", "ジ", "ジュ", "ジェ", "ジョ"],
  ch: ["チャ", "チ", "チュ", "チェ", "チョ"],
  sh: ["シャ", "シ", "シュ", "シェ", "ショ"],
  r: ["ラ", "リ", "ル", "レ", "ロ"],
  z: ["ザ", "ズ", "ズ", "ゼ", "ゾ"],
  c: ["ツァ", "ツ", "ツ", "ツェ", "ツォ"],
  s: ["サ", "ス", "ス", "セ", "ソ"],
};

/** 声母按长度从长到短匹配（zh / ch / sh 要先于 z / c / s） */
const INITIALS = ["zh", "ch", "sh", "b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h", "j", "q", "x", "r", "z", "c", "s"];

const A = 0;
const I = 1;
const U = 2;
const E = 3;
const O = 4;

/** 韵母 -> [段, 后面的尾巴]；段用 A/I/U/E/O 表示 */
const FINALS = {
  a: [A, ""],
  o: [O, ""],
  e: [E, ""],
  i: [I, ""],
  u: [U, ""],
  ai: [A, "イ"],
  ei: [E, "イ"],
  ao: [A, "オ"],
  ou: [O, "ウ"],
  an: [A, "ン"],
  en: [E, "ン"],
  ang: [A, "ン"],
  eng: [E, "ン"],
  ong: [O, "ン"],
  // i 系（介音用小的 ャ / ェ / ョ）
  ia: [I, "ャ"],
  ie: [I, "ェ"],
  iao: [I, "ャオ"],
  iu: [I, "ュウ"],
  ian: [I, "ェン"],
  in: [I, "ン"],
  iang: [I, "ャン"],
  ing: [I, "ン"],
  iong: [I, "ョン"],
  // u 系
  ua: [U, "ア"],
  uo: [U, "オ"],
  uai: [U, "アイ"],
  ui: [U, "イ"],
  uan: [U, "アン"],
  un: [U, "ン"],
  uang: [U, "アン"],
  ueng: [U, "ェン"],
  // ü 系
  v: [U, "ュ"],
  ve: [U, "ェ"],
  van: [U, "ェン"],
  vn: [U, "ン"],
};

/** 零声母（y / w 开头和纯韵母） */
const ZERO = {
  a: "ア",
  o: "オ",
  e: "オ",
  ai: "アイ",
  ei: "エイ",
  ao: "アオ",
  ou: "オウ",
  an: "アン",
  en: "エン",
  ang: "アン",
  eng: "エン",
  er: "アル",
  yi: "イ",
  ya: "ヤ",
  ye: "イェ",
  yao: "ヤオ",
  you: "ヨウ",
  yan: "イェン",
  yin: "イン",
  yang: "ヤン",
  ying: "イン",
  yong: "ヨン",
  yo: "ヨ",
  yu: "ユ",
  yue: "ユエ",
  yuan: "ユエン",
  yun: "ユン",
  wu: "ウ",
  wa: "ワ",
  wo: "ウォ",
  wai: "ワイ",
  wei: "ウェイ",
  wan: "ワン",
  wen: "ウェン",
  wang: "ワン",
  weng: "ウェン",
};

/** zhi / chi / shi / ri / zi / ci / si：舌尖元音那个 i 读 ー */
const BUZZ_I = { zh: true, ch: true, sh: true, r: true, z: true, c: true, s: true };

/**
 * 一个无声调音节 -> 片假名；拼不出来返回 null。
 * @param {string} syllable 例如 "wo" / "shi" / "xiang"
 */
function syllableToKatakana(syllable) {
  // ü 在拼音里有三种写法（ü / v / u:），统一成 v 再拼
  const s = String(syllable || "")
    .trim()
    .toLowerCase()
    .replace(/\u00fc/g, "v")
    .replace(/u:/g, "v");
  if (!s) return null;
  if (s === "n" || s === "ng" || s === "m") return "ン";
  if (ZERO[s]) return ZERO[s];
  // 声母
  let ini = "";
  let fin = s;
  for (const cand of INITIALS) {
    if (s.length > cand.length && s.startsWith(cand)) {
      ini = cand;
      fin = s.slice(cand.length);
      break;
    }
  }
  if (!ini) return ZERO[s] || null;
  const row = ROW[ini];
  if (!row) return null;
  // 舌尖元音
  if (fin === "i" && BUZZ_I[ini]) return row[I] + "ー";
  // j / q / x 后面的 i 是实打实的 /i/，日语里都写长音（气 チー、西 シー、机 ジー）
  if (fin === "i" && "jqx".indexOf(ini) >= 0) return row[I] + "ー";
  // j / q / x 后面写的 u 其实是 ü（ju = jü -> ジュ，jue = jüe -> ジュエ）
  if ("jqx".indexOf(ini) >= 0) {
    if (fin === "u") return row[U];
    if (fin === "ue") return row[U] + "エ";
  }
  // n / l 后面的 ü 走「イ段 + 小元音」：nü ニュ、lüe リュエ
  if ((ini === "n" || ini === "l") && fin.charAt(0) === "v") {
    const tail = { "": "ュ", e: "ュエ", an: "ュエン", n: "ュン" }[fin.slice(1)];
    if (tail) return row[I] + tail;
  }
  const f = FINALS[fin];
  if (!f) return null;
  return row[f[0]] + f[1];
}

module.exports = { syllableToKatakana, ROW, FINALS, ZERO };
