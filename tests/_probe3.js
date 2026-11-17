/* 排障：整行分词里 正銘 到底有没有读音 */
"use strict";
const fs = require("fs");
const path = require("path");
const { loadCore, loadScripts, VENDOR_FILES, VENDOR_KUROMOJI, ROOT } = require("./helpers");

const ctx = loadCore("<!doctype html><html><body></body></html>");
const W = ctx.window;
loadScripts(ctx.dom, [VENDOR_KUROMOJI].concat(VENDOR_FILES));
W.betterncm = {
  fs: {
    readFile(p) {
      const buf = fs.readFileSync(p);
      const u8 = new W.Uint8Array(buf.length);
      u8.set(buf);
      return u8.buffer;
    },
  },
};
W.WKFurigana.configure({ dicPath: path.join(ROOT, "vendor", "dict") });
W.WKFurigana.load(() => {});

const LINE = "はい そうです 正真正銘 僕のせいだった";

const timer = setInterval(() => {
  if (!W.WKFurigana.ready()) return;
  clearInterval(timer);
  const toks = W.WKFurigana.tokens(LINE);
  console.log("tokens:", JSON.stringify(Array.from(toks || [], (t) => [t.text, t.kana, t.start, t.end])));
  if (W.WKFurigana.rawTokenize) {
    console.log("raw:", JSON.stringify(W.WKFurigana.rawTokenize(LINE)));
  }
  process.exit(0);
}, 100);
