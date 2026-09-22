import { JSDOM } from "jsdom";
import fs from "fs";
import path from "path";
import "fake-indexeddb/auto";

// DeepSeek as a second AI provider + "Gemini failed — use DeepSeek?"
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
async function until(fn, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(10); } return false; }

const STATE = (hp) => '<<STATE>>{"hp":' + hp + ',"maxHp":20,"level":1,"xp":0,"skills":[],"inventory":[],"location":"ตรอก","npcs":[],"flags":[]}';
let geminiDown = false, dsStatus = 200, dsThink = true;
const log = [];            // "gemini:<model>" | "ds:<model>"
let lastDs = null;
const enc = new TextEncoder();
const stream = (lines) => new ReadableStream({ start(c) { for (const l of lines) c.enqueue(enc.encode(l)); c.close(); } });

const dom = new JSDOM(html, { url: "https://example.org/tale/", pretendToBeVisual: true, runScripts: "outside-only" });
const win = dom.window;
win.indexedDB = globalThis.indexedDB;
win.IDBKeyRange = globalThis.IDBKeyRange;
for (const k of ["AbortController", "ReadableStream", "TextDecoder", "TextEncoder", "Blob", "Intl"]) win[k] = globalThis[k];
win.confirm = () => true;
Object.defineProperty(win.navigator, "serviceWorker", { value: { register: async () => ({}) }, configurable: true });
const realSetTimeout = win.setTimeout.bind(win);
win.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms >= 1000 ? ms / 100 : ms, ...a);   // waits 100× faster
win.fetch = async (url, opts = {}) => {
  url = String(url);
  if (url.startsWith("https://api.deepseek.com/")) {
    const auth = (opts.headers || {}).Authorization;
    if (auth !== "Bearer sk-good") return { ok: false, status: 401, json: async () => ({ error: { message: "Authentication Fails" } }) };
    if (url.endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }] }) };
    if (url.endsWith("/user/balance")) return { ok: true, status: 200, json: async () => ({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "4.20" }] }) };
    lastDs = JSON.parse(opts.body);
    const sys = lastDs.messages[0].role === "system" ? lastDs.messages[0].content : "";
    if (!sys.includes("ผู้ช่วยสรุปเนื้อเรื่อง")) log.push("ds:" + lastDs.model);
    if (dsStatus !== 200) return { ok: false, status: dsStatus, json: async () => ({ error: { message: "Insufficient Balance" } }) };
    const lines = [": keep-alive\n\n"];
    if (dsThink) lines.push("data: " + JSON.stringify({ choices: [{ delta: { reasoning_content: "ความคิดลับของ R1 ห้ามโผล่" } }] }) + "\n\n");
    lines.push("data: " + JSON.stringify({ choices: [{ delta: { content: "DeepSeek เล่าว่า ฝนตกหนักในตรอก\n" } }] }) + "\n\n");
    lines.push("data: " + JSON.stringify({ choices: [{ delta: { content: "จะทำอย่างไรต่อ?\n" + STATE(7) }, finish_reason: "stop" }] }) + "\n\n");
    lines.push("data: [DONE]\n\n");
    return { ok: true, status: 200, body: stream(lines) };
  }
  const m = decodeURIComponent(url.match(/models\/([^:]+):/)[1]);
  const body = JSON.parse(opts.body);
  const sys = body.systemInstruction?.parts?.[0]?.text || "";
  if (!sys.includes("ผู้ช่วยสรุปเนื้อเรื่อง")) log.push("gemini:" + m);
  if (geminiDown) return { ok: false, status: 503, json: async () => ({ error: { code: 503, message: "The model is overloaded." } }) };
  return { ok: true, status: 200, body: stream(["data: " + JSON.stringify({ candidates: [{ content: { parts: [{ text: "Gemini เล่าว่า ลมพัดแรง\nจะทำอย่างไรต่อ?\n" + STATE(18) }] }, finishReason: "STOP" }] }) + "\n\n"]) };
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
const lastAi = () => { const a = q("#log .msg.ai:not(.streaming)"); return a.length ? a[a.length - 1].textContent : ""; };
const aiN = () => q("#log .msg.ai:not(.streaming)").length;
const lastErr = () => { const e = q("#log .msg.err"); return e.length ? e[e.length - 1].textContent : ""; };
const asking = () => $("switchModal").classList.contains("open");
const idle = () => $("sendBtn").style.display !== "none" && !$("actionInput").disabled;
function send(text) { $("actionInput").value = text; $("sendBtn").click(); }
async function turn(text) { send(text); await sleep(20); await until(() => idle() || asking()); await settle(10); }

console.log("\n═══ Tale Engine — DeepSeek provider tests ═══\n");
await settle(150);

out.push("[1] Settings");
check("provider + fallback + DeepSeek fields exist", $("providerSelect") && $("fallbackSelect") && $("dsKeyInput") && $("dsModelSelect") && $("dsTestBtn"));
check("defaults: Gemini main, ask on failure", $("providerSelect").value === "gemini" && $("fallbackSelect").value === "ask");
check("R1 is the default DeepSeek model", $("dsModelSelect").value === "deepseek-reasoner", $("dsModelSelect").value);
$("dsKeyInput").value = "sk-bad"; $("dsTestBtn").click();
await until(() => !$("dsTestBtn").disabled && /❌|✅/.test($("dsKeyStatus").textContent));
check("wrong DeepSeek key reported", /DeepSeek API key ไม่ถูกต้อง/.test($("dsKeyStatus").textContent), $("dsKeyStatus").textContent);
$("dsKeyInput").value = "sk-good"; $("dsTestBtn").click();
await sleep(5); await until(() => !$("dsTestBtn").disabled);
check("good key: works + shows balance, costs nothing", /ใช้งานได้/.test($("dsKeyStatus").textContent) && /4\.20 USD/.test($("dsKeyStatus").textContent) && log.length === 0, $("dsKeyStatus").textContent);
$("dsSaveBtn").click(); await settle(20);
$("apiKeyInput").value = "G"; $("saveKeyBtn").click(); await settle(20);

$("setupName").value = "หยางจ่าน";
$("startBtn").click();
await until(() => aiN() >= 1); await settle(40);
check("game starts on Gemini (main)", log[0] && log[0].startsWith("gemini:") && /Gemini เล่าว่า/.test(lastAi()), log.join(","));

out.push("[2] Gemini 503 → asks → use DeepSeek this time");
geminiDown = true; log.length = 0;
send("มองรอบๆ");
await until(asking);
check("question pops up after Gemini's own retries", asking() && log.length >= 4 && log.every(x => x.startsWith("gemini:")), log.join(","));
check("question names the problem and DeepSeek R1", /Gemini ใช้ไม่ได้/.test($("swTitle").textContent) && /มีคนใช้เยอะ/.test($("swMsg").textContent) && /DeepSeek R1/.test($("swOnce").textContent), $("swMsg").textContent);
$("swOnce").click();
await until(idle); await settle(20);
check("DeepSeek wrote the turn", /DeepSeek เล่าว่า/.test(lastAi()) && log[log.length - 1] === "ds:deepseek-reasoner", lastAi().slice(0, 40));
check("R1's hidden reasoning never shown", !q("#log")[0].textContent.includes("ความคิดลับ"));
check("state block parsed (HP 7)", /7\s*\/\s*20/.test($("headerHp").textContent), $("headerHp").textContent);
check("request: system + user/assistant, streamed, Bearer", lastDs.messages[0].role === "system" && lastDs.messages.slice(1).every(m => m.role === "user" || m.role === "assistant") &&
  lastDs.messages[lastDs.messages.length - 1].role === "user" && lastDs.stream === true && lastDs.temperature === undefined, JSON.stringify(lastDs.messages.map(m => m.role)));
check("no two same roles in a row (R1 rule)", lastDs.messages.every((m, i, a) => i === 0 || m.role !== a[i - 1].role));
check("toast says it switched", /DeepSeek/.test($("toast").textContent), $("toast").textContent);

out.push("[3] Only this time → next turn tries Gemini again; say no");
log.length = 0;
send("เดินต่อ");
await until(asking);
check("Gemini tried first again", log[0].startsWith("gemini:") && asking());
$("swNo").click();
await until(idle); await settle(10);
check("no → normal error, DeepSeek not called", /มีคนใช้เยอะ/.test(lastErr()) && !log.some(x => x.startsWith("ds:")), lastErr());

out.push("[4] Until the app closes");
q("#log .msg.err").forEach(e => e.remove());
log.length = 0;
send("วิ่ง");
await until(asking);
$("swSession").click();
await until(idle); await settle(10);
log.length = 0;
await turn("หลบ");
check("next turn goes straight to DeepSeek, no question", log.length === 1 && log[0].startsWith("ds:") && !asking(), log.join(","));
$("openDrawer").click(); await settle(5); $("settingsBtn").click(); await settle(5);
check("settings shows the temporary switch", $("providerNote").style.display === "block" && /DeepSeek R1/.test($("providerNoteText").textContent));
$("providerNoteReset").click(); await settle(5);
check("can switch back", $("providerNote").style.display === "none");
q("[data-close]").forEach(b => b.click()); await settle(5);

out.push("[5] Close the question = no; stop button while asking");
log.length = 0;
send("ซ่อน");
await until(asking);
$("overlay").click();
await until(idle); await settle(10);
check("tap outside → treated as no", !asking() && idle() && /มีคนใช้เยอะ/.test(lastErr()) && !log.some(x => x.startsWith("ds:")));
send("ปีน");
await until(asking);
$("stopBtn").click();
await until(idle); await settle(10);
check("■ while asking cancels cleanly", !asking() && idle() && !log.some(x => x.startsWith("ds:")));

out.push("[6] 'Switch without asking' and 'never switch'");
$("fallbackSelect").value = "auto"; await $("fallbackSelect").onchange();
log.length = 0;
await turn("ต่อสู้");
check("auto: no question, DeepSeek answers", !asking() && /DeepSeek เล่าว่า/.test(lastAi()) && log[log.length - 1].startsWith("ds:"));
$("fallbackSelect").value = "off"; await $("fallbackSelect").onchange();
log.length = 0;
await turn("หนี");
check("off: error only", !asking() && /มีคนใช้เยอะ/.test(lastErr()) && !log.some(x => x.startsWith("ds:")));
$("fallbackSelect").value = "ask"; await $("fallbackSelect").onchange();
q("#log .msg.err").forEach(e => e.remove());

out.push("[7] DeepSeek as the main provider");
geminiDown = false;
$("providerSelect").value = "deepseek"; await $("providerSelect").onchange();
$("dsModelSelect").value = "deepseek-chat"; $("dsSaveBtn").click(); await settle(20);
log.length = 0; dsThink = false;
await turn("พักผ่อน");
check("DeepSeek V3 used first", log[0] === "ds:deepseek-chat" && /DeepSeek เล่าว่า/.test(lastAi()), log.join(","));
check("V3 gets a temperature, capped output", lastDs.temperature === 0.9 && lastDs.max_tokens <= 8192, JSON.stringify({ t: lastDs.temperature, m: lastDs.max_tokens }));
dsStatus = 402; log.length = 0;
send("ซื้อของ");
await until(asking);
check("no balance → asks to use Gemini", asking() && /DeepSeek ใช้ไม่ได้/.test($("swTitle").textContent) && /ยอดเงิน/.test($("swMsg").textContent) && /Gemini/.test($("swOnce").textContent), $("swMsg").textContent);
$("swOnce").click();
await until(idle); await settle(10);
check("Gemini wrote it", /Gemini เล่าว่า/.test(lastAi()) && log[log.length - 1].startsWith("gemini:"));
dsStatus = 200;

out.push("[8] Only a DeepSeek key");
$("clearKeyBtn").click(); await settle(20);
$("providerSelect").value = "gemini"; await $("providerSelect").onchange();
log.length = 0;
await turn("นอน");
check("no Gemini key → DeepSeek used directly, no question", !asking() && log.length === 1 && log[0].startsWith("ds:") && /DeepSeek เล่าว่า/.test(lastAi()), log.join(","));

check("no runtime errors", errors.filter(e => !/Not implemented|สรุปความจำ/.test(e)).length === 0, errors[0]);
console.log(out.join("\n"));
console.log("\n─────────────────────────────\nผ่าน " + pass + " / ล้มเหลว " + fail + "\n─────────────────────────────\n");
process.exit(fail ? 1 : 0);
