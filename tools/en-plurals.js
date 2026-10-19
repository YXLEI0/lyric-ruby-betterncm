/*
 * 英语复数 / 第三人称单数的读音补全（构建期用，tools/build-dict.js 和测试共用）。
 *
 * 那份"片假名外来语 -> 英文原词"的表里，复数和单数常常指向同一个写法
 * （`rule` 和 `rules` 都是 ルール），反转之后就变成"复数丢了词尾"：
 *   rules -> ルール、games -> ゲーム、lists -> リスト、points -> ポイント
 * 既然读音按英语走，-s 就得读出来：
 *   rules ルールズ、games ゲームズ、lists リスツ（词尾 ト 换成 ツ）、points ポインツ
 *
 * 只在"这个词条和它的单数一模一样"时动手 —— 别的复数（cats キャッツ、dogs ドッグス）
 * 本来就是对的，不碰。单数不存在（pants、series、news 这种）也不碰。
 */
"use strict";

const PLURAL_SKIP = { ss: true, us: true, is: true, os: true, as: true, ms: true, ys: true, ics: true, ous: true };

/*
 * 这张表里夹着一批**不是英语复数**的词条：法语（fleurs / larmes / les / vous…）、
 * 美国地名（arkansas / illinois / louis）、以及本来就是日语词的 pants（ズボン）。
 * 它们也满足"词条和单数写法一样"，但补 -s 只会把它们读坏（fleurs フルールズ ✗）。
 * 所以按词列出来排除 —— 判语种在构建期没有可靠依据，硬猜不如列清楚。
 */
const NOT_ENGLISH_PLURAL = {
  arkansas: 1, ces: 1, corps: 1, dans: 1, des: 1, elles: 1, es: 1, etoiles: 1, fleurs: 1,
  illinois: 1, ils: 1, jamais: 1, larmes: 1, les: 1, louis: 1, mes: 1, nous: 1, pants: 1,
  pays: 1, printemps: 1, pouvais: 1, reves: 1, ses: 1, suis: 1, tes: 1, toujours: 1, vies: 1, vous: 1,
};

function pluralize(word, kana, table) {
  if (!/[a-z]s$/.test(word)) return null;
  if (NOT_ENGLISH_PLURAL[word]) return null;
  const stem = word.slice(0, -1);
  // 以 s 结尾的复数尾：只有词干本身以 s / sh / ch / x / z 结尾才是 -es（glasses / boxes）
  let baseKey = stem;
  let singular = table[stem];
  if (singular === undefined && /es$/.test(word)) {
    baseKey = word.slice(0, -2);
    singular = table[baseKey];
  }
  if (singular === undefined || singular !== kana) return null;
  if (PLURAL_SKIP[word.slice(-2)] && word.slice(-2) !== "es") return null;
  // 已经带 s 音的词尾不重复加：キャッツ / ボックス / キッシズ
  if (/[\u30BA\u30B9\u30C4\u30C1\u30B8]$/.test(kana)) return null;
  // 词尾 ト / ド：英语的 -ts / -ds 在日语里写成 ツ / ズ（lists リスツ、points ポインツ）
  if (/\u30C8$/.test(kana)) return kana.slice(0, -1) + "\u30C4";
  if (/\u30C9$/.test(kana)) return kana.slice(0, -1) + "\u30BA";
  // 其余直接加 ズ（rules ルールズ、games ゲームズ）
  if (/\u30FC$/.test(kana)) return kana + "\u30BA";
  return kana + "\u30BA";
}

module.exports = { pluralize, NOT_ENGLISH_PLURAL, PLURAL_SKIP };
