/*
 * 生成离线读音词典：tools/seed-words.js + tools/seed-words-llm.js -> src/core/dict.js
 *
 * 生成过程不联网，只是把几份现成的表合成一个文件，人工的优先，同一个词几边都有时保留人工那份。
 *
 * 用法：npm run build:dict
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SEED = path.join(ROOT, "tools", "seed-words.js");
const OUT = path.join(ROOT, "src", "core", "dict.js");

// 英文侧必须是纯小写字母
const RE_EN = /^[a-z]+$/;
// 读音必须是纯片假名（可带长音符）。混进汉字/平假名说明数据脏了，
// 而这种错会直接标到歌词上，必须拦下来。
const RE_KANA = /^[\u30A0-\u30FF\u30FC]+$/;

/**
 * 把「运行期沉淀」和「大模型批量生成」两份表并进 words：**先沉淀、后大模型**。
 *
 * 两个循环都只做"这个词还没有读音才写"，所以**调用顺序就是优先级**。
 * 这里以前写反过（先大模型、后沉淀），`promote:learned` 里"同词换读音"（`updated`）
 * 的那批一命中就被大模型那份挡掉，"用户手改的读音"永远进不了词典；而真实的两份表
 * 里碰巧没有同词异读，构建产物一个字节都不变，所以只能靠 tests/dict.test.js 里
 * 的小场景盯着 —— 这也是把它抽成纯函数、单独导出的原因。
 *
 * @param {Object} words      已有的词（人工词表 + 官方歌名读音已经填好，它们优先级最高）
 * @param {Array}  learnedRows tools/seed-words-learned.js 的 [{en, kana}]
 * @param {Object} llmWords    tools/seed-words-llm.js 的 words（词 -> 读音）
 * @param {Object} blocklist   tools/dict-blocklist.js
 * @returns {{learnedAdded:number, learnedSkipped:number, llmAdded:number,
 *            llmSkipped:number, llmBlocked:number, llmProblems:number}}
 */
function mergeLearnedAndLlm(words, learnedRows, llmWords, blocklist) {
  const stats = {
    learnedAdded: 0,
    learnedSkipped: 0,
    llmAdded: 0,
    llmSkipped: 0,
    llmBlocked: 0,
    llmProblems: 0,
  };
  /*
   * 运行期沉淀下来的词：面板「操作 → 导出词库素材」导出的 JSON，经
   * tools/promote-learned.js 筛选。优先级夹在中间，人工核过的 seed-words.js 高于它，
   * 它高于大模型批量生成的 seed-words-llm.js —— 那些词来自真机听歌的上下文
   * （同一个词在两个句子里读音一致才收），比按词频一次生成更可信。
   */
  for (const row of learnedRows) {
    const en = String((row && row.en) || "").trim().toLowerCase();
    const kana = String((row && row.kana) || "").trim();
    if (!RE_EN.test(en) || !RE_KANA.test(kana)) continue;
    if (words[en] !== undefined) {
      stats.learnedSkipped++; // 人工词表或官方歌名里已经有这个词了
      continue;
    }
    words[en] = kana;
    stats.learnedAdded++;
  }
  for (const en of Object.keys(llmWords).sort()) {
    const kana = String(llmWords[en] || "").trim();
    if (!RE_EN.test(en) || !RE_KANA.test(kana)) {
      stats.llmProblems++;
      continue;
    }
    if (words[en] !== undefined) {
      stats.llmSkipped++; // 人工词表、官方歌名或沉淀表里已经有这个读音了
      continue;
    }
    if (blocklist[en]) {
      stats.llmBlocked++;
      continue;
    }
    words[en] = kana;
    stats.llmAdded++;
  }
  return stats;
}

function build() {
  const seed = require(SEED);
  if (!Array.isArray(seed) || !seed.length) {
    console.error("种子词表是空的：" + SEED);
    process.exit(1);
  }

  const words = {};
  const problems = [];
  for (const row of seed) {
    const en = String((row && row.en) || "")
      .trim()
      .toLowerCase();
    const kana = String((row && row.kana) || "").trim();
    if (!RE_EN.test(en)) {
      problems.push("英文侧不是纯小写字母：" + JSON.stringify(row));
      continue;
    }
    if (!RE_KANA.test(kana)) {
      problems.push("读音不是纯片假名：" + JSON.stringify(row));
      continue;
    }
    if (words[en] && words[en] !== kana) {
      problems.push("同一个词有两种写法（留第一个）：" + en + " -> " + words[en] + " / " + kana);
      continue;
    }
    words[en] = kana;
  }

  if (problems.length) {
    console.error("种子词表有问题，已中止：");
    for (const p of problems) console.error("  - " + p);
    process.exit(2);
  }

  const handCount = Object.keys(words).length;

  /*
   * 官方歌名读音：Project Sekai 主数据库里单个西文词的歌名，由 tools/build-sekai.js
   * 生成 tools/seed-words-sekai.js。优先级夹在人工和沉淀之间 —— 官方读音比我们自己的
   * 英文音译规则可信，但人工核过的词条仍旧最高（同一个词两边都有时保留人工那份）。
   */
  const SEKAI_SEED = path.join(__dirname, "seed-words-sekai.js");
  let sekaiAdded = 0;
  let sekaiSkipped = 0;
  if (fs.existsSync(SEKAI_SEED)) {
    for (const row of require(SEKAI_SEED) || []) {
      const en = String((row && row.en) || "").trim().toLowerCase();
      const kana = String((row && row.kana) || "").trim();
      if (!RE_EN.test(en) || !RE_KANA.test(kana)) continue;
      if (words[en] !== undefined) {
        sekaiSkipped++;
        continue;
      }
      words[en] = kana;
      sekaiAdded++;
    }
  }

  /*
   * tools/seed-words-llm.js：由 tools/expand-dict-llm.js 让大模型按词频批量生成的读音
   * （几千条）。纯拼写规则读不对 hello / question / shining 这类词，而歌词里的高频词
   * 其实是有限的一批，构建期问一次、运行期就是纯离线查表。
   */
  const LLM_SEED = path.join(__dirname, "seed-words-llm.js");
  let llmWords = {};
  if (fs.existsSync(LLM_SEED)) {
    const mod = require(LLM_SEED);
    llmWords = (mod && mod.words) || {};
  } else {
    console.log("提示：没有 " + path.relative(ROOT, LLM_SEED) + "，只用人工词表（跑 npm run build:dict:llm 生成）");
  }

  /*
   * 运行期沉淀表。读不出来只报警、不中止：这张表是"攒出来的"，坏了不该挡住整本词典
   * 的重新生成（里面有几千条人工 + 大模型的词）。
   */
  const LEARNED_SEED = path.join(__dirname, "seed-words-learned.js");
  let learnedRows = [];
  if (fs.existsSync(LEARNED_SEED)) {
    try {
      learnedRows = require(LEARNED_SEED) || [];
    } catch (e) {
      console.error("读不了 " + path.relative(ROOT, LEARNED_SEED) + "：" + e.message + "（跳过）");
      learnedRows = [];
    }
  }

  /*
   * 生成词表里"读错义项"的黑名单，见 tools/dict-blocklist.js（和测试共用一份）。
   */
  const BLOCK_LLM = require(path.join(__dirname, "dict-blocklist.js"));

  // 顺序即优先级：人工 -> 官方歌名 -> 沉淀 -> 大模型
  const stats = mergeLearnedAndLlm(words, learnedRows, llmWords, BLOCK_LLM);
  if (stats.llmProblems) {
    console.error("生成词表里有 " + stats.llmProblems + " 条格式不对，已跳过（修 tools/seed-words-llm.js 或重跑生成）");
  }

  const { pluralize } = require("./en-plurals.js");

  let pluralFixed = 0;
  for (const k of Object.keys(words)) {
    const fixed = pluralize(k, words[k], words);
    if (fixed && fixed !== words[k]) {
      words[k] = fixed;
      pluralFixed++;
    }
  }

  const keys = Object.keys(words).sort();
  const body = keys
    .map((k) => "    " + JSON.stringify(k) + ": " + JSON.stringify(words[k]) + ",")
    .join("\n");

  const out = `/*
 * 英文 -> 片假名读音词典（自动生成，勿手改）。
 *
 * 两份数据源，由 tools/build-dict.js 合并（跑 npm run build:dict 重新生成）：
 *   1. tools/seed-words.js      —— 人工核过（其中大部分是从一份现成的
 *      "片假名外来语 -> 英文原词"对照表反转来的真实外来语写法）；
 *   2. tools/seed-words-sekai.js —— 官方歌名读音（Project Sekai 主数据库里单个西文词的歌名）；
 *   3. tools/seed-words-learned.js —— 运行期沉淀；
 *   4. tools/seed-words-llm.js  —— 大模型按英文词频批量生成的读音（${stats.llmAdded} 条），
 *      由 tools/expand-dict-llm.js 生成，人工词表优先。
 *
 * 读音查找顺序见 core/reading.js：本词典 -> 罗马音切分 -> 英文音译规则
 * （-> 大模型校正，运行期，见 core/llm.js）。
 * 词典命中是唯一"确定对"的来源，所以常用词尽量收进这里。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WKDict = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var words = {
${body}
  };

  return {
    words: words,
    count: ${keys.length},
  };
});
`;

  fs.writeFileSync(OUT, out);
  console.log("已生成 " + path.relative(ROOT, OUT) + "：" + keys.length + " 条" +
    "（人工 " + handCount + " 条 + 官方歌名 " + sekaiAdded + " 条 + 沉淀 " + stats.learnedAdded + " 条 + 大模型 " + stats.llmAdded + " 条，被优先级更高的表挡下 " +
    (stats.llmSkipped + stats.learnedSkipped + sekaiSkipped) + " 条" +
    (stats.llmBlocked ? "，黑名单拦下 " + stats.llmBlocked + " 条" : "") + "）");
}

if (require.main === module) build();

module.exports = { build, mergeLearnedAndLlm };
