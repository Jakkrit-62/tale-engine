import { JSDOM } from "jsdom";
import fs from "fs";
import path from "path";
import "fake-indexeddb/auto";

// Study mode / language / length options
const DIR = path.resolve(".");
const html = fs.readFileSync(path.join(DIR, "index.html"), "utf8");
const appjs = fs.readFileSync(path.join(DIR, "app.js"), "utf8");

let pass = 0, fail = 0;
const out = [];
function check(name, cond, extra) {
  if (cond) { pass++; out.push("  ✅ " + name); }
  else { fail++; out.push("  ❌ " + name + (extra ? "  → " + extra : "")); }
}

const STATE = '<<STATE>>{"hp":18,"maxHp":20,"level":1,"xp":5,"skills":[],"inventory":["torch"],"location":"Ashford","npcs":[],"flags":[]}';
const STUDY = (words, fix) => "<<STUDY>>" + JSON.stringify({
  vocab: words.map(w => ({ word: w, base: w, pos: "v.", th: "ความหมายของ " + w, ex: "She " + w + " on.", note: "ใช้กับการเดิน" })),
  fix: fix || null,
});

let mock = "study";
let lastBody = null, lastText = "";
let turnNo = 0;
function reply() {
  turnNo++;
  const story = "The rain fell. Kael trudged through the mud, his cloak heavy. The gate loomed ahead.\n\nWhat will you do?";
  if (mock === "study") {
    const words = turnNo === 1 ? ["trudged", "loomed"] : ["cloak", "gate"];
    return story + "\n" + STUDY(words, turnNo > 1 ? { original: "I go to gate", better: "I go to the gate", why: "ต้องมี the" } : null) + "\n" + STATE;
  }
  if (mock === "swapped") return story + "\n" + STATE + "\n" + STUDY(["mud"]);
  if (mock === "badstudy") return story + "\n<<STUDY>>{vocab: broken\n" + STATE;
  if (mock === "thai") return "ฝนตกหนัก คุณเดินฝ่าโคลนไปข้างหน้า ประตูเมืองตั้งตระหง่านอยู่ไกลๆ\n" + STATE;
  if (mock === "xss") return story + "\n" + "<<STUDY>>" + JSON.stringify({ vocab: [{ word: "rain", th: "<img src=x onerror=window.__p=1>", pos: "n." }], fix: null }) + "\n" + STATE;
  return story + "\n" + STATE;
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
let lastDownload = null;
win.URL.createObjectURL = (b) => { lastDownload = b; return "blob:mock"; };
win.URL.revokeObjectURL = () => { };
win.confirm = () => true;
win.navigator.clipboard = { writeText: async (t) => { lastText = t; } };
Object.defineProperty(win.navigator, "serviceWorker", { value: { register: async () => ({}) }, configurable: true });
win.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  const sys = body.systemInstruction?.parts?.[0]?.text || "";
  let text;
  if (sys.includes("ผู้ช่วยสรุปเนื้อเรื่อง")) text = "summary";
  else { lastBody = body; text = reply(); }
  const sse = "data: " + JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] }) + "\n\n";
  return { ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }) };
};
// fake speech engine: utterances wait until the test ends them
const spoken = [];
let canceled = 0;
win.SpeechSynthesisUtterance = function (text) { this.text = text; };
win.speechSynthesis = {
  getVoices: () => [{ name: "Google US English", lang: "en-US" }, { name: "Google ไทย", lang: "th-TH" }],
  speak: (u) => spoken.push(u),
  cancel: () => { canceled++; },
};
const endCurrent = () => { const u = spoken[spoken.length - 1]; if (u && u.onend) u.onend(); };

const errors = [];
win.addEventListener("error", (e) => errors.push(String(e.message)));
console.error = (...a) => errors.push(a.map(String).join(" "));
win.eval(appjs);

const $ = (id) => win.document.getElementById(id);
const q = (s) => win.document.querySelectorAll(s);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function settle(n = 60) { for (let i = 0; i < n; i++) await sleep(4); }
const sysText = () => lastBody.systemInstruction.parts[0].text;
const allText = () => JSON.stringify(lastBody.contents);
async function play(t) { $("actionInput").value = t; $("sendBtn").click(); await settle(50); }

console.log("\n═══ Tale Engine — study mode tests ═══\n");
await settle(150);
$("apiKeyInput").value = "K"; $("saveKeyBtn").click(); await settle(20);

out.push("[1] Setup options");
check("study options hidden while Thai is selected", $("studyField").style.display === "none");
win.document.querySelector('[data-seg="lang"] button[data-v="en"]').click();
check("study options shown for English", $("studyField").style.display === "block");
win.document.querySelector('[data-seg="length"] button[data-v="long"]').click();
win.document.querySelector('[data-seg="pov"] button[data-v="third"]').click();
check("only one length button active", q('[data-seg="length"] button.active').length === 1);
$("setupCefr").value = "B2";
$("setupName").value = "Kael";
$("startBtn").click();
await settle(60);

out.push("[2] Prompt");
check("English rule in prompt", sysText().includes("ภาษาอังกฤษเสมอ"));
check("CEFR level in prompt", sysText().includes("B2 (upper-intermediate)"));
check("long length rule in prompt", sysText().includes("700-1000"));
check("third-person rule uses name", sysText().includes('เรียกตัวเอกด้วยชื่อ "Kael"'));
check("study format in prompt", sysText().includes("<<STUDY>>"));
check("input placeholder switches to English", $("actionInput").placeholder.startsWith("Type your action"));

out.push("[3] Opening turn with study card");
const ai = () => q("#log .msg.ai");
check("narrative rendered", ai().length === 1);
check("STUDY/STATE markers hidden from story", !ai()[0].textContent.includes("<<"));
check("vocab card rendered", q("#log .msg.study").length === 1);
check("card lists 2 words", q("#log .msg.study .vitem").length === 2);
check("words highlighted in story", ai()[0].querySelectorAll("mark.vw").length === 2);
check("highlight keeps original casing/text", ai()[0].textContent.includes("Kael trudged through"));
check("drawer shows notebook count", $("vocabBtn").textContent.includes("2 คำ"), $("vocabBtn").textContent);
check("state patch still applied", $("headerHp").textContent.includes("18/20"));

out.push("[4] Next turn: known words + grammar fix");
await play("I go to gate");
check("known words sent to model", allText().includes("trudged, loomed"));
check("grammar fix shown", q("#log .vfix").length === 1 && q("#log .vnew")[0].textContent.includes("the gate"));
check("notebook grows to 4", $("vocabBtn").textContent.includes("4 คำ"), $("vocabBtn").textContent);

out.push("[5] Tap highlighted word");
ai()[1].querySelector("mark.vw").click();
await settle(3);
check("toast shows Thai meaning", $("toast").textContent.includes("ความหมายของ"), $("toast").textContent);

out.push("[6] Undo removes that turn's words");
$("undoBtn").click();
await settle(40);
check("notebook back to 2", $("vocabBtn").textContent.includes("2 คำ"), $("vocabBtn").textContent);
check("card re-rendered after renderAll", q("#log .msg.study").length === 1);
check("highlights re-rendered after renderAll", q("#log mark.vw").length === 2);

out.push("[7] Robust parsing");
mock = "swapped"; await play("look");
check("STATE-before-STUDY still parsed", q("#log .msg.study").length === 2 && !ai()[1].textContent.includes("<<"));
mock = "badstudy"; await play("look again");
check("broken STUDY JSON: turn still accepted", ai().length === 3 && !ai()[2].textContent.includes("<<"));
check("broken STUDY JSON: no card", q("#log .msg.study").length === 2);
mock = "xss"; await play("rain");
check("vocab text is escaped", !win.__p && !win.document.querySelector("#log .msg.study img"));

out.push("[8] Notebook modal + export");
$("vocabBtn").click(); await settle(5);
check("notebook lists words", q("#vocabList .vitem").length === 4, String(q("#vocabList .vitem").length));
$("vocabSearch").value = "trudged"; $("vocabSearch").oninput(); await settle(2);
check("search filters", q("#vocabList .vitem").length === 1);
$("vocabSearch").value = ""; $("vocabSearch").oninput();
$("vocabCsv").click(); await settle(5);
const csv = lastDownload ? await lastDownload.text() : "";
check("CSV has header + rows", csv.includes("meaning_th") && csv.includes("trudged"));
q("#vocabList .vdel")[0].click(); await settle(20);
check("delete word from notebook", q("#vocabList .vitem").length === 3);
$("vocabModal").querySelector("[data-close]").click();
$("expCopy").click(); await settle(5);
check("markdown export includes vocabulary", lastText.includes("📚 Vocabulary") && lastText.includes("**trudged**"));

out.push("[9] Toggle study off mid-game");
mock = "plain";
$("studyToggle").checked = false; $("studyToggle").onchange(); await settle(20);
await play("walk");
check("no STUDY rules when off", !sysText().includes("<<STUDY>>"));
check("no known-words list when off", !allText().includes("คำศัพท์ที่ผู้เล่นเรียนแล้ว"));
check("no new card when off", q("#log .msg.study").length === 3);
$("langSelect").value = "th"; $("langSelect").onchange(); await settle(20);
check("study options hidden for Thai", $("studyOpts").style.display === "none");
mock = "thai"; await play("เดิน");
check("Thai rule in prompt", sysText().includes("ภาษาไทยเสมอ"));

out.push("[10] Read aloud");
const tools = () => q("#log .msgtools button");
check("one 🔊 button per story bubble", tools().length === ai().length, tools().length + " vs " + ai().length);
const enIdx = 0;
spoken.length = 0;
tools()[enIdx].click();
check("starts speaking", spoken.length === 1);
check("English story uses en-US voice", spoken[0].lang === "en-US" && spoken[0].voice.name === "Google US English");
check("default rate 0.85", spoken[0].rate === 0.85);
check("button shows stop + progress", tools()[enIdx].textContent.startsWith("⏹"), tools()[enIdx].textContent);
check("bubble highlighted while reading", ai()[enIdx].classList.contains("reading"));
check("chunk is plain text (no marks/markers)", !/<|>>/.test(spoken[0].text), spoken[0].text);
let guard = 0;
while (tools()[enIdx].textContent.startsWith("⏹") && guard++ < 50) endCurrent();
check("reads all chunks then resets", tools()[enIdx].textContent === "🔊 ฟังตอนนี้" && !ai()[enIdx].classList.contains("reading"));
check("whole story was spoken", spoken.map(u => u.text).join(" ").includes("What will you do?"));
tools()[enIdx].click();
const n = spoken.length;
tools()[enIdx].click();
check("second tap stops", tools()[enIdx].textContent === "🔊 ฟังตอนนี้");
endCurrent();
check("no more chunks after stop", spoken.length === n);
const last = tools().length - 1;
tools()[last].click();
check("Thai story uses th-TH", spoken[spoken.length - 1].lang === "th-TH");
tools()[enIdx].click();
check("starting another bubble stops the first", !ai()[last].classList.contains("reading") && ai()[enIdx].classList.contains("reading"));
$("undoBtn").click(); await settle(40);
check("re-render stops reading", !q("#log .msg.ai.reading").length);
$("ttsRateSelect").value = "0.7"; await $("ttsRateSelect").onchange();
tools()[0].click();
check("rate setting applied", spoken[spoken.length - 1].rate === 0.7);
tools()[0].click();

check("no runtime errors", errors.filter(e => !/STUDY JSON|Not implemented: navigation/.test(e)).length === 0, errors[0]);

console.log(out.join("\n"));
console.log("\n─────────────────────────────\nผ่าน " + pass + " / ล้มเหลว " + fail + "\n─────────────────────────────\n");
process.exit(fail ? 1 : 0);
