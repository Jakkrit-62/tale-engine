import { JSDOM } from "jsdom";
import fs from "fs";
import path from "path";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

// ☁️ Google Drive backup — two devices sharing one (mock) Drive
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
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(20); }
  return false;
}

// ---------- mock Google Drive (appDataFolder) ----------
const drive = new Map();          // id → { id, name, appProperties, body: Uint8Array, parents }
let nextId = 1;
const calls = [];
let fail401 = false;
const API = "https://www.googleapis.com/drive/v3/files";
const UP = "https://www.googleapis.com/upload/drive/v3/files";
const meta = (f) => ({ id: f.id, name: f.name, appProperties: { ...f.appProperties }, modifiedTime: new Date(f.t).toISOString(), size: String(f.body.length) });
const tokensSeen = new Set();

async function driveFetch(url, opts = {}) {
  url = String(url);
  const method = (opts.method || "GET").toUpperCase();
  const auth = (opts.headers || {}).Authorization || "";
  calls.push(method + " " + url.replace(/\?.*/, ""));
  if (!auth.startsWith("Bearer tok")) return new Response("{}", { status: 401 });
  tokensSeen.add(auth);
  if (fail401) { fail401 = false; return new Response(JSON.stringify({ error: { message: "expired" } }), { status: 401 }); }
  const u = new URL(url);
  if (url.startsWith(UP)) {
    const md = JSON.parse(await opts.body.get("metadata").text());
    const body = new Uint8Array(await opts.body.get("file").arrayBuffer());
    const id = u.pathname.split("/files/")[1];
    let f;
    if (id) { f = drive.get(id); if (!f) return new Response("{}", { status: 404 }); Object.assign(f, { name: md.name || f.name, appProperties: md.appProperties || f.appProperties, body, t: Date.now() }); }
    else {
      if (!(md.parents || []).includes("appDataFolder")) return new Response("{}", { status: 400 });
      f = { id: "f" + nextId++, name: md.name, appProperties: md.appProperties || {}, body, t: Date.now() };
      drive.set(f.id, f);
    }
    return new Response(JSON.stringify(meta(f)), { status: 200 });
  }
  const m = u.pathname.match(/\/files\/([^/]+)(\/copy)?$/);
  if (!m) {
    if (u.searchParams.get("spaces") !== "appDataFolder") return new Response("{}", { status: 400 });
    return new Response(JSON.stringify({ files: [...drive.values()].map(meta) }), { status: 200 });
  }
  const f = drive.get(m[1]);
  if (!f) return new Response("{}", { status: 404 });
  if (m[2]) {
    const md = JSON.parse(opts.body);
    const c = { id: "f" + nextId++, name: md.name, appProperties: md.appProperties || {}, body: f.body.slice(), t: Date.now() };
    drive.set(c.id, c);
    return new Response(JSON.stringify(meta(c)), { status: 200 });
  }
  if (method === "DELETE") { drive.delete(f.id); return new Response(null, { status: 204 }); }
  if (u.searchParams.get("alt") === "media") return new Response(f.body, { status: 200 });
  return new Response(JSON.stringify(meta(f)), { status: 200 });
}
const names = () => [...drive.values()].map(f => f.name).sort();
const storyFile = (sid) => [...drive.values()].find(f => f.name === "story-" + sid);
async function remoteSave(sid) {
  const f = storyFile(sid);
  const stream = new Blob([f.body]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}

// ---------- a "device" = its own window + its own IndexedDB ----------
let tokenN = 0, shortToken = false, persistAsked = 0;
async function device(label, seed) {
  const idb = new IDBFactory();
  if (seed) {
    await new Promise((resolve) => {
      const req = idb.open("tale-engine", 1);
      req.onupgradeneeded = () => { req.result.createObjectStore("saves", { keyPath: "id" }); req.result.createObjectStore("settings", { keyPath: "k" }); };
      req.onsuccess = () => {
        const tx = req.result.transaction(["saves", "settings"], "readwrite");
        for (const s of seed) tx.objectStore("saves").put(s);
        tx.objectStore("settings").put({ k: "lastSave", v: seed[0].id });
        tx.objectStore("settings").put({ k: "apiKey", v: "K" });
        tx.oncomplete = () => { req.result.close(); resolve(); };
      };
    });
  }
  const dom = new JSDOM(html, { url: "https://example.org/tale/", pretendToBeVisual: true, runScripts: "outside-only" });
  const w = dom.window;
  w.indexedDB = idb; w.IDBKeyRange = IDBKeyRange;
  for (const k of ["AbortController", "TextDecoder", "TextEncoder", "Blob", "Intl", "Response", "FormData",
    "CompressionStream", "DecompressionStream", "URLSearchParams", "ReadableStream"]) w[k] = globalThis[k];
  w.confirm = () => true;
  w.fetch = driveFetch;
  w.SpeechSynthesisUtterance = function () { };
  w.speechSynthesis = { getVoices: () => [], speak: () => { }, cancel: () => { } };
  Object.defineProperty(w.navigator, "serviceWorker", { value: { register: async () => ({}) }, configurable: true });
  Object.defineProperty(w.navigator, "storage", { value: { persist: async () => { persistAsked++; return true; } }, configurable: true });
  w.google = { accounts: { oauth2: {
    initTokenClient: (cfg) => ({ requestAccessToken: () => setTimeout(() => cfg.callback({ access_token: "tok" + (++tokenN), expires_in: shortToken ? 1 : 3600 }), 5) }),
    revoke: () => { },
  } } };
  const errors = [];
  w.addEventListener("error", (e) => errors.push(String(e.message)));
  w.console.error = (...a) => errors.push(a.map(String).join(" "));
  w.eval(qidianjs);
  w.eval(appjs);
  await settle(120);
  const $ = (id) => w.document.getElementById(id);
  const q = (s) => [...w.document.querySelectorAll(s)];
  return {
    label, w, $, q, errors,
    toast: () => $("toast").textContent,
    status: () => $("cloudStatus").textContent,
    titles: () => q("#libGrid .libcard h2").map(h => h.textContent),
    async lib() { $("libBtn").click(); await settle(40); },
    async sync() { $("cloudSyncNow").click(); await until(() => !$("cloudSyncNow").disabled && !/กำลังซิงก์/.test($("cloudStatus").textContent)); await settle(20); },
    async open(title) {
      await this.lib();
      q("#libGrid .libcard").find(c => c.querySelector("h2").textContent === title).querySelector('[data-act="read"]').click();
      await settle(40);
    },
    async editChar(text) {
      $("editCharBtn").click(); await settle(5);
      $("charDescInput").value = text;
      $("saveCharBtn").click(); await settle(30);
    },
    async saved(id) {
      return new Promise((r) => {
        const req = idb.open("tale-engine", 1);
        req.onsuccess = () => { const g = req.result.transaction("saves").objectStore("saves").get(id); g.onsuccess = () => { r(g.result); req.result.close(); }; };
      });
    },
  };
}

const mk = (id, title, t) => ({ id, title, name: "ตัวเอก", charDesc: "เดิม", world: "โลก", mode: "rpg", lang: "th",
  log: [{ role: "assistant", ep: 1, words: 10, content: "ตอนที่ 1: เริ่ม\n\nฝนตก" }], ctx: [], chapters: [], createdAt: t, updatedAt: t });

console.log("\n═══ Tale Engine — Google Drive backup tests ═══\n");

out.push("[1] Device A connects");
const A = await device("A", [mk("s_x", "เรื่อง X", 2000), mk("s_y", "เรื่อง Y", 1000)]);
check("storage.persist() requested at boot", persistAsked >= 1);
check("not connected by default", /ยังไม่ได้เชื่อมต่อ/.test(A.status()) && A.$("cloudConnect").style.display !== "none");
check("nothing sent before connecting", calls.length === 0, calls.join(","));
A.$("cloudConnect").click();
await until(() => names().length === 2 && !A.$("cloudSyncNow").disabled);
await settle(20);
check("both stories uploaded to appDataFolder", JSON.stringify(names()) === '["story-s_x","story-s_y"]', names().join(","));
check("uploaded gzip, readable back", (await remoteSave("s_x")).title === "เรื่อง X");
check("metadata carries id + updatedAt", storyFile("s_x").appProperties.sid === "s_x" && storyFile("s_x").appProperties.updatedAt === "2000");
check("API key not in the upload", !JSON.stringify(await remoteSave("s_x")).includes('"apiKey"'));
check("status says synced", /ซิงก์กับ Google Drive แล้ว/.test(A.status()), A.status());
check("buttons switch to sync / stop", A.$("cloudConnect").style.display === "none" && A.$("cloudSyncNow").style.display !== "none" && A.$("cloudOff").style.display !== "none");
check("library shows cloud status + sync", /ซิงก์/.test(A.$("libCloudStatus").textContent) && A.$("libCloudSync").style.display !== "none");

out.push("[2] Only changes are uploaded");
calls.length = 0;
await A.sync();
check("no-change sync = list only", calls.length === 1 && calls[0].startsWith("GET"), calls.join(" | "));
await A.open("เรื่อง X");
await A.editChar("แก้จากเครื่อง A");
calls.length = 0;
await A.sync();
check("edited story uploaded (PATCH, no new file)", calls.filter(c => c.startsWith("PATCH")).length === 1 && names().filter(n => n.startsWith("story-")).length === 2, calls.join(" | "));
check("cloud copy has the edit", (await remoteSave("s_x")).charDesc === "แก้จากเครื่อง A");
check("yesterday's version kept as a daily backup (server-side copy)", names().some(n => /^bak-s_x-\d{4}-\d\d-\d\d$/.test(n)) && calls.some(c => c.includes("/copy")), names().join(","));
const bakBefore = names().filter(n => n.startsWith("bak-")).length;
await A.editChar("แก้ครั้งที่สอง");
await A.sync();
check("one backup per day, not per upload", names().filter(n => n.startsWith("bak-")).length === bakBefore);

out.push("[3] Device B (new phone) gets everything");
const B = await device("B", null);
check("fresh device starts at setup", B.$("setup").style.display === "block");
B.$("setupSlotsBtn").click(); await settle(30);
B.$("cloudConnect").click();
await until(async () => (await B.saved("s_x")) && (await B.saved("s_y")));
await settle(40);
check("both stories downloaded", !!(await B.saved("s_x")) && !!(await B.saved("s_y")));
check("latest edit came along", (await B.saved("s_x")).charDesc === "แก้ครั้งที่สอง");
check("updatedAt preserved (no false change)", (await B.saved("s_x")).updatedAt === (await A.saved("s_x")).updatedAt);
check("library refreshed", B.titles().includes("เรื่อง X") && B.titles().includes("เรื่อง Y"), B.titles().join(","));

out.push("[4] Edit on B → shows up on A");
await B.open("เรื่อง Y");
await B.editChar("แก้จากมือถือ B");
await B.sync();
await A.sync();
check("A pulled B's edit", (await A.saved("s_y")).charDesc === "แก้จากมือถือ B");
await A.open("เรื่อง Y");
check("open story on A shows it", A.$("charDescView").textContent.includes("แก้จากมือถือ B"), A.$("charDescView").textContent);

out.push("[5] Both edited before syncing → keep both");
await A.editChar("A แก้ Y");
await sleep(5);
await B.editChar("B แก้ Y ทีหลัง");
await B.sync();
await A.sync();
const aAll = await new Promise(r => { const req = A.w.indexedDB.open("tale-engine", 1); req.onsuccess = () => { const g = req.result.transaction("saves").objectStore("saves").getAll(); g.onsuccess = () => { r(g.result); req.result.close(); }; }; });
const ys = aAll.filter(s => /เรื่อง Y/.test(s.title));
check("A now has two versions of Y", ys.length === 2, ys.map(s => s.title).join(" | "));
check("newer (B's) is the main one", (await A.saved("s_y")).charDesc === "B แก้ Y ทีหลัง");
check("A's own edit kept as a copy", ys.some(s => s.id !== "s_y" && s.charDesc === "A แก้ Y" && /ฉบับในเครื่องนี้/.test(s.title)));
check("the copy is backed up too", names().filter(n => n.startsWith("story-")).length === 3, names().join(","));
check("toast explains", /สองเครื่อง/.test(A.toast()), A.toast());

out.push("[6] Delete follows to other devices");
await A.lib();
A.q("#libGrid .libcard").find(c => c.querySelector("h2").textContent === "เรื่อง X").querySelector('[data-act="del"]').click();
await settle(30);
await A.sync();
check("live copy removed from Drive", !storyFile("s_x"));
check("marker left for other devices", names().includes("del-s_x"));
check("backups of X kept for 🕘", names().some(n => n.startsWith("bak-s_x-")));
await B.lib();
await B.sync();
check("B deleted its untouched copy", !(await B.saved("s_x")));
check("…and did not upload it back", !storyFile("s_x"));

out.push("[7] 🕘 Restore");
await A.lib();
A.$("libRestore").click();
await until(() => A.q("#restoreList .slotcard").length > 0 && !/กำลังโหลด/.test(A.$("restoreList").textContent));
await settle(20);
const rows = A.q("#restoreList .slotcard");
check("local snapshots listed", /สำเนาในเครื่องนี้/.test(A.$("restoreList").textContent) && rows.some(r => /เรื่อง/.test(r.textContent)));
const bakRow = rows.find(r => /สำรองรายวัน/.test(r.textContent) && /เรื่อง X/.test(r.textContent));
check("Drive daily backup of deleted X listed", !!bakRow, rows.map(r => r.textContent).join(" | "));
check("delete markers not listed", !rows.some(r => /del-/.test(r.textContent)));
bakRow.querySelector("button").click();
await until(() => A.$("library").style.display === "block" && A.titles().some(t => /เรื่อง X \(กู้คืน/.test(t)));
check("restored as a NEW story", A.titles().some(t => /เรื่อง X \(กู้คืน/.test(t)), A.titles().join(","));
await A.sync();
check("restored story gets backed up", names().filter(n => n.startsWith("story-")).length === 3, names().join(","));

out.push("[8] Sign-in expiry and errors");
fail401 = true;
await A.sync();
check("401 → asks to sign in again", /เข้าสู่ระบบ/.test(A.status()), A.status());
const tokBefore = tokenN;
await A.sync();
check("tapping sync signs in again and works", tokenN === tokBefore + 1 && /ซิงก์กับ Google Drive แล้ว/.test(A.status()), A.status());
shortToken = true;
A.$("cloudOff").click(); await settle(20);
check("stop → back to connect", /ยังไม่ได้เชื่อมต่อ/.test(A.status()) && A.$("cloudConnect").style.display !== "none");
check("stopping keeps Drive data", names().filter(n => n.startsWith("story-")).length === 3);
A.$("cloudConnect").click(); await settle(80);
await A.open("เรื่อง Y");
await A.editChar("แก้ตอน token หมดอายุ");
calls.length = 0;
const tokHidden = tokenN;
Object.defineProperty(A.w.document, "visibilityState", { value: "hidden", configurable: true });
A.w.document.dispatchEvent(new A.w.Event("visibilitychange"));
await settle(40);
check("expired token → no popup from background sync", calls.length === 0 && tokenN === tokHidden, "calls=" + calls.join(",") + " tokens=" + tokHidden + "→" + tokenN);
check("status asks for a tap", /เข้าสู่ระบบ|แตะ/.test(A.status()), A.status());
shortToken = false;

check("no runtime errors on A", A.errors.filter(e => !/Not implemented/.test(e)).length === 0, A.errors[0]);
check("no runtime errors on B", B.errors.filter(e => !/Not implemented/.test(e)).length === 0, B.errors[0]);

console.log(out.join("\n"));
console.log("\n─────────────────────────────\nผ่าน " + pass + " / ล้มเหลว " + fail + "\n─────────────────────────────\n");
process.exit(fail ? 1 : 0);
