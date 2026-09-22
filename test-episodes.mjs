import { JSDOM } from "jsdom";
import fs from "fs";
import path from "path";
import "fake-indexeddb/auto";

// สร้างตอนอัตโนมัติ — the bottom-bar chapter generator
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

const STATE = '<<STATE>>{"hp":18,"maxHp":20,"level":1,"xp":5,"skills":[],"inventory":["คบไฟ"],"location":"หมู่บ้าน","npcs":[],"flags":[]}';
const PARA = "ลมหนาวพัดผ่านตรอกแคบ หยางจ่านดึงฮู้ดลงปิดหน้า \"เจ้าจะไปไหน\" เสียงหนึ่งดังขึ้นจากเงามืด\n\n";

// Each chapter comes back with a different heading shape, the way real
// models drift: plain, markdown + bold, Qidian ◇ couplet, and none at all.
const HEADS = [
  (n) => "ตอนที่ " + n + ": เงาในตรอกแคบ\n\n",
  (n) => "## **ตอนที่ " + n + " — ดาบที่ไม่มีชื่อ**\n\n",
  () => "◇ ผู้เก็บเถ้าลอบฟังใต้ชายคา / ทวนเก่าตื่นขึ้นกลางสายฝน\n\n",
  () => "",
];
let bodyRepeat = 3;
let epReplies = 0;
let lastBody = null, sysCalls = 0, lastSummaryPrompt = "";
let failNext = false;

function reply(body) {
  const user = JSON.stringify(body.contents[body.contents.length - 1]);
  const m = user.match(/เขียนตอนที่ (\d+)/);
  if (!m) return PARA + "จะทำอย่างไรต่อ?\n" + STATE;           // opening / normal turn
  const n = +m[1];
  const head = HEADS[epReplies++ % HEADS.length](n);
  return head + PARA.repeat(bodyRepeat) + "เงานั้นขยับอีกครั้ง\n" + STATE;
}

const dom = new JSDOM(html, { url: "https://example.org/tale/", pretendToBeVisual: true, runScripts: "outside-only" });
const win = dom.window;
win.indexedDB = globalThis.indexedDB;
win.IDBKeyRange = globalThis.IDBKeyRange;
win.AbortController = globalThis.AbortController;
win.ReadableStream = globalThis.ReadableStream;
win.TextDecoder = globalThis.TextDecoder;
win.TextEncoder = globalThis.TextEncoder;
win.Blob = globalThis.Blob;
win.Intl = globalThis.Intl;
let lastDownload = null;
win.URL.createObjectURL = (b) => { lastDownload = b; return "blob:mock"; };
win.URL.revokeObjectURL = () => { };
win.confirm = () => true;
let promptAnswer = null;
win.prompt = () => promptAnswer;
Object.defineProperty(win.navigator, "serviceWorker", { value: { register: async () => ({}) }, configurable: true });
win.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  const sys = body.systemInstruction?.parts?.[0]?.text || "";
  const enc = new TextEncoder();
  let text;
  if (sys.includes("ผู้ช่วยสรุปเนื้อเรื่อง")) {
    sysCalls++;
    lastSummaryPrompt = body.contents[0].parts[0].text;
    text = "สรุปตอนที่ผ่านมา";
  } else {
    lastBody = body;
    if (failNext) {
      failNext = false;
      // 5xx is retried/switched now; a request rejected outright still ends the run
      return { ok: false, status: 400, body: null, json: async () => ({ error: { message: "boom" } }) };
    }
    text = reply(body);
  }
  const sse = "data: " + JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] }) + "\n\n";
  return { ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(enc.encode(sse)); c.close(); } }) };
};
const spoken = [];
win.SpeechSynthesisUtterance = function (text) { this.text = text; };
win.speechSynthesis = {
  getVoices: () => [{ name: "Google ไทย", lang: "th-TH" }],
  speak: (u) => spoken.push(u),
  cancel: () => { },
};

const errors = [];
win.addEventListener("error", (e) => errors.push(String(e.message)));
console.error = (...a) => errors.push(a.map(String).join(" "));
win.eval(qidianjs);
win.eval(appjs);

const $ = (id) => win.document.getElementById(id);
const q = (s) => win.document.querySelectorAll(s);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function settle(n = 60) { for (let i = 0; i < n; i++) await sleep(4); }
const sysText = () => lastBody.systemInstruction.parts[0].text;
const eps = () => q("#log .msg.ai.episode");
const heads = () => [...eps()].map(b => b.textContent.split("\n")[0]);
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(20); }
  return false;
}

console.log("\n═══ Tale Engine — auto chapter tests ═══\n");
await settle(150);
$("apiKeyInput").value = "K"; $("saveKeyBtn").click(); await settle(20);
$("setupName").value = "หยางจ่าน";
$("startBtn").click();
await settle(80);

out.push("[1] Bottom bar");
check("old quick-action chips are gone", !$("chips") && !q("[data-a]").length);
check("chapter button is there", $("epBtn") && /สร้างตอนอัตโนมัติ/.test($("epBtn").textContent));
check("next chapter number shown", $("epNo").textContent === "ตอนที่ 1", $("epNo").textContent);
check("chapter count picker defaults to 3", $("epCount").value === "3");

out.push("[2] Press once → three full chapters, then stop");
$("epBtn").click();
await settle(10);
check("button turns into a stop button while running", /หยุด/.test($("epBtn").textContent), $("epBtn").textContent);
check("header shows the run and the brake", $("headerHp").textContent.startsWith("📖") && $("autoStopBtn").style.display === "block");
await until(() => eps().length === 3 && !/หยุด/.test($("epBtn").textContent));
check("three chapters written", eps().length === 3, "got " + eps().length);
check("chapters numbered 1-3 with titles", JSON.stringify(heads()) ===
  JSON.stringify(["ตอนที่ 1: เงาในตรอกแคบ", "ตอนที่ 2: ดาบที่ไม่มีชื่อ", "ตอนที่ 3: ผู้เก็บเถ้าลอบฟังใต้ชายคา / ทวนเก่าตื่นขึ้นกลางสายฝน"]),
  JSON.stringify(heads()));
check("heading line styled", eps()[0].querySelector(".sent.eph") && !eps()[0].querySelector(".sent:last-child").classList.contains("eph"));
check("markdown junk stripped from titles", !/[#*—◇]/.test(heads().join(" ").replace(/ \/ /g, "")), heads().join(" | "));
check("run stopped by itself", !/หยุด/.test($("epBtn").textContent) && $("autoStopBtn").style.display === "none");
check("done message in log", [...q("#log .msg.sys")].some(e => /สร้างครบ 3 ตอน/.test(e.textContent)));
check("no fake user bubbles", q("#log .msg.user").length === 0);
check("word count under each chapter", q("#log .msgtools .wc").length === 3 && /≈\d/.test(q("#log .msgtools .wc")[0].textContent),
  q("#log .msgtools .wc")[0]?.textContent);
check("next number advanced", $("epNo").textContent === "ตอนที่ 4", $("epNo").textContent);

out.push("[3] Prompt");
check("chapter rules in the system prompt", sysText().includes("โหมดสร้างตอนอัตโนมัติ") && sysText().includes("ตอนที่ 3: <ชื่อตอน>"));
check("3000-word target", sysText().includes("ประมาณ 3000 คำ") && sysText().includes("4-6 ฉาก"));
check("no player question at chapter end", !sysText().includes("จบทุกครั้งด้วยสถานการณ์ที่ผู้เล่นต้องตัดสินใจ"));
check("hardcore-only rules stay off", !sysText().includes("Auto Play (Hardcore)"));
check("bigger output budget", lastBody.generationConfig.maxOutputTokens === 32768, lastBody.generationConfig.maxOutputTokens);
check("action names the chapter", JSON.stringify(lastBody.contents).includes("เขียนตอนที่ 3"));

out.push("[4] Undo / retry work on whole chapters");
$("openDrawer").click(); await settle(5);
$("undoBtn").click(); await settle(40);
check("undo removes exactly one chapter", eps().length === 2, "got " + eps().length);
check("chapter number rolls back", $("epNo").textContent === "ตอนที่ 3", $("epNo").textContent);
$("openDrawer").click(); await settle(5);
$("retryBtn").click();
await until(() => eps().length === 2 && !q("#log .msg.ai.streaming").length);
await settle(20);
check("retry rewrites the same chapter number", heads()[1].startsWith("ตอนที่ 2"), heads().join(" | "));
check("retry keeps the chapter prompt", sysText().includes("โหมดสร้างตอนอัตโนมัติ"));

out.push("[5] Custom chapter number");
promptAnswer = "1";
$("epNo").click(); await settle(10);
check("can't go below an existing chapter", $("epNo").textContent === "ตอนที่ 3");
promptAnswer = "40";
$("epNo").click(); await settle(10);
check("start number can be raised", $("epNo").textContent === "ตอนที่ 40", $("epNo").textContent);
$("epCount").value = "1"; $("epCount").onchange(); await settle(5);
$("epBtn").click();
await until(() => eps().length === 3 && !/หยุด/.test($("epBtn").textContent));
check("single chapter uses the new number", heads()[2].startsWith("ตอนที่ 40"), heads()[2]);

out.push("[6] Stop while writing finishes the chapter first");
$("epCount").value = "0"; $("epCount").onchange(); await settle(5);
check("unlimited option", $("epCount").value === "0");
$("epBtn").click(); await settle(2);
$("epBtn").click();        // tapped while chapter 41 is being written
await until(() => !/หยุด/.test($("epBtn").textContent));
await sleep(3000); await settle(20);
check("the chapter in flight was kept, nothing after it", eps().length === 4 && heads()[3].startsWith("ตอนที่ 41"), heads().join(" | "));

out.push("[7] Read aloud, then write the next one");
$("epCount").value = "3"; $("epCount").onchange(); await settle(5);
$("epVoice").click(); await settle(5);
check("voice toggle on", $("epVoice").classList.contains("on"));
const before = eps().length;
spoken.length = 0;
$("epBtn").click();
await until(() => eps().length === before + 1 && !q("#log .msg.ai.streaming").length);
await sleep(3000); await settle(20);
check("waits for the voice before the next chapter", eps().length === before + 1, eps().length + "");
check("chapter title is read aloud too", spoken.length > 0 && spoken[0].text.startsWith("ตอนที่ 42"), spoken[0]?.text);
for (let k = 0; k < 200 && spoken.length && spoken[spoken.length - 1].onend; k++) {
  const n = spoken.length;
  spoken[spoken.length - 1].onend(); await settle(2);
  if (spoken.length === n) break;
}
await until(() => eps().length === before + 2, 8000);
check("finishing the read orders the next chapter", eps().length >= before + 2, eps().length + "");
$("autoStopBtn").click(); await settle(40);
check("header brake stops the run", !/หยุด/.test($("epBtn").textContent) && $("autoStopBtn").style.display === "none");
$("epVoice").click(); await settle(5);

out.push("[8] A failed chapter ends the run");
failNext = true;
$("epCount").value = "3"; $("epCount").onchange(); await settle(5);
const nBefore = eps().length;
$("epBtn").click();
await until(() => q("#log .msg.err").length > 0 && !/หยุด/.test($("epBtn").textContent));
await settle(30);
check("run stopped and error shown", !/หยุด/.test($("epBtn").textContent) && eps().length === nBefore);
q("#log .msg.err").forEach(e => e.remove());

out.push("[9] Memory is compressed by size for long chapters");
bodyRepeat = 400;                      // ~40k chars per chapter
$("epCount").value = "3"; $("epCount").onchange(); await settle(5);
const sumBefore = sysCalls;
$("epBtn").click();
await until(() => !/หยุด/.test($("epBtn").textContent), 30000);
await settle(60);
check("summary ran without 24 messages piling up", sysCalls > sumBefore, "summaries " + sumBefore + " → " + sysCalls);
check("summary asks for more than 3-5 sentences", /\d+-\d+ ประโยค/.test(lastSummaryPrompt) && !/3-5 ประโยค/.test(lastSummaryPrompt));
$("openDrawer").click(); await settle(5);
$("chaptersBtn").click(); await settle(10);
const labels = [...q("#chaptersList .chaphead b")].map(b => b.textContent);
check("memory labelled by chapter numbers", labels.some(l => /^ตอนที่ \d+/.test(l)), labels.join(" | "));
$("chaptersModal").querySelector("[data-close]").click(); await settle(5);
bodyRepeat = 3;

out.push("[10] Export and Qidian");
$("exportBtn").click(); await settle(5);
$("expMd").click(); await settle(10);
const md = lastDownload ? await lastDownload.text() : "";
check("markdown export has chapter headings", /\n## ตอนที่ 1: เงาในตรอกแคบ\n/.test(md));
$("qidianToggle").checked = true; await $("qidianToggle").onchange(); await settle(10);
$("epCount").value = "1"; $("epCount").onchange(); await settle(5);
$("epBtn").click();
await until(() => !/หยุด/.test($("epBtn").textContent));
await settle(20);
check("Qidian title rule uses the chapter heading", /ตอนที่ \d+: <ชื่อตอนแบบโคลงคู่>/.test(sysText()) && !sysText().includes("\"◇ <ชื่อตอนแบบโคลงคู่>\""));

check("no runtime errors", errors.filter(e => !/Not implemented: navigation|สรุปความจำ/.test(e)).length === 0, errors[0]);

console.log(out.join("\n"));
console.log("\n─────────────────────────────\nผ่าน " + pass + " / ล้มเหลว " + fail + "\n─────────────────────────────\n");
process.exit(fail ? 1 : 0);
