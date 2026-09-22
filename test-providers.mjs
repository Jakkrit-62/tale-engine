import { JSDOM } from "jsdom";
import fs from "fs";
import path from "path";
import "fake-indexeddb/auto";

// Other AI providers (Mistral / OpenRouter / Groq / DeepSeek) + "Gemini failed — use X?"
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

// a save from the previous version: DeepSeek key stored on its own
await new Promise((resolve) => {
  const req = indexedDB.open("tale-engine", 1);
  req.onupgradeneeded = () => { req.result.createObjectStore("saves", { keyPath: "id" }); req.result.createObjectStore("settings", { keyPath: "k" }); };
  req.onsuccess = () => {
    const tx = req.result.transaction("settings", "readwrite");
    tx.objectStore("settings").put({ k: "dsKey", v: "sk-good" });
    tx.objectStore("settings").put({ k: "dsModel", v: "deepseek-chat" });
    tx.oncomplete = () => { req.result.close(); resolve(); };
  };
});

const STATE = (hp) => '<<STATE>>{"hp":' + hp + ',"maxHp":20,"level":1,"xp":0,"skills":[],"inventory":[],"location":"ตรอก","npcs":[],"flags":[]}';
const HOSTS = { "api.mistral.ai": "mistral", "openrouter.ai": "openrouter", "api.groq.com": "groq", "api.deepseek.com": "deepseek" };
const GOOD = { mistral: "mk-good", openrouter: "sk-or-good", groq: "gsk-good", deepseek: "sk-good" };
let geminiDown = false, altStatus = {}, think = true, orDaily = false;
const log = [];            // "gemini:<model>" | "<provider>:<model>"
const reqs = {};           // last request body per provider
const hdrs = {};
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
  const host = new URL(url).host;
  const p = HOSTS[host];
  if (p) {
    const auth = (opts.headers || {}).Authorization;
    if (auth !== "Bearer " + GOOD[p]) return { ok: false, status: 401, json: async () => ({ error: { message: "Invalid API key" } }) };
    if (url.endsWith("/models")) {
      const data = {
        mistral: [{ id: "mistral-large-latest" }, { id: "mistral-small-latest" }, { id: "mistral-embed" }],
        openrouter: [{ id: "openrouter/free" }, { id: "qwen/qwen3.8-27b:free" }, { id: "openai/gpt-9", pricing: { prompt: "0.00001", completion: "0.00003" } }, { id: "meta/llama-free-x", pricing: { prompt: "0", completion: "0" } }],
        groq: [{ id: "openai/gpt-oss-120b" }, { id: "whisper-large-v3" }],
        deepseek: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }],
      }[p];
      return { ok: true, status: 200, json: async () => ({ data }) };
    }
    if (url.endsWith("/user/balance")) return { ok: true, status: 200, json: async () => ({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "4.20" }] }) };
    const body = JSON.parse(opts.body);
    reqs[p] = body; hdrs[p] = opts.headers;
    const sys = body.messages[0].role === "system" ? body.messages[0].content : "";
    if (!sys.includes("ผู้ช่วยสรุปเนื้อเรื่อง")) log.push(p + ":" + body.model);
    if (p === "openrouter" && orDaily) return { ok: false, status: 429, json: async () => ({ error: { message: "Rate limit exceeded: free-models-per-day" } }) };
    if (altStatus[p]) return { ok: false, status: altStatus[p], json: async () => ({ error: { message: "nope" } }) };
    const lines = [": keep-alive\n\n"];
    if (think) lines.push("data: " + JSON.stringify({ choices: [{ delta: { reasoning_content: "ความคิดลับห้ามโผล่" } }] }) + "\n\n");
    lines.push("data: " + JSON.stringify({ choices: [{ delta: { content: p + " เล่าว่า ฝนตกหนักในตรอก\n" } }] }) + "\n\n");
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
const opts = (id) => [...$(id).options].map(o => o.value);
function send(text) { $("actionInput").value = text; $("sendBtn").click(); }
async function turn(text) { send(text); await sleep(20); await until(() => idle() || asking()); await settle(10); }
async function setSel(id, v) { $(id).value = v; await $(id).onchange(); await settle(10); }
async function setupAlt(p, key, model) {
  await setSel("altPick", p);
  $("altKeyInput").value = key;
  if (model) $("altModelSelect").value = model;
  $("altSaveBtn").click(); await settle(20);
}
async function testAlt() { $("altTestBtn").click(); await sleep(5); await until(() => !$("altTestBtn").disabled); await settle(5); }

console.log("\n═══ Tale Engine — AI provider tests ═══\n");
await settle(150);
$("setupSettingsBtn").click(); await settle(10);

out.push("[1] Settings");
check("5 providers to choose from", JSON.stringify(opts("providerSelect")) === '["gemini","mistral","openrouter","groq","deepseek"]', opts("providerSelect").join(","));
check("free vs paid is labelled", /Mistral — ฟรี/.test($("providerSelect").textContent) && /DeepSeek — 💰 เสียเงิน/.test($("providerSelect").textContent));
check("backup defaults to automatic", $("backupSelect").value === "" && opts("backupSelect").length === 6);
check("old DeepSeek key migrated", /✅/.test([...$("altPick").options].find(o => o.value === "deepseek").textContent));
await setSel("altPick", "deepseek");
check("…with its model", $("altKeyInput").value === "sk-good" && $("altModelSelect").value === "deepseek-chat");
await setSel("altPick", "mistral");
check("Mistral picked: signup hint + Large default", /console\.mistral\.ai/.test($("altNote").textContent) && $("altModelSelect").value === "mistral-large-latest", $("altNote").textContent);
$("altKeyInput").value = "mk-bad"; await testAlt();
check("wrong key reported per provider", /Mistral API key ไม่ถูกต้อง/.test($("altKeyStatus").textContent), $("altKeyStatus").textContent);
$("altKeyInput").value = "mk-good"; await testAlt();
check("good key: models loaded, embeddings hidden", /ใช้งานได้/.test($("altKeyStatus").textContent) && !opts("altModelSelect").includes("mistral-embed"), $("altKeyStatus").textContent);
check("…and nothing spent", log.length === 0);
$("altSaveBtn").click(); await settle(20);
await setSel("altPick", "openrouter");
check("OpenRouter defaults to its free router", $("altModelSelect").value === "openrouter/free");
$("altKeyInput").value = "sk-or-good"; await testAlt();
check("OpenRouter list shows free models only", opts("altModelSelect").includes("qwen/qwen3.8-27b:free") && opts("altModelSelect").includes("meta/llama-free-x") && !opts("altModelSelect").includes("openai/gpt-9"), opts("altModelSelect").join(","));
$("altSaveBtn").click(); await settle(20);
await setSel("altPick", "groq");
$("altKeyInput").value = "gsk-good"; await testAlt();
check("Groq list hides speech models", !opts("altModelSelect").includes("whisper-large-v3"));
$("altSaveBtn").click(); await settle(20);
await setSel("altPick", "deepseek");
await testAlt();
check("DeepSeek test shows balance", /4\.20 USD/.test($("altKeyStatus").textContent), $("altKeyStatus").textContent);
check("provider list marks keys set", /Mistral — ฟรี ✅/.test($("providerSelect").textContent) && /Gemini \(Google\) — ฟรี \(ยังไม่ใส่ key\)/.test($("providerSelect").textContent));
$("apiKeyInput").value = "G"; $("saveKeyBtn").click(); await settle(20);

$("setupName").value = "หยางจ่าน";
$("startBtn").click();
await until(() => aiN() >= 1); await settle(40);
check("game starts on Gemini (main)", log[0] && log[0].startsWith("gemini:") && /Gemini เล่าว่า/.test(lastAi()), log.join(","));

out.push("[2] Gemini 503 → asks → backup (auto = first with a key: Mistral)");
geminiDown = true; log.length = 0;
send("มองรอบๆ");
await until(asking);
check("question after Gemini's own retries", asking() && log.length >= 4 && log.every(x => x.startsWith("gemini:")), log.join(","));
check("offers Mistral Large", /Gemini ใช้ไม่ได้/.test($("swTitle").textContent) && /Mistral Large/.test($("swOnce").textContent), $("swOnce").textContent);
$("swOnce").click();
await until(idle); await settle(20);
check("Mistral wrote the turn", /mistral เล่าว่า/.test(lastAi()) && log[log.length - 1] === "mistral:mistral-large-latest", lastAi().slice(0, 40));
check("hidden reasoning never shown", !q("#log")[0].textContent.includes("ความคิดลับ"));
check("state block parsed (HP 7)", /7\s*\/\s*20/.test($("headerHp").textContent), $("headerHp").textContent);
const mr = reqs.mistral;
check("request: system + alternating roles, ends with user, streamed", mr.messages[0].role === "system" && mr.stream === true &&
  mr.messages[mr.messages.length - 1].role === "user" && mr.messages.every((m, i, a) => i === 0 || m.role !== a[i - 1].role), JSON.stringify(mr.messages.map(m => m.role)));
check("Mistral gets temperature + roomy output", mr.temperature === 0.9 && mr.max_tokens >= 8192);

out.push("[3] Chosen backup + OpenRouter");
$("openDrawer").click(); await settle(5); $("settingsBtn").click(); await settle(5);
await setSel("backupSelect", "openrouter");
q("[data-close]").forEach(b => b.click()); await settle(5);
log.length = 0;
send("เดินต่อ");
await until(asking);
check("offers the chosen backup", /OpenRouter/.test($("swOnce").textContent), $("swOnce").textContent);
$("swOnce").click();
await until(idle); await settle(10);
check("OpenRouter free router used", log[log.length - 1] === "openrouter:openrouter/free" && /openrouter เล่าว่า/.test(lastAi()), log.join(","));
check("app name header sent to OpenRouter", hdrs.openrouter["X-Title"] === "Tale Engine");
orDaily = true; log.length = 0;
send("วิ่ง");
await until(asking);
$("swOnce").click();
await until(idle); await settle(10);
check("OpenRouter daily free limit → clear message", /โควตาฟรีของวันนี้หมด/.test(lastErr()), lastErr());
orDaily = false;
q("#log .msg.err").forEach(e => e.remove());

out.push("[4] Say no / until app closes / tap outside / stop");
log.length = 0;
send("หลบ");
await until(asking);
$("swNo").click();
await until(idle); await settle(10);
check("no → normal error, backup not called", /มีคนใช้เยอะ/.test(lastErr()) && log.every(x => x.startsWith("gemini:")), lastErr());
send("ซ่อน");
await until(asking);
$("swSession").click();
await until(idle); await settle(10);
log.length = 0;
await turn("ปีน");
check("session: straight to the backup, no question", log.length === 1 && log[0].startsWith("openrouter:") && !asking(), log.join(","));
$("openDrawer").click(); await settle(5); $("settingsBtn").click(); await settle(5);
check("settings shows the temporary switch", $("providerNote").style.display === "block" && /OpenRouter/.test($("providerNoteText").textContent));
$("providerNoteReset").click(); await settle(5);
q("[data-close]").forEach(b => b.click()); await settle(5);
log.length = 0;
send("ลอง");
await until(asking);
$("overlay").click();
await until(idle); await settle(10);
check("tap outside = no", !asking() && idle() && log.every(x => x.startsWith("gemini:")));
send("หยุด");
await until(asking);
$("stopBtn").click();
await until(idle); await settle(10);
check("■ while asking cancels cleanly", !asking() && idle() && log.every(x => x.startsWith("gemini:")));

out.push("[5] Switch without asking / never switch");
$("openDrawer").click(); await settle(5); $("settingsBtn").click(); await settle(5);
await setSel("fallbackSelect", "auto");
log.length = 0;
await turn("ต่อสู้");
check("auto: no question, backup answers", !asking() && log[log.length - 1].startsWith("openrouter:"));
await setSel("fallbackSelect", "off");
log.length = 0;
await turn("หนี");
check("off: error only", !asking() && /มีคนใช้เยอะ/.test(lastErr()) && log.every(x => x.startsWith("gemini:")));
await setSel("fallbackSelect", "ask");
q("#log .msg.err").forEach(e => e.remove());

out.push("[6] Another provider as the main one");
geminiDown = false; think = false;
await setSel("providerSelect", "groq");
log.length = 0;
await turn("พักผ่อน");
check("Groq used first", log[0] === "groq:openai/gpt-oss-120b" && /groq เล่าว่า/.test(lastAi()), log.join(","));
check("Groq output capped for its per-minute limit", reqs.groq.max_tokens <= 8192);
altStatus.groq = 401; log.length = 0;
send("ซื้อของ");
await until(asking);
check("Groq failing → offers the backup (OpenRouter)", /Groq ใช้ไม่ได้/.test($("swTitle").textContent) && /OpenRouter/.test($("swOnce").textContent), $("swTitle").textContent + " / " + $("swOnce").textContent);
$("swOnce").click();
await until(idle); await settle(10);
check("backup wrote it", /openrouter เล่าว่า/.test(lastAi()));
altStatus.groq = 0;
await setSel("providerSelect", "deepseek");
await setSel("altPick", "deepseek"); $("altModelSelect").value = "deepseek-reasoner"; $("altSaveBtn").click(); await settle(20);
log.length = 0;
await turn("นอน");
check("DeepSeek R1: no temperature (R1 ignores it)", log[0] === "deepseek:deepseek-reasoner" && reqs.deepseek.temperature === undefined && reqs.deepseek.max_tokens === 8192, JSON.stringify(reqs.deepseek.max_tokens));
altStatus.deepseek = 402; log.length = 0;
send("ออกเดินทาง");
await until(asking);
check("DeepSeek no balance → clear reason", /ยอดเงินใน DeepSeek หมด/.test($("swMsg").textContent), $("swMsg").textContent);
$("swNo").click(); await until(idle); await settle(10);
altStatus.deepseek = 0;

out.push("[7] Only an OpenRouter key");
await setSel("providerSelect", "gemini");
$("clearKeyBtn").click(); await settle(20);
for (const p of ["mistral", "groq", "deepseek"]) { await setSel("altPick", p); $("altClearBtn").click(); await settle(20); }
q("[data-close]").forEach(b => b.click()); await settle(5);
log.length = 0;
await turn("ตื่น");
check("main has no key → the one with a key is used, no question", !asking() && log.length === 1 && log[0].startsWith("openrouter:"), log.join(","));

check("no runtime errors", errors.filter(e => !/Not implemented|สรุปความจำ/.test(e)).length === 0, errors[0]);
console.log(out.join("\n"));
console.log("\n─────────────────────────────\nผ่าน " + pass + " / ล้มเหลว " + fail + "\n─────────────────────────────\n");
process.exit(fail ? 1 : 0);
