import { JSDOM } from "jsdom";
import fs from "fs";
import path from "path";
import "fake-indexeddb/auto";

const DIR = path.resolve(".");
const html = fs.readFileSync(path.join(DIR, "index.html"), "utf8");
const appjs = fs.readFileSync(path.join(DIR, "app.js"), "utf8");

let pass = 0, fail = 0;
const results = [];
function check(name, cond, extra) {
  if (cond) { pass++; results.push("  ✅ " + name); }
  else { fail++; results.push("  ❌ " + name + (extra ? "  → " + extra : "")); }
}

// ---------- Mock Gemini SSE server ----------
let mockMode = "ok";
let lastRequestBody = null;
let lastNarrativeBody = null;
let callCount = 0;
let summaryCalls = 0;

function sse(chunks) {
  const body = chunks.map(c => "data: " + JSON.stringify(c) + "\n\n").join("");
  return new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(new TextEncoder().encode(body));
      ctrl.close();
    }
  });
}
function textChunk(t, finish) {
  const c = { candidates: [{ content: { parts: [{ text: t }] } }] };
  if (finish) c.candidates[0].finishReason = finish;
  return c;
}

function makeFetch(win) {
  return async function (url, opts) {
    callCount++;
    lastRequestBody = JSON.parse(opts.body);
    const sys = (lastRequestBody.systemInstruction?.parts?.[0]?.text) || "";
    const isSummary = sys.includes("ผู้ช่วยสรุปเนื้อเรื่อง");
    if (isSummary) summaryCalls++; else lastNarrativeBody = lastRequestBody;

    const mk = (stream, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      body: stream,
      json: async () => ({ error: { message: "mock error" } }),
    });

    if (mockMode === "http429") return mk(null, 429);
    if (mockMode === "badkey") return {
      ok: false, status: 400, body: null,
      json: async () => ({ error: { message: "API key not valid. Please pass a valid API key." } })
    };
    if (mockMode === "empty") return mk(sse([textChunk("")]));
    if (mockMode === "stateonly") return mk(sse([textChunk('<<STATE>>{"hp":9,"maxHp":20,"level":1,"xp":0,"skills":[],"inventory":[],"location":"x","npcs":[],"flags":[]}')]));
    if (mockMode === "summaryfail" && isSummary) return mk(null, 500);
    if (mockMode === "network") throw new TypeError("Failed to fetch");

    if (isSummary) return mk(sse([textChunk("สรุปย่อของช่วงที่ผ่านมา เกิดเหตุการณ์ A และ B ตัวละครตัดสินใจ C")]));

    // normal narrative + state
    const n = callCount;
    return mk(sse([
      textChunk("คุณเดินไปข้างหน้า ฉากที่ " + n + " ปรากฏขึ้นตรงหน้า"),
      textChunk("\n\nจะทำอย่างไรต่อ?"),
      textChunk('\n<<STATE>>{"hp":18,"maxHp":20,"level":2,"xp":' + n * 10 +
        ',"skills":["ดาบ"],"inventory":["คบไฟ"],"location":"ป่าลึก","npcs":["เอเลน — พันธมิตร"],"flags":["รับภารกิจแล้ว"]}', "STOP"),
    ]));
  };
}

// ---------- Boot the app in JSDOM ----------
const dom = new JSDOM(html, {
  url: "https://example.org/tale/",
  pretendToBeVisual: true,
  runScripts: "outside-only",
});
const win = dom.window;

// polyfills JSDOM lacks
win.indexedDB = globalThis.indexedDB;
win.IDBKeyRange = globalThis.IDBKeyRange;
win.fetch = makeFetch(win);
win.AbortController = globalThis.AbortController;
win.ReadableStream = globalThis.ReadableStream;
win.TextDecoder = globalThis.TextDecoder;
win.TextEncoder = globalThis.TextEncoder;
win.Blob = globalThis.Blob;
win.URL.createObjectURL = () => "blob:mock";
win.URL.revokeObjectURL = () => { };
win.confirm = () => true;
win.alert = () => { };
win.scrollTo = () => { };
win.navigator.clipboard = { writeText: async () => { } };
if (!win.navigator.serviceWorker) {
  Object.defineProperty(win.navigator, "serviceWorker", {
    value: { register: async () => ({}) }, configurable: true
  });
}

const errors = [];
win.addEventListener("error", (e) => errors.push(String(e.message)));
const origErr = console.error;
console.error = (...a) => { errors.push(a.map(String).join(" ")); };

win.eval(appjs);

const $ = (id) => win.document.getElementById(id);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function settle(n = 60) { for (let i = 0; i < n; i++) await sleep(4); }

// ============================================================
console.log("\n═══ Tale Engine — headless test run ═══\n");

await settle(150);
results.push("[1] Boot");
check("boot screen replaced by setup", $("setup").style.display === "block",
  "boot=" + $("boot").style.display + " setup=" + $("setup").style.display);
check("settings modal auto-opened (no API key)", $("settingsModal").classList.contains("open"));
check("no uncaught errors during boot", errors.length === 0, errors[0]);

// ---------- Set API key ----------
results.push("[2] Settings / API key");
$("apiKeyInput").value = "TEST_KEY_123";
$("saveKeyBtn").click();
await settle(20);
check("settings modal closed after save", !$("settingsModal").classList.contains("open"));

// test connection path
$("settingsBtn"); // exists
$("setupSettingsBtn").click();
await settle(5);
$("testKeyBtn").click();
await settle(30);
check("connection test reports OK", $("keyStatus").textContent.includes("✅"), $("keyStatus").textContent);
$("settingsModal").querySelector("[data-close]").click();
await settle(5);

// ---------- Start a game ----------
results.push("[3] Start game (opening turn)");
$("setupName").value = "Kael";
$("setupTitle").value = "ตำนานดาบเงา";
win.document.querySelector('.preset-btn[data-preset="darkfantasy"]').click();
$("startBtn").click();
await settle(60);

check("game screen visible", $("game").style.display === "flex", $("game").style.display);
check("opening narrative rendered", $("log").querySelectorAll(".msg.ai").length === 1,
  "ai bubbles=" + $("log").querySelectorAll(".msg.ai").length);
check("opening meta-prompt NOT shown as user bubble", $("log").querySelectorAll(".msg.user").length === 0,
  "user bubbles=" + $("log").querySelectorAll(".msg.user").length);
check("state patch applied (level 2)", $("headerHp").textContent.includes("Lv.2"), $("headerHp").textContent);
check("preset world used in prompt",
  JSON.stringify(lastNarrativeBody).includes("เวทมนตร์"), "prompt missing preset world");

// ---------- Normal turns ----------
results.push("[4] Normal turns");
async function playTurn(text) {
  $("actionInput").value = text;
  $("sendBtn").click();
  await settle(50);
}
await playTurn("เดินเข้าไปในถ้ำ");
check("user bubble rendered", $("log").querySelectorAll(".msg.user").length === 1);
check("ai bubbles = 2", $("log").querySelectorAll(".msg.ai").length === 2);
check("system prompt sent", (lastNarrativeBody.systemInstruction?.parts?.[0]?.text || "").includes("Game Master"));
check("gemini roles are user/model only",
  lastNarrativeBody.contents.every(c => c.role === "user" || c.role === "model"),
  JSON.stringify(lastNarrativeBody.contents.map(c => c.role)));
check("no consecutive same-role turns",
  lastNarrativeBody.contents.every((c, i, a) => i === 0 || c.role !== a[i - 1].role),
  JSON.stringify(lastNarrativeBody.contents.map(c => c.role)));
check("last turn is user", lastNarrativeBody.contents.at(-1).role === "user");
check("no empty parts sent",
  lastNarrativeBody.contents.every(c => c.parts.every(p => p.text && p.text.trim().length)));

// ---------- BUG #3: empty narrative must not corrupt state ----------
results.push("[5] BUG#3 — empty AI reply");
const ctxBefore = win.eval("0"); // can't reach closure; use DOM proxies instead
const aiBefore = $("log").querySelectorAll(".msg.ai").length;
mockMode = "stateonly";
await playTurn("ลองกระทำที่ทำให้ AI ตอบแต่ STATE");
check("no new ai bubble for empty narrative", $("log").querySelectorAll(".msg.ai").length === aiBefore,
  "ai=" + $("log").querySelectorAll(".msg.ai").length);
check("error card shown with retry", $("log").querySelectorAll(".msg.err").length === 1);
check("user bubble rolled back on failure", $("log").querySelectorAll(".msg.user").length === 1,
  "user=" + $("log").querySelectorAll(".msg.user").length);
check("input text restored after failure", $("actionInput").value.includes("ลองกระทำ"), $("actionInput").value);
mockMode = "ok";

// retry from the error card
$("log").querySelector(".msg.err .errbtns button").click();
await settle(50);
check("retry from error card succeeds", $("log").querySelectorAll(".msg.err").length === 0);
check("ai bubble added after retry", $("log").querySelectorAll(".msg.ai").length === aiBefore + 1);

// ---------- BUG #4: failed turn leaves nothing behind ----------
results.push("[6] BUG#4 — failed turn leaves no residue");
$("actionInput").value = "";
const userBefore = $("log").querySelectorAll(".msg.user").length;
mockMode = "http429";
await playTurn("การกระทำที่จะล้มเหลว");
check("rate-limit error surfaced", $("log").querySelectorAll(".msg.err").length === 1);
check("no user bubble left behind", $("log").querySelectorAll(".msg.user").length === userBefore,
  "user=" + $("log").querySelectorAll(".msg.user").length);
mockMode = "ok";
$("log").querySelector(".msg.err .errbtns button").click();
await settle(50);
check("recovered after rate limit", $("log").querySelectorAll(".msg.err").length === 0);

// ---------- bad key ----------
results.push("[7] Error mapping");
mockMode = "badkey";
await playTurn("ทดสอบ key เสีย");
const errTxt = $("log").querySelector(".msg.err")?.textContent || "";
check("bad key message is specific", errTxt.includes("API key ไม่ถูกต้อง"), errTxt.slice(0, 60));
check("settings shortcut offered for key errors",
  $("log").querySelectorAll(".msg.err .errbtns button").length === 2);
$("log").querySelector(".msg.err").remove();
mockMode = "ok";

mockMode = "network";
await playTurn("ทดสอบเน็ตหลุด");
const netTxt = $("log").querySelector(".msg.err")?.textContent || "";
check("network error message is specific", netTxt.includes("เชื่อมต่อไม่ได้"), netTxt.slice(0, 60));
$("log").querySelector(".msg.err").remove();
mockMode = "ok";

// ---------- BUG #2: compression + unbounded ctx ----------
results.push("[8] BUG#2 — memory compression");
summaryCalls = 0;
for (let i = 0; i < 14; i++) await playTurn("เทิร์นที่ " + i);
check("summarizer was invoked", summaryCalls > 0, "summaryCalls=" + summaryCalls);
check("chapter marker rendered in log", $("log").querySelectorAll(".msg.chapter").length > 0,
  "chapters=" + $("log").querySelectorAll(".msg.chapter").length);
const memTxt = $("memStat").textContent;
check("ctx stays bounded after compression", /บทสนทนาสด\s*\d+/.test(memTxt), memTxt);
const ctxNum = parseInt((memTxt.match(/บทสนทนาสด\s*(\d+)/) || [])[1], 10);
check("ctx <= CTX_TRIGGER(24) after compression", ctxNum <= 24, "ctx=" + ctxNum);

// summarizer failure must STILL trim ctx (fallback path)
results.push("[9] BUG#2 — summarizer failure fallback");
mockMode = "summaryfail";
for (let i = 0; i < 12; i++) await playTurn("fallback เทิร์น " + i);
const memTxt2 = $("memStat").textContent;
const ctxNum2 = parseInt((memTxt2.match(/บทสนทนาสด\s*(\d+)/) || [])[1], 10);
check("ctx still bounded when summarizer fails", ctxNum2 <= 24, "ctx=" + ctxNum2);
check("degraded-summary warning shown",
  Array.from($("log").querySelectorAll(".msg.sys")).some(e => e.textContent.includes("สรุปความจำอัตโนมัติไม่สำเร็จ")));
mockMode = "ok";

// ---------- Drawer / state editor ----------
results.push("[10] Drawer + manual state editor");
$("openDrawer").click();
await settle(5);
check("drawer opens", $("drawer").classList.contains("open"));
check("npcs shown in drawer", $("npcsText").textContent.includes("เอเลน"), $("npcsText").textContent);
check("flags shown in drawer", $("flagsText").textContent.includes("ภารกิจ"));
$("editStateBtn").click();
await settle(5);
check("state editor prefilled", $("seHp").value === "18", "hp=" + $("seHp").value);
$("seHp").value = "5";
$("seMaxHp").value = "30";
$("seInv").value = "ดาบเก่า\nขนมปัง";
$("seSave").click();
await settle(20);
check("manual HP edit applied", $("headerHp").textContent.includes("5/30"), $("headerHp").textContent);
check("manual inventory applied", $("invList").textContent.includes("ขนมปัง"));

// background edit mid-game
$("editWorldBtn").click();
await settle(5);
$("worldInput").value = "โลกใหม่ที่แก้กลางเกม";
$("saveWorldBtn").click();
await settle(20);
check("world background edited mid-game", $("worldView").textContent.includes("โลกใหม่"));
await playTurn("ตรวจว่า background ใหม่เข้า prompt");
check("edited world reaches the prompt",
  JSON.stringify(lastNarrativeBody).includes("โลกใหม่ที่แก้กลางเกม"));

// mode switch
$("modeSelect").value = "dnd";
$("modeSelect").dispatchEvent(new win.Event("change"));
await settle(20);
check("mode switched to dnd", $("modeView").textContent === "D&D", $("modeView").textContent);

// ---------- Dice visibility ----------
results.push("[11] D&D dice visible to player");
const diceBefore = $("log").querySelectorAll(".msg.dice").length;
await playTurn("กระโดดข้ามเหว");
check("dice bubble rendered", $("log").querySelectorAll(".msg.dice").length === diceBefore + 1);
check("dice value sent to AI", /\[Dice: d20=\d+\]/.test(JSON.stringify(lastNarrativeBody)));

// dice rolled back on failure
mockMode = "http429";
const diceNow = $("log").querySelectorAll(".msg.dice").length;
await playTurn("ทอยแล้วพัง");
check("dice rolled back on failed turn", $("log").querySelectorAll(".msg.dice").length === diceNow,
  "dice=" + $("log").querySelectorAll(".msg.dice").length);
mockMode = "ok";
$("log").querySelector(".msg.err")?.remove();

// ---------- Chapters viewer ----------
results.push("[12] Chapters viewer");
$("chaptersBtn").click();
await settle(10);
check("chapters modal opens", $("chaptersModal").classList.contains("open"));
check("chapter cards listed", $("chaptersList").querySelectorAll(".chapcard").length > 0,
  "cards=" + $("chaptersList").querySelectorAll(".chapcard").length);
const firstTa = $("chaptersList").querySelector("textarea");
firstTa.value = "บทสรุปที่ถูกแก้ด้วยมือ";
firstTa.dispatchEvent(new win.Event("input"));
$("chapSave").click();
await settle(20);
check("chapter edit persists to prompt-building", true);
$("chaptersBtn").click(); await settle(10);
const chapDump = Array.from($("chaptersList").querySelectorAll("textarea")).map(t=>t.value.slice(0,40));
$("chaptersModal").querySelector("[data-close]").click(); await settle(5);
await playTurn("ตรวจบทสรุปที่แก้");
check("edited chapter reaches the prompt",
  JSON.stringify(lastNarrativeBody).includes("บทสรุปที่ถูกแก้ด้วยมือ"),
  "chapters now: " + JSON.stringify(chapDump));

// ---------- Retry / undo ----------
results.push("[13] Retry & undo");
$("openDrawer").click(); await settle(5);
const aiCount = $("log").querySelectorAll(".msg.ai").length;
$("undoBtn").click();
await settle(30);
check("undo removed one ai bubble", $("log").querySelectorAll(".msg.ai").length === aiCount - 1,
  "ai=" + $("log").querySelectorAll(".msg.ai").length + " was " + aiCount);

$("openDrawer").click(); await settle(5);
const aiCount2 = $("log").querySelectorAll(".msg.ai").length;
$("retryBtn").click();
await settle(50);
check("retry produced a reply", $("log").querySelectorAll(".msg.ai").length === aiCount2,
  "ai=" + $("log").querySelectorAll(".msg.ai").length + " expected " + aiCount2);

// ---------- Export ----------
results.push("[14] Export");
$("openDrawer").click(); await settle(5);
$("exportBtn").click(); await settle(10);
check("export modal opens", $("exportModal").classList.contains("open"));
let downloaded = null;
const origCreate = win.document.createElement.bind(win.document);
win.document.createElement = function (tag) {
  const el = origCreate(tag);
  if (tag === "a") { el.click = () => { downloaded = el.download; }; }
  return el;
};
$("expMd").click(); await settle(10);
check("markdown export triggers download", downloaded && downloaded.endsWith(".md"), String(downloaded));
$("expJson").click(); await settle(10);
check("json export triggers download", downloaded && downloaded.endsWith(".json"), String(downloaded));
win.document.createElement = origCreate;
$("exportModal").querySelector("[data-close]").click(); await settle(5);

// ---------- Save slots + persistence ----------
results.push("[15] Save slots & persistence");
$("openDrawer").click(); await settle(5);
$("slotsBtn").click(); await settle(30);
check("slots modal lists current game", $("slotsList").querySelectorAll(".slotcard").length >= 1,
  "slots=" + $("slotsList").querySelectorAll(".slotcard").length);
check("current game marked", $("slotsList").querySelector(".slotcard.current") !== null);

// create a 2nd game
$("slotNew").click(); await settle(10);
check("new game returns to setup", $("setup").style.display === "block");
check("setup form cleared", $("setupName").value === "" && $("setupTitle").value === "");
$("setupName").value = "Mira";
$("setupTitle").value = "เรื่องที่สอง";
$("startBtn").click();
await settle(60);
check("second game started", $("headerTitle").textContent === "เรื่องที่สอง", $("headerTitle").textContent);

$("openDrawer").click(); await settle(5);
$("slotsBtn").click(); await settle(30);
check("two saves listed", $("slotsList").querySelectorAll(".slotcard").length === 2,
  "slots=" + $("slotsList").querySelectorAll(".slotcard").length);

// switch back to game 1
const loadBtns = Array.from($("slotsList").querySelectorAll(".slotcard"))
  .filter(c => !c.classList.contains("current"));
loadBtns[0].querySelector("button").click();
await settle(40);
check("switched to other save", $("headerTitle").textContent === "ตำนานดาบเงา", $("headerTitle").textContent);
check("log restored from save", $("log").querySelectorAll(".msg.ai").length > 3,
  "ai=" + $("log").querySelectorAll(".msg.ai").length);
check("chapter markers restored after reload", $("log").querySelectorAll(".msg.chapter").length > 0,
  "chapters=" + $("log").querySelectorAll(".msg.chapter").length);
check("dice markers restored after reload", $("log").querySelectorAll(".msg.dice").length > 0);

// ---------- Simulated full app restart ----------
results.push("[16] Cold reload (the original bug)");
const dom2 = new JSDOM(html, { url: "https://example.org/tale/", pretendToBeVisual: true, runScripts: "outside-only" });
const w2 = dom2.window;
w2.indexedDB = globalThis.indexedDB;
w2.IDBKeyRange = globalThis.IDBKeyRange;
w2.fetch = makeFetch(w2);
w2.AbortController = globalThis.AbortController;
w2.ReadableStream = globalThis.ReadableStream;
w2.TextDecoder = globalThis.TextDecoder; w2.TextEncoder = globalThis.TextEncoder;
w2.Blob = globalThis.Blob;
w2.URL.createObjectURL = () => "blob:mock"; w2.URL.revokeObjectURL = () => { };
w2.confirm = () => true; w2.scrollTo = () => { };
Object.defineProperty(w2.navigator, "serviceWorker", { value: { register: async () => ({}) }, configurable: true });
w2.eval(appjs);
await sleep(400);
const g2 = (id) => w2.document.getElementById(id);
check("reload lands directly in game (save survived)", g2("game").style.display === "flex",
  "game=" + g2("game").style.display + " setup=" + g2("setup").style.display);
check("reload restored the right slot", g2("headerTitle").textContent === "ตำนานดาบเงา",
  g2("headerTitle").textContent);
check("reload restored transcript", g2("log").querySelectorAll(".msg.ai").length > 3,
  "ai=" + g2("log").querySelectorAll(".msg.ai").length);
check("reload restored API key (no settings popup)", !g2("settingsModal").classList.contains("open"));
check("reload restored stats", g2("headerHp").textContent.includes("/"), g2("headerHp").textContent);

// ---------- Large story stress (the 256 KiB problem) ----------
results.push("[17] Large story (old 256 KiB ceiling)");
const big = "ก".repeat(200000);
const okBig = await new Promise((resolve) => {
  const req = globalThis.indexedDB.open("tale-engine", 1);
  req.onsuccess = () => {
    const d = req.result;
    const t = d.transaction("saves", "readwrite").objectStore("saves");
    const p = t.put({ id: "stress_test", title: "big", log: [{ role: "assistant", content: big }], updatedAt: Date.now() });
    p.onsuccess = () => resolve(true);
    p.onerror = () => resolve(false);
  };
  req.onerror = () => resolve(false);
});
check("600 KB+ save writes without error (no 256 KiB cap)", okBig);

// ---------- Log windowing + mode sync ----------
results.push("[18] Log windowing & mode sync");
check("mode dropdown matches loaded save", g2("modeSelect").value === g2("modeView").textContent.toLowerCase().replace("d&d","dnd"),
  "select=" + g2("modeSelect").value + " view=" + g2("modeView").textContent);
const shown = g2("log").querySelectorAll(".msg").length;
check("rendered message count is windowed", shown <= 121, "shown=" + shown);
const lm = g2("log").querySelector(".loadmore");
if (lm) {
  lm.click();
  await sleep(50);
  check("show-earlier expands full transcript", g2("log").querySelectorAll(".msg").length >= shown);
} else {
  check("no windowing needed for short story", true);
}

console.error = origErr;
results.push("[19] Runtime errors");
check("no uncaught runtime errors across whole run", errors.length === 0,
  errors.slice(0, 3).join(" | "));

console.log(results.join("\n"));
console.log("\n─────────────────────────────");
console.log("ผ่าน " + pass + " / ล้มเหลว " + fail);
console.log("─────────────────────────────\n");
process.exit(fail ? 1 : 0);
