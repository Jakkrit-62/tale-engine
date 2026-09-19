import { JSDOM } from "jsdom";
import fs from "fs";
import "fake-indexeddb/auto";

const html = fs.readFileSync("index.html", "utf8");
const appjs = fs.readFileSync("app.js", "utf8");

let pass = 0, fail = 0; const out = [];
const check = (n, c, x) => { if (c) { pass++; out.push("  ✅ " + n); } else { fail++; out.push("  ❌ " + n + (x ? "  → " + x : "")); } };

let mode = "ok", lastNarr = null, aborted = false, genCalls = 0, calledModels = [], lastSumUrl = "", lastHeaders = null;
// Google's real error bodies (shape of generativelanguage v1beta responses)
const gErr = (st, message, details) => ({ ok: false, status: st, body: null,
  json: async () => ({ error: { code: st, status: st === 429 ? "RESOURCE_EXHAUSTED" : "NOT_FOUND", message, details } }) });
const quotaFail = (quotaId) => ({ "@type": "type.googleapis.com/google.rpc.QuotaFailure",
  violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests", quotaId }] });
const retryInfo = (d) => ({ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: d });
const enc = new TextEncoder();
// Faithful to real fetch: a stream that errors with AbortError when the
// caller's signal fires, so the abort path is genuinely exercised.
const sse = (chunks, delayed, signal) => new ReadableStream({
  async start(c) {
    for (const ch of chunks) {
      if (delayed) await new Promise(r => setTimeout(r, 15));
      if (signal && signal.aborted) {
        const e = new Error("aborted"); e.name = "AbortError";
        try { c.error(e); } catch (_) {}
        return;
      }
      c.enqueue(enc.encode("data: " + JSON.stringify(ch) + "\n\n"));
    }
    c.close();
  }
});
const tc = (t, fin) => { const o = { candidates: [{ content: { parts: [{ text: t }] } }] }; if (fin) o.candidates[0].finishReason = fin; return o; };

function mkFetch() {
  return async (url, opts) => {
    const signal = opts && opts.signal;
    if (signal && signal.aborted) { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
    if (!opts || !opts.body) {
      // ListModels (GET)
      if (mode === "listbadkey") return gErr(400, "API key not valid. Please pass a valid API key.");
      return { ok: true, status: 200, json: async () => ({ models: [
        { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-flash-latest", displayName: "Gemini Flash Latest", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-embedding-001", displayName: "Embedding", supportedGenerationMethods: ["embedContent"] },
        { name: "models/gemini-2.5-flash-preview-tts", displayName: "TTS", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemma-3-27b-it", displayName: "Gemma", supportedGenerationMethods: ["generateContent"] },
      ] }) };
    }
    const body = JSON.parse(opts.body);
    const sys = body.systemInstruction?.parts?.[0]?.text || "";
    const isSum = sys.includes("ผู้ช่วยสรุปเนื้อเรื่อง");
    const model = (String(url).match(/models\/([^:?]+)/) || [])[1];
    if (!isSum) { lastNarr = body; lastHeaders = opts.headers; }
    else lastSumUrl = String(url);
    const mk = (s, st = 200) => ({ ok: st < 300, status: st, body: s, json: async () => ({ error: { message: "e" } }) });
    if (isSum) return mk(sse([tc("สรุปสั้น")]));

    genCalls++; calledModels.push(model);
    if (mode === "wantedDown" && model === "gemini-flash-latest")
      return gErr(429, "Quota exceeded for metric: generate_content_free_tier_requests, limit: 0");
    if (mode === "g404") return gErr(404, "models/gemini-3.8-flash is not found for API version v1beta");
    if (mode === "g429zero") return gErr(429, "You exceeded your current quota. Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-2.5-pro",
      [quotaFail("GenerateRequestsPerDayPerProjectPerModel-FreeTier"), retryInfo("30s")]);
    if (mode === "g429day") return gErr(429, "You exceeded your current quota. limit: 250",
      [quotaFail("GenerateRequestsPerDayPerProjectPerModel-FreeTier"), retryInfo("20s")]);
    if (mode === "g429min") { mode = "ok"; return gErr(429, "Please retry in 1.2s.",
      [quotaFail("GenerateRequestsPerMinutePerProjectPerModel-FreeTier"), retryInfo("1s")]); }
    switch (mode) {
      case "fencedjson":
        return mk(sse([tc('เนื้อเรื่องปกติ\n<<STATE>>```json\n{"hp":7,"maxHp":20,"level":3,"xp":5,"skills":["a"],"inventory":[],"location":"ถ้ำ","npcs":[],"flags":[]}\n```')]));
      case "trailingprose":
        return mk(sse([tc('เนื้อเรื่อง\n<<STATE>>{"hp":6,"maxHp":20,"level":1,"xp":0,"skills":[],"inventory":[],"location":"a","npcs":[],"flags":[]}  หวังว่าคุณจะสนุกนะครับ!')]));
      case "brokenjson":
        return mk(sse([tc('เนื้อเรื่องดี\n<<STATE>>{hp: 5, broken')]));
      case "nostate":
        return mk(sse([tc("เนื้อเรื่องล้วนไม่มี STATE เลย")]));
      case "badtypes":
        return mk(sse([tc('เนื้อ\n<<STATE>>{"hp":"สิบ","maxHp":null,"level":-5,"xp":"x","skills":"ไม่ใช่array","inventory":[1,2],"location":99,"npcs":null,"flags":[]}')]));
      case "hpoverflow":
        return mk(sse([tc('เนื้อ\n<<STATE>>{"hp":9999,"maxHp":20,"level":1,"xp":0,"skills":[],"inventory":[],"location":"a","npcs":[],"flags":[]}')]));
      case "xss":
        return mk(sse([tc('<img src=x onerror="window.__pwned=1">\n<<STATE>>{"hp":10,"maxHp":20,"level":1,"xp":0,"skills":["<script>window.__pwned2=1</script>"],"inventory":[],"location":"<b>x</b>","npcs":[],"flags":[]}')]));
      case "slow":
        return mk(sse([tc("เริ่ม"), tc("กลาง"), tc("จบ")], true, signal));
      case "safety":
        return mk(sse([{ promptFeedback: { blockReason: "SAFETY" }, candidates: [{ finishReason: "SAFETY", content: { parts: [] } }] }]));
      case "maxtok":
        return mk(sse([{ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [] } }] }]));
      case "malformedsse":
        return mk(new ReadableStream({ start(c) { c.enqueue(enc.encode("data: {not json\n\ndata: " + JSON.stringify(tc("รอดมาได้")) + "\n\n")); c.close(); } }));
      case "splitsse": {
        const full = "data: " + JSON.stringify(tc("ข้อความที่ถูกตัดกลางคัน")) + "\n\n";
        const a = full.slice(0, 30), b = full.slice(30);
        return mk(new ReadableStream({ start(c) { c.enqueue(enc.encode(a)); c.enqueue(enc.encode(b)); c.close(); } }));
      }
      default:
        return mk(sse([tc('ปกติ\n<<STATE>>{"hp":15,"maxHp":20,"level":1,"xp":1,"skills":[],"inventory":[],"location":"a","npcs":[],"flags":[]}')]));
    }
  };
}

const dom = new JSDOM(html, { url: "https://example.org/t/", pretendToBeVisual: true, runScripts: "outside-only" });
const w = dom.window;
Object.assign(w, {
  indexedDB: globalThis.indexedDB, IDBKeyRange: globalThis.IDBKeyRange,
  fetch: mkFetch(), AbortController: globalThis.AbortController,
  ReadableStream: globalThis.ReadableStream, TextDecoder: globalThis.TextDecoder,
  TextEncoder: globalThis.TextEncoder, Blob: globalThis.Blob,
  confirm: () => true, alert: () => { }, scrollTo: () => { },
});
w.URL.createObjectURL = () => "blob:m"; w.URL.revokeObjectURL = () => { };
Object.defineProperty(w.navigator, "serviceWorker", { value: { register: async () => ({}) }, configurable: true });
const errs = []; const oe = console.error; console.error = (...a) => errs.push(a.map(String).join(" "));
w.eval(appjs);
const $ = (id) => w.document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const settle = async (n = 60) => { for (let i = 0; i < n; i++) await sleep(4); };

console.log("\n═══ Edge-case / adversarial run ═══\n");
await settle(150);
$("apiKeyInput").value = "K"; $("saveKeyBtn").click(); await settle(20);
$("setupName").value = "E"; $("startBtn").click(); await settle(60);

async function turn(t) { $("actionInput").value = t; $("sendBtn").click(); await settle(60); }
const aiN = () => $("log").querySelectorAll(".msg.ai").length;
const errN = () => $("log").querySelectorAll(".msg.err").length;
const clearErrs = () => $("log").querySelectorAll(".msg.err").forEach(e => e.remove());

out.push("[A] Malformed <<STATE>> payloads");
mode = "fencedjson"; await turn("a");
check("markdown-fenced JSON parsed", $("headerHp").textContent.includes("7/20"), $("headerHp").textContent);

mode = "trailingprose"; await turn("b");
check("JSON with trailing prose parsed", $("headerHp").textContent.includes("6/20"), $("headerHp").textContent);

const beforeBroken = $("headerHp").textContent;
mode = "brokenjson"; await turn("c");
check("broken JSON keeps old stats (no crash)", $("headerHp").textContent === beforeBroken, $("headerHp").textContent);
check("broken JSON still shows the narrative", aiN() > 0 && errN() === 0);

mode = "nostate"; const n1 = aiN(); await turn("d");
check("missing <<STATE>> still accepted as a turn", aiN() === n1 + 1);

out.push("[B] Hostile / wrong-typed state values");
const beforeBad = $("headerHp").textContent;
mode = "badtypes"; await turn("e");
check("wrong types rejected, stats unchanged", $("headerHp").textContent === beforeBad, $("headerHp").textContent);
check("string-instead-of-array skills ignored", !$("skillsList").textContent.includes("ไม่ใช่array"));
check("negative level clamped to >=1", !/Lv\.-/.test($("headerHp").textContent), $("headerHp").textContent);

mode = "hpoverflow"; await turn("f");
check("hp clamped to maxHp", $("headerHp").textContent.includes("20/20"), $("headerHp").textContent);
check("hp bar never exceeds 100%", parseFloat($("hpBar").style.width) <= 100, $("hpBar").style.width);

out.push("[C] XSS / injection");
mode = "xss"; await turn("g");
await settle(20);
check("no script executed from narrative", w.__pwned === undefined);
check("no script executed from state fields", w.__pwned2 === undefined);
check("narrative html not parsed as DOM", $("log").querySelectorAll("img").length === 0);
check("tag markup escaped in skill chips",
  $("skillsList").innerHTML.includes("&lt;script&gt;"), $("skillsList").innerHTML.slice(0, 80));
check("location markup escaped", $("locationText").textContent.includes("<b>"));

out.push("[D] Stream failure modes");
mode = "safety"; clearErrs(); await turn("h");
check("safety block surfaces a clear error", ($("log").querySelector(".msg.err")?.textContent || "").includes("ตัวกรองความปลอดภัย"));
clearErrs();
mode = "maxtok"; await turn("i");
check("max-tokens with no text surfaces error", errN() === 1);
clearErrs();
mode = "malformedsse"; const n2 = aiN(); await turn("j");
check("malformed SSE line skipped, valid one kept", aiN() === n2 + 1);
mode = "splitsse"; const n3 = aiN(); await turn("k");
check("SSE event split across chunks reassembled", aiN() === n3 + 1);
check("split-chunk text intact",
  $("log").querySelectorAll(".msg.ai")[aiN() - 1].textContent.includes("ถูกตัดกลางคัน"),
  $("log").querySelectorAll(".msg.ai")[aiN() - 1].textContent);

out.push("[E] Abort / concurrency");
mode = "slow";
const nBeforeSend = aiN();   // measured BEFORE the streaming bubble exists
$("actionInput").value = "ยาว"; $("sendBtn").click();
await sleep(12);
check("stop button visible while busy", $("stopBtn").style.display === "block");
check("send button hidden while busy", $("sendBtn").style.display === "none");
check("input disabled while busy", $("actionInput").disabled === true);
$("stopBtn").click();
await settle(40);
check("abort leaves no ai bubble", aiN() === nBeforeSend, "ai=" + aiN() + " expected " + nBeforeSend);
check("abort leaves no user bubble residue",
  !Array.from($("log").querySelectorAll(".msg.user")).some(e => e.textContent === "ยาว"));
check("abort shows cancellation notice",
  Array.from($("log").querySelectorAll(".msg.sys")).some(e => e.textContent.includes("ยกเลิก")));
check("ui re-enabled after abort", $("actionInput").disabled === false && $("stopBtn").style.display === "none");

mode = "ok";
// double-submit guard
$("actionInput").value = "ซ้ำ";
$("sendBtn").click(); $("sendBtn").click(); $("sendBtn").click();
await settle(60);
const dupes = Array.from($("log").querySelectorAll(".msg.user")).filter(e => e.textContent === "ซ้ำ").length;
check("rapid triple-click produces exactly one turn", dupes === 1, "dupes=" + dupes);

out.push("[F] Empty / whitespace input");
const nEmpty = aiN();
$("actionInput").value = "   "; $("sendBtn").click(); await settle(20);
check("whitespace-only input ignored", aiN() === nEmpty);
$("actionInput").value = ""; $("sendBtn").click(); await settle(20);
check("empty input ignored", aiN() === nEmpty);

out.push("[G] Import validation");
$("openDrawer").click(); await settle(5);
$("exportBtn").click(); await settle(10);
const fileInput = $("impJson");
function fakeFile(text) {
  return { text: async () => text, name: "x.json" };
}
Object.defineProperty(fileInput, "files", { value: [fakeFile("ไม่ใช่ json เลย")], configurable: true });
fileInput.dispatchEvent(new w.Event("change"));
await settle(20);
check("garbage import rejected with toast", $("toast").textContent.includes("นำเข้าไม่สำเร็จ"), $("toast").textContent);
Object.defineProperty(fileInput, "files", { value: [fakeFile('{"foo":1}')], configurable: true });
fileInput.dispatchEvent(new w.Event("change"));
await settle(20);
check("valid-JSON-but-wrong-shape rejected", $("toast").textContent.includes("นำเข้าไม่สำเร็จ"), $("toast").textContent);

const titleBefore = $("headerTitle").textContent;
Object.defineProperty(fileInput, "files", {
  value: [fakeFile(JSON.stringify({ name: "นำเข้า", title: "เรื่องนำเข้า", log: [{ role: "assistant", content: "ข" }], ctx: [], chapters: [] }))],
  configurable: true
});
fileInput.dispatchEvent(new w.Event("change"));
await settle(30);
check("valid import loads as a new game", $("headerTitle").textContent.includes("นำเข้า"), $("headerTitle").textContent);
check("import did not overwrite the previous game", titleBefore !== $("headerTitle").textContent);

out.push("[H] Undo at boundaries");
$("openDrawer").click(); await settle(5);
$("undoBtn").click(); await settle(30);
$("openDrawer").click(); await settle(5);
$("undoBtn").click(); await settle(30);
$("openDrawer").click(); await settle(5);
$("undoBtn").click(); await settle(30);
check("repeated undo past start does not crash", errs.filter(e => /TypeError|undefined/.test(e)).length === 0,
  errs.slice(0, 2).join(" | "));
check("app still responsive after over-undo", $("game").style.display === "flex");

out.push("[I] Retry with no turns yet");
$("openDrawer").click(); await settle(5);
$("retryBtn").click(); await settle(40);
check("retry with empty history does not crash", $("game").style.display === "flex");

out.push("[K] Gemini quota / model errors");
const lastErr = () => { const e = [...$("log").querySelectorAll(".msg.err")].pop(); return e ? e.textContent : ""; };
mode = "g404"; await turn("ทดสอบ404");
check("404 names the model and points to model list", /ไม่พบโมเดล/.test(lastErr()) && /โหลดรายชื่อโมเดล/.test(lastErr()), lastErr());
mode = "g429zero"; genCalls = 0; await turn("ทดสอบโควตา0");
check("limit:0 explained as no free quota for model", /ไม่มีโควตาฟรี/.test(lastErr()), lastErr());
check("limit:0 tries each fallback model once, no waiting loop", genCalls === 3, "calls=" + genCalls);
mode = "g429day"; genCalls = 0; await turn("ทดสอบรายวัน");
check("daily quota explained", /โควตารายวัน/.test(lastErr()), lastErr());
check("daily quota tries each fallback model once", genCalls === 3, "calls=" + genCalls);
$("log").querySelectorAll(".msg.err").forEach(e => e.remove());
mode = "wantedDown"; calledModels = []; const aiB = aiN(); await turn("สลับโมเดล");
check("model without quota → next model answers in one tap", aiN() === aiB + 1 && errN() === 0 && calledModels[1] === "gemini-3.1-flash-lite",
  calledModels.join(","));
check("user told which model was used", /สลับไปใช้/.test($("toast").textContent), $("toast").textContent);
mode = "ok";
check("API key sent in header, not in URL", lastHeaders && lastHeaders["x-goog-api-key"] === "K");
check("thinking kept low on Gemini 3 / latest", lastNarr.generationConfig.thinkingConfig && lastNarr.generationConfig.thinkingConfig.thinkingLevel === "low");
$("log").querySelectorAll(".msg.err").forEach(e => e.remove());
const aiBeforeRetry = aiN();
mode = "g429min"; genCalls = 0;
$("actionInput").value = "ทดสอบต่อนาที"; $("sendBtn").click(); await settle(450);
check("per-minute 429 waits and retries by itself", genCalls === 2 && aiN() === aiBeforeRetry + 1 && errN() === 0,
  "calls=" + genCalls + " err=" + errN());
mode = "ok";

$("settingsBtn").click(); await settle(5);
$("apiKeyInput").value = "K";
$("loadModelsBtn").click(); await settle(30);
const opts = [...$("modelSelect").options].map(o => o.value);
check("model list fetched from key, text models only", opts.join(",") === "gemini-flash-latest,gemini-2.5-pro", opts.join(","));
mode = "listbadkey";
$("loadModelsBtn").click(); await settle(30);
check("bad key reported when loading models", /API key ไม่ถูกต้อง/.test($("keyStatus").textContent), $("keyStatus").textContent);
mode = "ok";
$("settingsModal").querySelector("[data-close]").click(); await settle(5);

out.push("[J] Runtime error scan");
console.error = oe;
const realErrs = errs.filter(e => !/สรุปความจำไม่สำเร็จ|รวมตอนไม่สำเร็จ|STATE JSON/.test(e));
check("no unexpected runtime errors", realErrs.length === 0, realErrs.slice(0, 3).join(" | "));

console.log(out.join("\n"));
console.log("\n─────────────────────────────");
console.log("ผ่าน " + pass + " / ล้มเหลว " + fail);
console.log("─────────────────────────────\n");
process.exit(fail ? 1 : 0);
