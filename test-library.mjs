import { JSDOM } from "jsdom";
import fs from "fs";
import path from "path";
import "fake-indexeddb/auto";

// คลังนิยาย (library screen) + ปุ่ม 🌐 แปล
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

// ---------- seed 13 stories straight into IndexedDB ----------
const EN = "The rain fell on the neon streets.\n\nYang Jan looked up. \"Who is there?\" he asked.";
const TH = "ฝนตกลงบนถนนนีออน\n\nหยางจ่านเงยหน้าขึ้น \"ใครอยู่ตรงนั้น\" เขาถาม";
function story(i) {
  const en = i % 3 === 0;
  const log = [];
  for (let k = 1; k <= i; k++) {
    log.push({ role: "assistant", ep: k, words: 100 * k, t: k,
      content: "ตอนที่ " + k + ": บทที่ " + k + "\n\n" + (en ? EN : TH) + " #" + k });
  }
  return {
    id: "s_seed" + String(i).padStart(2, "0"),
    title: i === 7 ? "Eternity Nexus" : "เรื่องที่ " + i,
    name: "ตัวเอก" + i,
    world: i === 7 ? "Set in the near future, the virtual reality game Eternity Nexus launches. " + "x".repeat(200) : "โลกของเรื่องที่ " + i,
    mode: ["rpg", "story", "dnd", "cultivation"][i % 4],
    lang: en ? "en" : "th",
    level: i, log, ctx: [], chapters: [],
    createdAt: 1000 + i, updatedAt: 5000 + i,
  };
}
await new Promise((resolve, reject) => {
  const req = indexedDB.open("tale-engine", 1);
  req.onupgradeneeded = () => {
    req.result.createObjectStore("saves", { keyPath: "id" });
    req.result.createObjectStore("settings", { keyPath: "k" });
  };
  req.onsuccess = () => {
    const tx = req.result.transaction(["saves", "settings"], "readwrite");
    for (let i = 1; i <= 13; i++) tx.objectStore("saves").put(story(i));
    tx.objectStore("settings").put({ k: "lastSave", v: "s_seed12" });
    tx.objectStore("settings").put({ k: "apiKey", v: "K" });
    tx.oncomplete = () => { req.result.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  };
  req.onerror = () => reject(req.error);
});

// ---------- translation endpoints ----------
const calls = [];
let googleDown = false, gtxDown = false;
const fakeTr = (p, to) => "[" + to + "] " + p;
async function fakeFetch(url, opts) {
  url = String(url);
  calls.push(url);
  if (url.includes("clients5.google.com")) {
    if (googleDown) return { ok: false, status: 429, json: async () => ({}) };
    const to = new URL(url).searchParams.get("tl");
    const qs = new URLSearchParams(opts.body).getAll("q");
    return { ok: true, status: 200, json: async () => qs.map(q => [fakeTr(q, to), "en"]) };
  }
  if (url.includes("translate.googleapis.com")) {
    if (gtxDown) return { ok: false, status: 429, json: async () => ({}) };
    const u = new URL(url);
    return { ok: true, status: 200, json: async () => [[[fakeTr(u.searchParams.get("q"), u.searchParams.get("tl")), "x"]]] };
  }
  if (url.includes("mymemory")) {
    const u = new URL(url);
    return { ok: true, status: 200, json: async () => ({ responseStatus: 200,
      responseData: { translatedText: "MM:" + u.searchParams.get("q").trim() } }) };
  }
  throw new Error("unexpected fetch " + url);
}

const dom = new JSDOM(html, { url: "https://example.org/tale/", pretendToBeVisual: true, runScripts: "outside-only" });
const win = dom.window;
win.indexedDB = globalThis.indexedDB;
win.IDBKeyRange = globalThis.IDBKeyRange;
win.AbortController = globalThis.AbortController;
win.TextDecoder = globalThis.TextDecoder;
win.TextEncoder = globalThis.TextEncoder;
win.Blob = globalThis.Blob;
win.Intl = globalThis.Intl;
win.URLSearchParams = globalThis.URLSearchParams;
win.confirm = () => true;
win.fetch = fakeFetch;
win.SpeechSynthesisUtterance = function (text) { this.text = text; };
win.speechSynthesis = { getVoices: () => [], speak: () => { }, cancel: () => { } };
Object.defineProperty(win.navigator, "serviceWorker", { value: { register: async () => ({}) }, configurable: true });
const errors = [];
win.addEventListener("error", (e) => errors.push(String(e.message)));
console.error = (...a) => errors.push(a.map(String).join(" "));
win.eval(qidianjs);
win.eval(appjs);

const $ = (id) => win.document.getElementById(id);
const q = (s) => win.document.querySelectorAll(s);
const cards = () => [...q("#libGrid .libcard")];
const titles = () => cards().map(c => c.querySelector("h2").textContent);
const setSel = async (id, v) => { $(id).value = v; $(id).onchange(); await settle(20); };

console.log("\n═══ Tale Engine — library & translation tests ═══\n");
await settle(150);
check("boot still lands in the last story", $("game").style.display === "flex" && $("headerTitle").textContent === "เรื่องที่ 12",
  $("headerTitle").textContent);

out.push("[1] Library screen");
$("libBtn").click(); await settle(40);
check("📚 opens the library screen", $("library").style.display === "block" && $("game").style.display === "none");
check("count shows all stories", /ทั้งหมด 13 เรื่อง/.test($("libCount").textContent), $("libCount").textContent);
check("10 cards on page 1", cards().length === 10, "got " + cards().length);
// the story just left is the most recent one — it sits on top, ready to resume
check("most recent first", titles()[0] === "เรื่องที่ 12" && titles()[1] === "เรื่องที่ 13", titles().slice(0, 3).join(","));
check("story being read is marked", cards()[0].classList.contains("current") && /กำลังอ่าน/.test(cards()[0].textContent));
const c12 = cards()[0];
check("card shows chapters", /📖 12 ตอน/.test(c12.textContent), c12.querySelector(".libstats").textContent);
check("card shows word count", /≈7,800 คำ/.test(c12.textContent), c12.querySelector(".libstats").textContent);
check("card shows latest chapter title", /ล่าสุด: ตอนที่ 12: บทที่ 12/.test(c12.textContent));
check("card shows genre + language tags", /⚔️ RPG/.test(c12.textContent) && /🇬🇧 English/.test(c12.textContent));
check("pager has 2 pages", [...q("#libPager button")].map(b => b.textContent).join(" ") === "‹ 1 2 ›",
  [...q("#libPager button")].map(b => b.textContent).join(" "));
[...q("#libPager button")].find(b => b.textContent === "2").click(); await settle(10);
check("page 2 holds the last 3", cards().length === 3 && titles()[2] === "เรื่องที่ 1", titles().join(","));

out.push("[2] Search, filters, sort");
$("libSearch").value = "eternity"; $("libSearch").oninput(); await settle(80);
check("search finds by title/world (any case)", cards().length === 1 && titles()[0] === "Eternity Nexus", titles().join(","));
check("count says filtered", /พบ 1 จาก 13/.test($("libCount").textContent), $("libCount").textContent);
const desc = cards()[0].querySelector(".libdesc");
const more = cards()[0].querySelector(".libmore");
check("long synopsis has read-more", !!more);
more.click();
check("read-more expands", desc.classList.contains("open") && more.textContent.startsWith("ย่อ"));
$("libSearch").value = "ไม่มีเรื่องนี้แน่นอน"; $("libSearch").oninput(); await settle(80);
check("empty result message", cards().length === 0 && /ไม่พบเรื่อง/.test($("libGrid").textContent));
$("libSearch").value = ""; $("libSearch").oninput(); await settle(80);
await setSel("libGenre", "dnd");
check("genre filter", cards().length === 3 && titles().every(t => [2, 6, 10].includes(+t.replace(/\D/g, ""))), titles().join(","));
await setSel("libLang", "en");
check("genre + language combine", cards().length === 1 && titles()[0] === "เรื่องที่ 6", titles().join(","));
$("libClear").click(); await settle(20);
check("clear filters restores everything", cards().length === 10 && $("libGenre").value === "" && $("libLang").value === "");
await setSel("libSort", "name");
check("name sort defaults to A→Z, numbers in order", $("libOrder").textContent.includes("↑") &&
  titles().slice(0, 3).join(",") === "เรื่องที่ 1,เรื่องที่ 2,เรื่องที่ 3", titles().slice(0, 3).join(","));
await setSel("libSort", "chapters");
check("chapter sort biggest first", titles()[0] === "เรื่องที่ 13", titles()[0]);
$("libOrder").click(); await settle(20);
check("order toggle flips", titles()[0] === "เรื่องที่ 1", titles()[0]);

out.push("[3] Status");
cards()[0].querySelector('[data-act="done"]').click(); await settle(40);
await setSel("libStatus", "completed");
check("mark as completed + status filter", cards().length === 1 && titles()[0] === "เรื่องที่ 1" && /จบแล้ว/.test(cards()[0].querySelector(".libst").textContent));
check("completed button flips to undo", /ยังไม่จบ/.test(cards()[0].querySelector('[data-act="done"]').textContent));
await setSel("libStatus", "ongoing");
check("ongoing filter excludes it", cards().length === 10 && !titles().includes("เรื่องที่ 1"));
$("libClear").click(); await settle(20);

out.push("[4] Open stories");
await setSel("libSort", "updated");
cards().find(c => c.querySelector("h2").textContent === "เรื่องที่ 5").querySelector('[data-act="read"]').click();
await settle(60);
check("อ่านต่อ opens that story", $("game").style.display === "flex" && $("headerTitle").textContent === "เรื่องที่ 5", $("headerTitle").textContent);
check("its chapters are rendered", q("#log .msg.ai.episode").length === 5);
$("libBtn").click(); await settle(40);
check("current marker moved", cards().find(c => c.classList.contains("current")).querySelector("h2").textContent === "เรื่องที่ 5");
check("back button shown when a story is open", $("libBack").style.display !== "none");
$("libBack").click(); await settle(10);
check("back returns to the story", $("game").style.display === "flex" && $("headerTitle").textContent === "เรื่องที่ 5");
$("libBtn").click(); await settle(40);
cards().find(c => c.querySelector("h2").textContent === "เรื่องที่ 5").querySelector('[data-act="start"]').click();
await settle(40);
check("ตั้งแต่ต้น starts at the top", $("log").scrollTop === 0 && !q("#log .loadmore").length);

out.push("[5] Delete and prefs");
$("libBtn").click(); await settle(40);
await setSel("libSort", "level"); $("libOrder").click(); await settle(20);
cards().find(c => c.querySelector("h2").textContent === "เรื่องที่ 3").querySelector('[data-act="del"]').click();
await settle(40);
check("delete removes the card", /ทั้งหมด 12 เรื่อง/.test($("libCount").textContent) && !titles().includes("เรื่องที่ 3"));
await setSel("libSort", "words");
const stored = await new Promise(r => {
  const req = indexedDB.open("tale-engine", 1);
  req.onsuccess = () => {
    const g = req.result.transaction("settings").objectStore("settings").get("libPrefs");
    g.onsuccess = () => { r(g.result && g.result.v); req.result.close(); };
  };
});
check("sort choice remembered", stored && stored.sort === "words", JSON.stringify(stored));

out.push("[6] 🌐 Translate");
cards().find(c => c.querySelector("h2").textContent === "Eternity Nexus").querySelector('[data-act="read"]').click();
await settle(60);
const rows = () => [...q("#log .msgtools")];
const trBtn = () => rows()[0].querySelector(".trbtn");
check("every chapter has a translate button", rows().length === 7 && rows().every(r => r.querySelector(".trbtn")));
check("translate options filled", $("trToSelect").options.length > 5 && $("trToSelect").value === "auto");
calls.length = 0;
trBtn().click(); await settle(40);
let panel = rows()[0].nextElementSibling;
check("panel appears under the chapter", panel && panel.classList.contains("trans"));
check("Thai story auto-translates to English", /English/.test(panel.querySelector(".trhead").textContent) && panel.textContent.includes("[en] ฝนตกลงบนถนนนีออน"));
check("paragraph breaks kept", panel.querySelector(".trbody").textContent.split("\n").length === 5, JSON.stringify(panel.querySelector(".trbody").textContent));
check("one POST for the whole chapter", calls.length === 1 && calls[0].includes("clients5"), calls.join(" | "));
check("button toggles to hide", /ซ่อนคำแปล/.test(trBtn().textContent));
trBtn().click(); await settle(5);
check("second tap hides", !rows()[0].nextElementSibling.classList.contains("trans") && trBtn().textContent === "🌐 แปล");
trBtn().click(); await settle(20);
check("reopening uses the saved translation (no request)", calls.length === 1 && rows()[0].nextElementSibling.classList.contains("trans"));
rows()[0].nextElementSibling.querySelector(".x").click(); await settle(5);
check("✕ closes the panel", !rows()[0].nextElementSibling.classList.contains("trans"));

$("trToSelect").value = "ja"; await $("trToSelect").onchange(); await settle(10);
trBtn().click(); await settle(40);
check("chosen target language used", rows()[0].nextElementSibling.textContent.includes("[ja]") && calls.length === 2);
trBtn().click(); await settle(5);

googleDown = true;
rows()[1].querySelector(".trbtn").click(); await settle(40);
check("falls back to the second Google endpoint", rows()[1].nextElementSibling.textContent.includes("[ja]") && calls.some(u => u.includes("googleapis")));
googleDown = true; gtxDown = true;
$("trToSelect").value = "auto"; await $("trToSelect").onchange(); await settle(10);
rows()[2].querySelector(".trbtn").click(); await settle(60);
check("then to MyMemory", rows()[2].nextElementSibling.textContent.includes("MM:"), rows()[2].nextElementSibling.textContent.slice(0, 80));
check("MyMemory pieces are small", calls.filter(u => u.includes("mymemory")).every(u => decodeURIComponent(new URL(u).searchParams.get("q")).length <= 500));

win.fetch = async () => { throw new Error("offline"); };
rows()[3].querySelector(".trbtn").click(); await settle(40);
check("failure leaves the button usable", rows()[3].querySelector(".trbtn").textContent === "🌐 แปล" && !rows()[3].querySelector(".trbtn").disabled);

await settle(150);
const saved = await new Promise(r => {
  const req = indexedDB.open("tale-engine", 1);
  req.onsuccess = () => {
    const g = req.result.transaction("saves").objectStore("saves").get("s_seed07");
    g.onsuccess = () => { r(g.result); req.result.close(); };
  };
});
check("translation cached in the save", saved && saved.log.some(m => m.tr && m.tr.to === "ja" && m.tr.text.includes("[ja]")));

check("no runtime errors", errors.filter(e => !/Not implemented: navigation/.test(e)).length === 0, errors[0]);

console.log(out.join("\n"));
console.log("\n─────────────────────────────\nผ่าน " + pass + " / ล้มเหลว " + fail + "\n─────────────────────────────\n");
process.exit(fail ? 1 : 0);
