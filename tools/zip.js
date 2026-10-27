/*
 * 读 .plugin（zip）的小工具：verify-install 与调试脚本共用。
 *
 * 只认标准做法：从 EOCD 拿中央目录，按中央目录里的偏移去取本地头 —— 这样不管写入端
 * 有没有用 data descriptor（标志位 3）都能读对。以前从本地头顺序扫，遇到
 * 设置了 descriptor 的包会少读两三条（真机包永远是自己的 build.js 写的，
 * 但别人给的包就说不准了）。
 */
"use strict";

const zlib = require("zlib");

function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("不是有效的 zip（找不到 EOCD）");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const nl = buf.readUInt16LE(p + 28);
    const el = buf.readUInt16LE(p + 30);
    const cm = buf.readUInt16LE(p + 32);
    const name = buf.toString("utf8", p + 46, p + 46 + nl);
    const method = buf.readUInt16LE(p + 10);
    const cs = buf.readUInt32LE(p + 20);
    const lo = buf.readUInt32LE(p + 42);
    const lnl = buf.readUInt16LE(lo + 26);
    const lel = buf.readUInt16LE(lo + 28);
    const raw = buf.slice(lo + 30 + lnl + lel, lo + 30 + lnl + lel + cs);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    entries.push({ name: name, data: data, method: method });
    p += 46 + nl + el + cm;
  }
  return entries;
}

module.exports = { readZip };
