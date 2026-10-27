/*
 * 打包：把 src/ 打成 builds/lyric-ruby.plugin（.plugin 就是个 zip，文件在 zip 根目录）。
 *
 *   node tools/build.js
 *   node tools/build.js --install              复制到 C:\betterncm\plugins
 *   node tools/build.js --install --dir <路径>
 *
 * 自己写 zip 而不是调 Compress-Archive：PowerShell 的 ZipFile::CreateFromDirectory 会把
 * 条目名写成反斜杠（不符合 ZIP 规范，解压端可能不建子目录），而且 PS 5.1 读没有 BOM 的
 * .ps1 会按 ANSI 解，中文注释一乱语法就崩。Node 两个坑都没有，CI 里也不必用 Windows runner。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");
const OUT_DIR = path.join(ROOT, "builds");

/*
 * 打包用的时间戳（可重复构建）。
 *
 * zip 的每个条目都要带一个 DOS 时间。以前取的是文件的 mtime —— 那是 checkout
 * 的时刻，同一份源码在两台机器、两次 clone 上就打出两个不同字节的包，
 * Release 附件也就没法用 sha256 复核（本仓库真踩过：只改 TZ 重打，hash 就变了）。
 *
 * 现在的取法，优先级从高到低：
 *   1. 环境变量 SOURCE_DATE_EPOCH（秒，可重复构建的通用约定）；
 *   2. git HEAD 的提交时间 —— CI 和本地 checkout 都能算出一致的值；
 *   3. 兜底 1980-01-01（zip 能表示的最早时间）。
 * 换算和写入都走 UTC（见 dosDateTime），所以时区不影响结果。
 */
function buildEpoch() {
  const env = process.env.SOURCE_DATE_EPOCH;
  if (env && /^\d+$/.test(env)) return Number(env) * 1000;
  try {
    const out = execSync("git log -1 --format=%ct", {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (/^\d+$/.test(out)) return Number(out) * 1000;
  } catch (e) {
    /* 不是 git checkout（比如从 zip 解出来的源码）：用兜底时间 */
  }
  return Date.UTC(1980, 0, 1);
}

const BUILD_DATE = new Date(buildEpoch());

/*
 * 打进包的文件清单从 manifest.json 推出来，不再手写第二份。
 *
 * 之前这里是硬编码的数组，加一个 core/llm.js 就得同时改三处
 * （manifest、这里的 SRC_FILES、ALLOWED_CORE），漏一处就在打包时才炸。
 * 现在唯一的事实来源是 manifest 的 injects 顺序，外加 manifest.json 与预览图。
 */
const MANIFEST = JSON.parse(fs.readFileSync(path.join(SRC, "manifest.json"), "utf8"));
const INJECTED = ((MANIFEST.injects && MANIFEST.injects.Main) || []).map((i) => i.file);
const SRC_FILES = ["manifest.json"].concat(INJECTED).concat([MANIFEST.preview || "preview.png"]);

/*
 * 注入文件分两处：core/*.js 与 main.js 在 src/ 下，vendor/kuromoji.js、vendor/furigana.js
 * 在仓库根的 vendor/ 下（那是第三方代码，不参与 src 的 ES5 检查）。
 * 进包的名字就是清单里写的那个，不做改名。
 */
const { injectPath } = require("./inject-order");

/** vendor/ 下除了注入的 js，还有振假名词典（dict/*.dat.gz）和第三方许可文件：全部进包 */
function vendorEntries() {
  const out = [];
  const base = path.join(ROOT, "vendor");
  if (!fs.existsSync(base)) return out;
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const relName = rel ? rel + "/" + name : name;
      if (fs.statSync(full).isDirectory()) walk(full, relName);
      else out.push("vendor/" + relName);
    }
  };
  walk(base, "");
  return out;
}

// src/ 下允许存在的全部内容（多出来说明有临时文件误提交）
const ALLOWED_TOP = new Set(["manifest.json", "main.js", "preview.png", "core"]);
const ALLOWED_CORE = new Set(
  INJECTED.filter((f) => f.indexOf("core/") === 0).map((f) => f.slice("core/".length))
);

// ---------------------------------------------------------------- zip

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosDateTime(date) {
  // 一律按 UTC 取字段：本地时区会让同一份源码打出不同的包（见 BUILD_DATE 的说明）
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = zlib.deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);
    const { time, date } = dosDateTime(entry.mtime);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // 通用标志位：文件名为 UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, compressed);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); // 同样标 UTF-8
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, end]);
}

// ---------------------------------------------------------------- 收集与自检

function collect() {
  const entries = [];
  const seen = new Set();
  const add = (fullPath, name) => {
    if (seen.has(name)) return; // vendor 里被 manifest 注入的 js 会走两遍
    if (!fs.existsSync(fullPath)) throw new Error(`缺少 ${name}（先跑 npm run build:dict / build:preview 生成）`);
    seen.add(name);
    entries.push({ name, data: fs.readFileSync(fullPath), mtime: BUILD_DATE });
  };
  for (const f of SRC_FILES) add(injectPath(ROOT, SRC, f), f);
  for (const f of vendorEntries()) add(path.join(ROOT, f), f);
  return entries;
}

function selfCheck(entries) {
  // 1. 条目名必须用正斜杠，且 manifest.json 必须在最外层
  for (const e of entries) {
    if (e.name.includes("\\")) throw new Error(`条目名里有反斜杠：${e.name}`);
  }
  if (!entries.some((e) => e.name === "manifest.json"))
    throw new Error("manifest.json 不在 zip 根层，BetterNCM 会认不出来");

  // 2. src/ 里不能有打包清单之外的文件（商店按 subpath 打包整个目录）
  const top = fs.readdirSync(SRC).filter((f) => f !== ".gitkeep");
  const extraTop = top.filter((f) => !ALLOWED_TOP.has(f));
  if (extraTop.length) throw new Error(`src/ 里有不该分发的文件：${extraTop.join(", ")}`);
  const missingTop = [...ALLOWED_TOP].filter((f) => !top.includes(f));
  if (missingTop.length) throw new Error(`src/ 缺少：${missingTop.join(", ")}`);

  const core = fs.readdirSync(path.join(SRC, "core")).filter((f) => f !== ".gitkeep");
  const extraCore = core.filter((f) => !ALLOWED_CORE.has(f));
  if (extraCore.length) throw new Error(`src/core/ 里有不该分发的文件：${extraCore.join(", ")}`);
  const missingCore = [...ALLOWED_CORE].filter((f) => !core.includes(f));
  if (missingCore.length) throw new Error(`src/core/ 缺少：${missingCore.join(", ")}`);

  // 3. manifest 的结构与 injects 顺序
  const mf = JSON.parse(fs.readFileSync(path.join(SRC, "manifest.json"), "utf8"));  if (mf.manifest_version !== 1) throw new Error("manifest_version 必须是 1");
  for (const field of ["name", "slug", "version", "author"]) {
    if (!mf[field]) throw new Error(`manifest.json 缺 ${field}`);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(mf.slug)) throw new Error("slug 只能包含英文、数字、横杠、下划线");
  if (!mf.preview) throw new Error("manifest.json 缺 preview，商店要求预览图");
  if (!entries.some((e) => e.name === mf.preview)) throw new Error(`manifest 声明的预览图 ${mf.preview} 不在包里`);

  const injected = (mf.injects && mf.injects.Main) || [];
  if (!injected.length) throw new Error("manifest.json 没有 Main 注入项");
  const injectedFiles = injected.map((i) => i.file);
  for (const f of injectedFiles) {
    if (!/\.m?js$/.test(f)) throw new Error(`注入文件必须以 .js 结尾：${f}`);
    if (!entries.some((e) => e.name === f)) throw new Error(`manifest 注入的 ${f} 不在包里`);
  }
  /*
   * 注入顺序：和 check 共用同一份清单（tools/inject-order.js）。
   * 这里以前只比 6 个文件（letters/dict/reading/correct/annotate/main），
   * 剩下 7 个放哪都通过 —— 于是 `install:plugin` 能装出 check 会拒绝的包。
   */
  const { WANT_ORDER } = require("./inject-order");
  if (injectedFiles.join(",") !== WANT_ORDER.join(","))
    throw new Error(`injects 顺序不对，应为 ${WANT_ORDER.join(" -> ")}，实际 ${injectedFiles.join(" -> ")}`);

  // 4. 词典非空、且不含明显坏值
  const dictJs = fs.readFileSync(path.join(SRC, "core", "dict.js"), "utf8");
  const m = /count:\s*(\d+)/.exec(dictJs);
  const count = m ? Number(m[1]) : 0;
  if (count < 100) throw new Error(`离线词典只有 ${count} 条，太小了（先跑 npm run build:dict）`);
  // 只在词典字面量里查坏值：注释里出现 "NaN" 这种词是正常的
  // （本插件的键是英文、值是片假名，字面量叫 words 而不是 WORDS）
  const body = /var words = \{([\s\S]*?)\n  \};/.exec(dictJs);
  if (!body) throw new Error("dict.js 里找不到 words 字面量，检查生成脚本");
  if (/undefined|NaN/.test(body[1])) throw new Error("词典里出现了 undefined/NaN，检查生成脚本");
  const actual = (body[1].match(/":/g) || []).length;
  if (actual !== count) throw new Error(`dict.count(${count}) 与实际条目数(${actual}) 不一致`);

  return { manifest: mf, dictCount: count, injectedFiles };
}

// ---------------------------------------------------------------- 主流程

function main() {
  const args = process.argv.slice(2);
  const entries = collect();
  const info = selfCheck(entries);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `${info.manifest.slug}.plugin`);
  fs.writeFileSync(out, buildZip(entries));

  const mb = (fs.statSync(out).size / 1048576).toFixed(2);
  console.log(`已打包 ${info.manifest.name} v${info.manifest.version}`);
  console.log(`  ${entries.length} 个条目，离线词典 ${info.dictCount} 条，${mb} MB`);
  console.log(`  -> ${path.relative(ROOT, out)}`);
  console.log(`  注入顺序：${info.injectedFiles.join(" -> ")}`);

  if (args.includes("--install")) {
    const i = args.indexOf("--dir");
    const dir = i >= 0 && args[i + 1] ? args[i + 1] : "C:\\betterncm\\plugins";
    if (!fs.existsSync(dir)) throw new Error(`找不到插件目录 ${dir}`);
    const dest = path.join(dir, path.basename(out));
    fs.copyFileSync(out, dest);
    console.log(`已复制到 ${dest}，重启网易云生效`);
    /*
     * 1.0 改名前叫 western-katakana：老包留着会和新的同时注音（一行两个 ruby）。
     * 安装时顺手删掉，免得每次都要提醒"记得卸载旧版"。
     */
    const legacy = path.join(dir, "western-katakana.plugin");
    if (fs.existsSync(legacy)) {
      fs.unlinkSync(legacy);
      console.log(`已删除改名前的老包 ${legacy}`);
    }
  }
}

main();
