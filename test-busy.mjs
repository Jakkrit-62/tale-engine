import { JSDOM } from "jsdom";
import fs from "fs";
import path from "path";
import "fake-indexeddb/auto";

// 503 "model is overloaded" — switch model / wait, instead of giving up
const DIR = path.resolve(".");
const html = fs.readFileSync(path.join(DIR, "index.html"), "utf8");
const appjs = fs.readFileSync(path.join(DIR, "app.js"), "utf8");
const qidianjs = fs.readFileSync(path.join(DIR, "qidian-mode", "qidian.js"), "utf8");

let pass = 0, fail = 0;
const out = [];
function check(name, cond, extra) {
  if (cond) { pass++; out.push("  ✅ " + name); }
  else { fail++; out.push("  ❌ " + name + (extra ? "  → " + extra : "")); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function settle(n = 60) { for (let i = 0; i < n; i++) await sleep(4); }

const REPLY = "ลมหนาวพัดผ่านตรอกแคบ \"เจ้าจะไปไหน\" เสียงหนึ่งดังขึ้น\nจะทำอย่างไรต่อ?\n" +
  '<<STATE>>{"hp":20,"maxHp":20,"level":1,"xp":0,"skills":[],"inventory":[],"location":"ตรอก","npcs":[],"flags":[]}';
let busyModels = new Set();       // these answer 503
let busyUntil = 0;                // everything 503 until this time
const hits = [];
const waits = [];

const dom = new JSDOM(html, { url: "https://example.org/tale/", pretendToBeVisual: true, runScripts: "outside-only" });
const win = dom.window;
win.indexedDB = globalThis.indexedDB;
win.IDBKeyRange = globalThis.IDBKeyRange;
for (const k of ["AbortController", "ReadableStream", "TextDecoder", "TextEncoder", "Blob", "Intl"]) win[k] = globalThis[k];
win.confirm = () => true;
Object.defineProperty(win.navigator, "serviceWorker", { value: { register: async () => ({}) }, configurable: true });
// time passes 100× faster so the 2 s / 10 s waits don't slow the suite
const realSetTimeout = win.setTimeout.bind(win);
win.setTimeout = (fn, ms, ...a) => { if (ms >= 1000) waits.push(ms); return realSetTimeout(fn, ms >= 1000 ? ms / 100 : ms, ...a); };
win.fetch = async (url, opts) => {
  const model = decodeURIComponent(String(url).match(/models\/([^:]+):/)[1]);
  const body = JSON.parse(opts.body);
  const sys = body.systemInstruction?.parts?.[0]?.text || "";
  if (!sys.includes("ผู้ช่วยสรุปเนื้อเรื่อง")) hits.push(model);
  if (busyModels.has(model) || Date.now() < busyUntil) {
    return { ok: false, status: 503, json: async () => ({ error: { code: 503, status: "UNAVAILABLE", message: "The model is overloaded. Please try again later." } }) };
  }
  const enc = new TextEncoder();
  const sse = "data: " + JSON.stringify({ candidates: [{ content: { parts: [{ text: REPLY }] }, finishReason: "STOP" }] }) + "\n\n";
  return { ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(enc.encode(sse)); c.close(); } }) };
};
win.SpeechSynthesisUtterance = function () { };
win.speechSynthesis = { getVoices: () => [], speak: () => { }, cancel: () => { } };
const errors = [];
win.addEventListener("error", (e) => errors.push(String(e.message)));
console.error = (...a) => errors.push(a.map(String).join(" "));
win.eval(qidianjs);
win.eval(appjs);
const $ = (id) => win.document.getElementById(id);
const q = (s) => [...win.document.querySelectorAll(s)];
const aiCount = () => q("#log .msg.ai:not(.streaming)").length;
const lastErr = () => { const e = q("#log .msg.err"); return e.length ? e[e.length - 1].textContent : ""; };
async function act(text) {
  $("actionInput").value = text;
  $("sendBtn").click();
  const end = Date.now() + 8000;
  while (Date.now() < end && $("sendBtn").style.display === "none") await sleep(10);
  await settle(20);
}

console.log("\n═══ Tale Engine — overloaded server tests ═══\n");
await settle(150);
$("apiKeyInput").value = "K";
$("modelSelect").value = $("modelSelect").options[0].value;
$("saveKeyBtn").click(); await settle(20);
const chosen = await new Promise(r => { const req = globalThis.indexedDB.open("tale-engine", 1); req.onsuccess = () => { const g = req.result.transaction("settings").objectStore("settings").get("model"); g.onsuccess = () => r(g.result.v); }; });
$("setupName").value = "หยางจ่าน";
$("startBtn").click();
await settle(100);
const base = aiCount();
check("game started", base >= 1, "ai=" + base);

out.push("[1] Chosen model overloaded → another model answers");
busyModels = new Set([chosen]); hits.length = 0; waits.length = 0;
await act("มองไปรอบๆ");
check("reply arrived", aiCount() === base + 1 && !lastErr(), lastErr() || "ai=" + aiCount());
check("retried the busy model once, then switched", hits[0] === chosen && hits[1] === chosen && hits[2] && hits[2] !== chosen, hits.join(" → "));
check("short wait before the retry", waits.includes(2000), waits.join(","));
check("toast says it switched", /สลับไปใช้/.test($("toast").textContent), $("toast").textContent);

out.push("[2] All models busy for a moment → waits, then succeeds");
busyModels = new Set(); hits.length = 0; waits.length = 0;
busyUntil = Date.now() + 250;   // longer than one round (waits are 100× faster)
let sawMsg = "";
const watch = setInterval(() => { const s = q("#log .msg.ai.streaming")[0]; if (s && /มีคนใช้เยอะ/.test(s.textContent)) sawMsg = s.textContent; }, 2);
await act("เดินต่อ");
clearInterval(watch);
check("reply arrived after the wait", aiCount() === base + 2 && !lastErr(), lastErr() || "ai=" + aiCount());
check("waited 10 s once all models were busy", waits.includes(10000), waits.join(","));
check("wait message says server busy (not quota)", /มีคนใช้เยอะ/.test(sawMsg) && !/โควตา/.test(sawMsg), sawMsg);

out.push("[3] Busy for a long time → clear error, can retry");
busyUntil = Date.now() + 60000; hits.length = 0;
await act("วิ่ง");
check("gives up with the overloaded message", /มีคนใช้เยอะ/.test(lastErr()) && /ลองใหม่/.test(lastErr()), lastErr());
check("tried every model, two rounds", new Set(hits).size >= 3 && hits.length >= 12, hits.length + " calls: " + [...new Set(hits)].join(","));
busyUntil = 0;
const retry = q("#log .msg.err button").find(b => /ลองใหม่/.test(b.textContent));
retry.click();
const end = Date.now() + 8000;
while (Date.now() < end && aiCount() < base + 3) await sleep(10);
await settle(20);
check("🔄 ลองใหม่ works once the server is back", aiCount() === base + 3, "ai=" + aiCount());

out.push("[4] Test-connection button");
busyModels = new Set([chosen]); hits.length = 0;
$("openDrawer").click(); await settle(5);
$("settingsBtn").click(); await settle(5);
$("testKeyBtn").click();
const end2 = Date.now() + 8000;
await sleep(5);
while (Date.now() < end2 && $("testKeyBtn").disabled) await sleep(10);
check("test button reports busy (no silent switching)", /มีคนใช้เยอะ/.test($("keyStatus").textContent) && new Set(hits).size === 1, $("keyStatus").textContent);
busyModels = new Set();

check("no runtime errors", errors.filter(e => !/Not implemented|สรุปความจำ/.test(e)).length === 0, errors[0]);
console.log(out.join("\n"));
console.log("\n─────────────────────────────\nผ่าน " + pass + " / ล้มเหลว " + fail + "\n─────────────────────────────\n");
process.exit(fail ? 1 : 0);
