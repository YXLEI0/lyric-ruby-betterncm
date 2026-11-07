"use strict";
const { loadCore, loadScripts, VENDOR_FILES, CORE_FILES } = require("./helpers");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FILES = CORE_FILES.concat(["main.js"]);

const HTML = `<!doctype html><html><head></head><body>
<div class="m-lyric"><ul class="lyric">
  <li class="line"><p>これは解と行</p></li>
</ul></div></body></html>`;

const ctx = loadCore(HTML, { reader: false });
loadScripts(ctx.dom, VENDOR_FILES);
const window = ctx.window;
window.fetch = () => Promise.reject(new Error("offline"));
window.localStorage.setItem("lyric-ruby.config", JSON.stringify({ online: false, llmEnabled: false }));
const listeners = [];
window.betterncm = { app: { getBetterNCMVersion: () => Promise.resolve("1.3.4") }, ncm: { openUrl() {} }, fs: {} };
window.plugin = { devMode: false, pluginPath: "C:/betterncm/plugins/lyric-ruby", onLoad: (fn) => listeners.push(fn), onConfig() {} };
loadScripts(ctx.dom, FILES);

const fake = (table) => ({
  tokenize(text) {
    const out = [];
    let i = 0;
    while (i < text.length) {
      let hit = null;
      for (const s of Object.keys(table)) if (text.startsWith(s, i)) hit = s;
      if (hit) {
        out.push({ surface_form: hit, reading: table[hit], pronunciation: table[hit] });
        i += hit.length;
      } else {
        const ch = text.charAt(i);
        out.push({ surface_form: ch, reading: ch, pronunciation: ch });
        i += 1;
      }
    }
    return out;
  },
});

(async () => {
  window.WKFurigana.setTokenizer(fake({ 解: "ト", 行: "イ", これ: "コレ", は: "ハ", と: "ト" }));
  for (const fn of listeners) await fn();
  await sleep(600);
  const p = window.document.querySelector("ul.lyric li p");
  const rubies = Array.from(p.querySelectorAll("ruby.wk-ruby"));
  console.log("rubies:", rubies.map((r) => r.childNodes[0].nodeValue + "/" + r.querySelector(".wk-rt").textContent).join(" "));
  for (const r of rubies) {
    const word = (r.childNodes[0].nodeValue || "").trim();
    r.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    await sleep(30);
    const chips = Array.from(window.document.querySelectorAll(".wk-edit-box .wk-edit-variant")).map((b) => b.textContent);
    console.log(word, "=>", JSON.stringify(chips));
    const input = window.document.querySelector("input.wk-edit");
    if (input) input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await sleep(20);
  }
})();
