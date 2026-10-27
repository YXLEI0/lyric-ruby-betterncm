/*
 * 静态自检：不联网、不依赖浏览器，CI 里跑这个就能挡住大部分低级错误。
 *
 *   node tools/check.js
 *
 * 检查项：
 *   0. Node 版本满足 jsdom 的引擎要求；
 *   1. 所有 .js 能通过语法解析（vm.Script 只编译不执行）；
 *   2. manifest.json 合法，slug/version 格式正确，注入顺序符合依赖；
 *   3. 注入清单里的文件都存在，且不含别的东西；
 *   4. 词典条目数与格式；
 *   5. 元信息一致（REPO_URL 与仓库一致、无 OWNER 占位符）；
 *   6. 不出现明显的秘密信息（token 之类）。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");

let failures = 0;
let warnings = 0;

function ok(msg) {
  console.log("  ok    " + msg);
}
function fail(msg) {
  failures++;
  console.log("  FAIL  " + msg);
}
function warn(msg) {
  warnings++;
  console.log("  warn  " + msg);
}

function walk(dir, out) {
  out = out || [];
  for (const name of fs.readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------- 0. 运行时版本

console.log("[0/7] 运行时版本");
{
  // jsdom 30 要求 Node ^22.22.2 || ^24.15.0 || >=26。跑低了不会给出清楚的报错，
  // 而是它依赖的 undici 直接崩：
  //   TypeError: webidl.util.markAsUncloneable is not a function
  // CI 里曾经就因为在 Node 20 上跑，四个测试文件全挂，所以这里提前拦一道。
  const [maj, min, patch] = process.versions.node.split(".").map(Number);
  const v = [maj, min, patch];
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const okNode =
    (maj === 22 && cmp(v, [22, 22, 2]) >= 0) ||
    (maj === 24 && cmp(v, [24, 15, 0]) >= 0) ||
    maj >= 26;
  if (okNode) ok(`Node ${process.versions.node}（满足 jsdom 30 的引擎要求）`);
  else fail(`Node ${process.versions.node} 不满足 jsdom 30 要求：^22.22.2 || ^24.15.0 || >=26`);

  let jsdomPkg = null;
  try {
    jsdomPkg = require("jsdom/package.json");
  } catch (e) {
    warn("没装 jsdom，跳过依赖检查（先跑 npm install）");
  }
  if (jsdomPkg) ok(`jsdom ${jsdomPkg.version}`);
  try {
    ok(`undici ${require("undici/package.json").version}`);
  } catch (e) {
    warn("没找到 undici（jsdom 的依赖）");
  }

  // 测试文件清单：npm test 里显式列了这几个文件。
  // 不要退回 `node --test tests/`（Node 22 会把目录当模块名，
  // 报 Cannot find module .../tests），也不要用 glob（不同 Node 版本
  // 对 --test 的 glob 支持不一致）。加了新测试文件却忘了写进 package.json
  // 的话，这里会提醒。
  const TEST_FILES = [
    "tests/letters.test.js",
    "tests/reading.test.js",
    "tests/langs.test.js",
    "tests/sljfaq-words.test.js",
    "tests/cjk.test.js",
    "tests/cn-line.test.js",
    "tests/numbers.test.js",
    "tests/furigana.test.js",
    "tests/dict.test.js",
    "tests/annotate.test.js",
    "tests/correct.test.js",
    "tests/llm.test.js",
    "tests/usage.test.js",
    "tests/learn.test.js",
    "tests/promote.test.js",
    "tests/integration.test.js",
  ];
  const missing = TEST_FILES.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  if (missing.length) fail("测试文件不存在：" + missing.join(", "));
  const onDisk = fs
    .readdirSync(path.join(ROOT, "tests"))
    .filter((f) => f.endsWith(".test.js"))
    .map((f) => "tests/" + f);
  const notListed = onDisk.filter((f) => !TEST_FILES.includes(f));
  if (notListed.length) warn("tests/ 下有没被 npm test 覆盖的测试文件：" + notListed.join(", "));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  for (const f of TEST_FILES) {
    if (!pkg.scripts.test.includes(f)) fail(`npm test 里没有包含 ${f}`);
    // test:serial 是沙箱里唯一能用的跑法（node --test 会 spawn 子进程），
    // 漏登记的话新测试在本地永远跑不到。
    if (!pkg.scripts["test:serial"].includes(f)) fail(`npm run test:serial 里没有包含 ${f}`);
  }
  if (!missing.length && !notListed.length) ok(`npm test 覆盖全部 ${TEST_FILES.length} 个测试文件`);
}

// ---------------------------------------------------------------- 1. 语法

console.log("[1/7] 语法检查");
const jsFiles = walk(SRC)
  .concat(walk(path.join(ROOT, "tools")), walk(path.join(ROOT, "tests")))
  .filter((f) => f.endsWith(".js"));
for (const f of jsFiles) {
  const rel = path.relative(ROOT, f);
  try {
    // 只编译，不执行；能挡住语法错误和明显的非法 token
    new vm.Script(fs.readFileSync(f, "utf8"), { filename: rel });
  } catch (e) {
    fail(`${rel}: ${e.message}`);
  }
}
if (failures === 0) ok(`${jsFiles.length} 个 JS 文件语法正常`);

/*
 * src/ 必须能在网易云内置的老 CEF 里跑：只许 ES5（var / function / 不用模板字符串）。
 * vm.Script 只保证"Node 能编译"，所以这里单独扫一遍 —— 不然 `const f = () => 1`
 * 会一路通过 check、被打进包，真机上才炸。
 *
 * 做法：先把注释和字符串抹掉（保留换行，行号对得上），再看剩下的代码里有没有
 * ES6+ 的记号。反引号本身就是违规信号，所以扫到就直接记一笔再跳过整段。
 */
function es5Violations(src) {
  const marks = [];
  let code = "";
  let i = 0;
  const n = src.length;
  let line = 1;
  while (i < n) {
    const ch = src.charAt(i);
    if (ch === "\n") {
      code += "\n";
      line++;
      i++;
      continue;
    }
    if (ch === "/" && src.charAt(i + 1) === "/") {
      while (i < n && src.charAt(i) !== "\n") i++;
      continue;
    }
    if (ch === "/" && src.charAt(i + 1) === "*") {
      i += 2;
      while (i < n && !(src.charAt(i) === "*" && src.charAt(i + 1) === "/")) {
        if (src.charAt(i) === "\n") {
          code += "\n";
          line++;
        }
        i++;
      }
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < n) {
        const c = src.charAt(i);
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === "\n") {
          code += "\n";
          line++;
          i++;
          break;
        }
        if (c === quote) {
          i++;
          break;
        }
        i++;
      }
      code += " ";
      continue;
    }
    if (ch === "`") {
      const at = line;
      i++;
      while (i < n) {
        const c = src.charAt(i);
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === "`") {
          i++;
          break;
        }
        if (c === "\n") {
          code += "\n";
          line++;
        }
        i++;
      }
      code += " ";
      yieldMark(at, "模板字符串");
      continue;
    }
    code += ch;
    i++;
  }
  function yieldMark(lineNo, what) {
    marks.push({ line: lineNo, what: what });
  }
  function scan(re, what) {
    const reG = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m;
    while ((m = reG.exec(code))) {
      const lineNo = code.slice(0, m.index).split("\n").length;
      marks.push({ line: lineNo, what: what + "：" + m[0].trim().slice(0, 40) });
      if (reG.lastIndex === m.index) reG.lastIndex++;
    }
  }
  scan(/\b(?:const|let)\b/, "ES6 声明");
  scan(/=>/, "箭头函数");
  scan(/\bclass\s+[A-Za-z_$]/, "class");
  scan(/\.\.\./, "展开/剩余参数");
  scan(/\basync\b|\bawait\b/, "async/await");
  scan(/function\s*\*/, "生成器");
  return marks;
}

const es5Bad = [];
for (const f of walk(SRC).filter((x) => x.endsWith(".js"))) {
  const rel = path.relative(ROOT, f);
  for (const v of es5Violations(fs.readFileSync(f, "utf8"))) {
    es5Bad.push(`${rel}:${v.line} 用了 ${v.what}`);
  }
}
if (es5Bad.length) {
  for (const b of es5Bad.slice(0, 12)) fail("src 必须是 ES5（老 CEF 跑不了）：" + b);
  if (es5Bad.length > 12) fail(`还有 ${es5Bad.length - 12} 处 ES6+ 写法`);
} else {
  ok(`${walk(SRC).filter((x) => x.endsWith(".js")).length} 个 src 文件都是 ES5 写法`);
}

// ---------------------------------------------------------------- 2. manifest

console.log("[2/7] manifest.json");
let manifest = null;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(SRC, "manifest.json"), "utf8"));
} catch (e) {
  fail("manifest.json 解析失败：" + e.message);
}
if (manifest) {
  if (manifest.manifest_version !== 1) fail("manifest_version 必须是 1");
  else ok("manifest_version = 1");
  for (const k of ["name", "slug", "version", "author"]) {
    if (!manifest[k]) fail(`缺字段 ${k}`);
  }
  if (manifest.slug && !/^[a-zA-Z0-9_-]+$/.test(manifest.slug)) fail("slug 含非法字符：" + manifest.slug);
  else if (manifest.slug) ok("slug = " + manifest.slug);
  if (manifest.version && !/^\d+\.\d+\.\d+/.test(manifest.version)) warn("version 不像语义化版本：" + manifest.version);
  if (manifest.preview && !fs.existsSync(path.join(SRC, manifest.preview))) fail(`preview 指向的文件不存在：${manifest.preview}`);
  else if (manifest.preview) ok("preview 存在：" + manifest.preview);
  if (manifest.type === "extension") ok('type = "extension"');
  else warn('type 建议为 "extension"，当前：' + manifest.type);
  if (manifest["ncm3-compatible"]) ok("声明兼容网易云 3.x");
  if (manifest.author === "OWNER") warn("manifest.author 还是占位符 OWNER，发布前记得改");
}

// ---------------------------------------------------------------- 3. 注入清单

console.log("[3/7] 注入清单");
// 顺序表和 build 共用一份（tools/inject-order.js），别在这里再抄一遍
const { WANT_ORDER, injectPath } = require("./inject-order");
if (manifest && manifest.injects && manifest.injects.Main) {
  const files = manifest.injects.Main.map((i) => i.file);
  for (const f of files) {
    if (!fs.existsSync(injectPath(ROOT, SRC, f))) fail("注入的文件不存在：" + f);
    if (!/\.m?js$/.test(f)) fail("注入文件必须以 .js 结尾：" + f);
  }
  if (files.join(",") !== WANT_ORDER.join(",")) fail(`注入顺序不对：${files.join(" -> ")}`);
  else ok("注入顺序正确：" + files.join(" -> "));
  // main.js 依赖前四个模块，顺序错了会直接报「核心模块未注入」
  const mainIdx = files.indexOf("main.js");
  if (mainIdx !== files.length - 1) fail("main.js 必须最后注入");
} else {
  fail("manifest 里没有 injects.Main");
}

// ---------------------------------------------------------------- 4. 词典

console.log("[4/7] 离线词典");
let dict = null;
try {
  dict = require(path.join(SRC, "core", "dict.js"));
} catch (e) {
  fail("dict.js 加载失败：" + e.message);
}
if (dict) {
  const keys = Object.keys(dict.words);
  if (keys.length < 300) fail(`词典条目太少：${keys.length}`);
  else ok(`词典 ${keys.length} 条`);
  let badKey = 0;
  let badVal = 0;
  for (const k of keys) {
    if (!/^[a-z]+$/.test(k)) badKey++;
    const v = dict.words[k];
    if (typeof v !== "string" || !/^[\u30A0-\u30FF\u30FC]+$/.test(v)) badVal++;
  }
  if (badKey) fail(`有 ${badKey} 个键不是小写英文（种子表的 en 侧写脏了）`);
  if (badVal) fail(`有 ${badVal} 个读音不是纯片假名`);
  if (!badKey && !badVal) ok("词典键值格式正常");
  if (dict.count !== keys.length) fail(`dict.count(${dict.count}) 与实际条目数(${keys.length}) 不一致`);
}

// ---------------------------------------------------------------- 4.5 借词表

console.log("[4.5/7] 借词表");
{
  // core/loan.js 是 tools/build-loan.js 从 tools/vendor/loan/*.txt 生成的（勿手改）。
  // 手工改了 txt 却没重新生成、或者反过来直接改 JS，都在这里露馅。
  const LOAN_DIR = path.join(__dirname, "vendor", "loan");
  let loan = null;
  try {
    loan = require(path.join(SRC, "core", "loan.js"));
  } catch (e) {
    fail("loan.js 加载失败：" + e.message);
  }
  if (loan) {
    const RE_KANA = /^[\u30A1-\u30F6\u30FC]+$/;
    const files = fs.existsSync(LOAN_DIR) ? fs.readdirSync(LOAN_DIR).filter((x) => x.endsWith(".txt")) : [];
    if (!files.length) warn("tools/vendor/loan 下没有借词表（外语行只剩拼读规则）");
    let total = 0;
    let bad = 0;
    for (const f of files) {
      const id = path.basename(f, ".txt");
      const pairs = new Map();
      for (const raw of fs.readFileSync(path.join(LOAN_DIR, f), "utf8").split(/\r?\n/)) {
        const t = raw.trim();
        if (!t || t.charAt(0) === "#") continue;
        const at = t.indexOf(":");
        if (at <= 0) {
          fail(`${f}: 这行没有冒号：${t}`);
          bad++;
          continue;
        }
        const w = t.slice(0, at).trim();
        const k = t.slice(at + 1).trim();
        if (!RE_KANA.test(k)) {
          fail(`${f}: 读音不是纯片假名：${t}`);
          bad++;
          continue;
        }
        if (pairs.has(w)) {
          fail(`${f}: 重复的词 ${w}`);
          bad++;
          continue;
        }
        pairs.set(w, k);
      }
      const got = loan.get(id) || {};
      total += pairs.size;
      for (const [w, k] of pairs) {
        if (got[w] !== k) {
          fail(`core/loan.js 与 ${f} 不一致：${w} 应为 ${k}，实际 ${got[w]}（跑 npm run build:loan）`);
          bad++;
          break;
        }
      }
      if (Object.keys(got).length !== pairs.size) {
        fail(`core/loan.js 的 ${id} 条数不对：${Object.keys(got).length} vs ${pairs.size}（跑 npm run build:loan）`);
        bad++;
      }
    }
    if (loan.count !== total) fail(`loan.count(${loan.count}) 与实际条目数(${total}) 不一致`);
    if (!bad) ok(`借词表与 tools/vendor/loan/*.txt 一致（${total} 条）`);
  }
}

// ---------------------------------------------------------------- 4.6 官方歌名读音

console.log("[4.6/7] 官方歌名读音");
{
  const SEKAI_VENDOR = path.join(__dirname, "vendor", "sekai", "musics.json");
  const SEKAI_SEED = path.join(__dirname, "seed-words-sekai.js");
  if (!fs.existsSync(SEKAI_VENDOR)) {
    warn("没有 tools/vendor/sekai/musics.json（官方歌名读音只剩已生成的那份）");
  } else if (!fs.existsSync(SEKAI_SEED)) {
    fail("缺少 tools/seed-words-sekai.js（跑 npm run build:sekai）");
  } else {
    let want = null;
    try {
      // 生成器不写盘，只返回内容 —— 和提交进去的那份逐字节比
      want = require("./build-sekai.js").generate().content;
    } catch (e) {
      fail("tools/build-sekai.js 跑不动：" + e.message);
    }
    if (want !== null) {
      if (want !== fs.readFileSync(SEKAI_SEED, "utf8")) {
        fail("tools/seed-words-sekai.js 与 vendor/sekai/musics.json 不一致（跑 npm run build:sekai）");
      } else {
        ok("官方歌名读音与 tools/vendor/sekai/musics.json 一致（" + require(SEKAI_SEED).length + " 条）");
      }
    }
  }
}

// ---------------------------------------------------------------- 4.7 整首专属读音

console.log("[4.7/7] 整首专属读音");
{
  const SONGS = path.join(SRC, "core", "songs.js");
  if (!fs.existsSync(SONGS)) {
    fail("缺少 src/core/songs.js（跑 npm run build:songs）");
  } else {
    let want = null;
    try {
      const g = require("./build-song-readings.js").generate();
      want = require("./build-song-readings.js").content(g.entries);
    } catch (e) {
      fail("tools/build-song-readings.js 跑不动：" + e.message);
    }
    if (want !== null) {
      if (want !== fs.readFileSync(SONGS, "utf8")) {
        fail("src/core/songs.js 与 tools/song-readings-hand.js + vendor/sekai 不一致（跑 npm run build:songs）");
      } else {
        const mod = require(SONGS);
        ok("整首专属读音与手工表 + tools/vendor/sekai/musics.json 一致（" + mod.count + " 条）");
      }
    }
  }
}

// ---------------------------------------------------------------- 4.8 沉淀表 -> 词典
//
// `promote:learned` 重写 tools/seed-words-learned.js、`build:dict` 把它并进词典 ——
// 两步之间断了（改了素材没重新构建、或者构建失败）不会有人报错，词就那么静默丢了。
// 这里按"沉淀表里的每一条都应该出现在词典里"对一遍。

console.log("[4.8/7] 沉淀表与词典一致");
{
  const SEED = path.join(__dirname, "seed-words-learned.js");
  if (!fs.existsSync(SEED)) {
    warn("没有 tools/seed-words-learned.js（还没沉淀过任何词，正常）");
  } else if (!dict) {
    warn("词典没加载成功，跳过沉淀表比对");
  } else {
    let rows = [];
    try {
      rows = require(SEED);
    } catch (e) {
      fail("seed-words-learned.js 加载失败：" + e.message);
    }
    if (rows.length) {
      const missingSeed = rows.filter((r) => !r || dict.words[r.en] === undefined);
      if (missingSeed.length) {
        fail(
          `${missingSeed.length} 条沉淀词不在词典里（promote:learned 之后忘了 build:dict？）：` +
            missingSeed.slice(0, 5).map((m) => (m && m.en) || "?").join(", ")
        );
      } else {
        ok(`沉淀表 ${rows.length} 条都在词典里`);
      }
    }
  }
}

// ---------------------------------------------------------------- 4.9 汉字读音表
//
// 汉字表是生成物（tools/build-hanzi.js 从 pinyin-pro 生成）。这里重新生成一遍对一遍：
// 生成器和产物不同步时立刻能看出来（和 dict / loan / songs 那几节同一个口径）。

console.log("[4.9/7] 汉字读音表");
{
  const HANZI = path.join(SRC, "core", "hanzi.js");
  if (!fs.existsSync(HANZI)) {
    fail("缺少 src/core/hanzi.js（跑 npm run build:hanzi）");
  } else {
    let want = null;
    try {
      const gen = require("./build-hanzi.js");
      want = gen.content(gen.generate());
    } catch (e) {
      warn("生成不了汉字表（pinyin-pro 没装？）：" + e.message);
    }
    if (want !== null) {
      if (want !== fs.readFileSync(HANZI, "utf8")) {
        fail("src/core/hanzi.js 与 tools/build-hanzi.js 的生成结果不一致（跑 npm run build:hanzi）");
      } else {
        const mod = require(HANZI);
        const bad = Object.keys(mod.kana).filter((k) => !/^[\u30A1-\u30F6\u30FC]+$/.test(mod.kana[k]));
        if (bad.length) fail(`${bad.length} 个汉字的读音不是纯片假名：` + bad.slice(0, 5).join(", "));
        else ok(`汉字表 ${mod.count} 条，与生成器一致`);
      }
    }
  }
}

// ---------------------------------------------------------------- 5. 元信息一致性

console.log("[5/7] 元信息与仓库地址");
const MANIFEST = manifest || {};
const EXPECTED_OWNER = "YXLEI0";
const EXPECTED_REPO = "lyric-ruby-betterncm";
if (MANIFEST.author && MANIFEST.author !== EXPECTED_OWNER) {
  warn(`manifest.author 是「${MANIFEST.author}」，与预期维护者（${EXPECTED_OWNER}）不一致`);
}
if (!MANIFEST.author_link) warn("manifest.author_link 为空，商店里不会显示作者主页");
const mainSrc = fs.readFileSync(path.join(SRC, "main.js"), "utf8");
const repoUrl = /var REPO_URL = "([^"]+)"/.exec(mainSrc);
if (!repoUrl) {
  fail("main.js 里找不到 REPO_URL");
} else {
  const url = repoUrl[1];
  const want = `https://github.com/${EXPECTED_OWNER}/${EXPECTED_REPO}`;
  if (url !== want) fail(`main.js 的 REPO_URL 不对：\n         实际 ${url}\n         应为 ${want}`);
  else ok("main.js 的 REPO_URL 与仓库一致");
  if (/OWNER/.test(url)) fail("REPO_URL 里还有 OWNER 占位符");
}
let placeholders = 0;
for (const f of walk(SRC)) {
  if (!f.endsWith(".js") && !f.endsWith(".json")) continue;
  const n = (fs.readFileSync(f, "utf8").match(/OWNER/g) || []).length;
  if (n) {
    fail(`${path.relative(ROOT, f)} 里还有 ${n} 处 OWNER 占位符`);
    placeholders += n;
  }
}
if (!placeholders) ok("没有残留的 OWNER 占位符");

// ---------------------------------------------------------------- 6. 秘密信息

console.log("[6/7] 秘密信息检查");
const SECRET_PATTERNS = [
  [/gh[pousr]_[A-Za-z0-9]{20,}/, "GitHub token"],
  [/github_pat_[A-Za-z0-9_]{20,}/, "GitHub fine-grained token"],
  [/AKIA[0-9A-Z]{16}/, "AWS access key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "私钥"],
  [/sk-[A-Za-z0-9]{32,}/, "OpenAI 风格密钥"],
];
let found = 0;
for (const f of walk(ROOT)) {
  const rel = path.relative(ROOT, f);
  if (rel.startsWith("node_modules") || rel.startsWith(".git" + path.sep)) continue;
  if (f.endsWith(".png") || f.endsWith(".gz") || f.endsWith(".plugin")) continue;
  let text;
  try {
    text = fs.readFileSync(f, "utf8");
  } catch (e) {
    continue;
  }
  for (const [re, name] of SECRET_PATTERNS) {
    if (re.test(text)) {
      fail(`${rel} 里疑似有${name}`);
      found++;
    }
  }
}
if (!found) ok("没有发现疑似密钥");

// ---------------------------------------------------------------- 结果

console.log("");
if (failures) {
  console.log(`检查未通过：${failures} 个错误，${warnings} 个警告`);
  process.exit(1);
}
console.log(`检查通过（${warnings} 个警告）`);
