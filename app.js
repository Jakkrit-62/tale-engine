/* Tale Engine — standalone solo AI text-adventure (Gemini + IndexedDB PWA)
 * No Claude runtime dependency. All data stays on this device.
 */
(function () {
  "use strict";

  // ============================================================
  // Constants
  // ============================================================
  const DB_NAME = "tale-engine";
  const DB_VER = 1;
  const STORE_SAVES = "saves";
  const STORE_SETTINGS = "settings";

  const CTX_KEEP = 16;          // raw messages always kept in context
  const CTX_TRIGGER = 24;       // compress when ctx exceeds this
  const CHAPTER_COMPRESS_AT = 10;
  const CHAPTER_MERGE_COUNT = 5;

  // Hard safety budget for the prompt we send (chars, not tokens).
  // Gemini 2.5 Flash has a huge window; this is a sanity ceiling so a
  // runaway state can never lock the game (BUG #2 fix).
  const PROMPT_CHAR_BUDGET = 400000;

  const DEFAULT_MODEL = "gemini-3.1-flash-lite";;
  // Fallback only — the real list is fetched from the API key itself
  // (ListModels), because which models a key can call varies per account.
  // Model ids from ai.google.dev/gemini-api/docs/models. Free tier is
  // Flash-only; Pro models need billing and answer 429 "limit: 0" without it.
  const MODELS = [
    { id: "gemini-flash-latest", label: "Gemini Flash (ล่าสุดเสมอ — แนะนำ)" },
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
    { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite (เร็ว/โควตาฟรีเยอะ)" },
    { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite (เร็ว/โควตาฟรีเยอะ)" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro (ต้องผูกบัตร — key ฟรีใช้ไม่ได้)" },
  ];
  // Each model has its own free quota (per project). When one is exhausted
  // or missing, the call moves on to the next — so one tap keeps working.
  const FALLBACK_MODELS = ["gemini-flash-latest", "gemini-3.1-flash-lite", "gemini-2.5-flash-lite"];
  // Background work (memory summaries) runs on a Lite model so it does not
  // eat the main model's small per-minute quota right after every turn.
  const SUMMARY_MODEL = "gemini-3.1-flash-lite";
  const API_BASE = "https://generativelanguage.googleapis.com/v1beta/";

  // ============================================================
  // Small helpers
  // ============================================================
  const $ = (id) => document.getElementById(id);
  const esc = (s) => (s == null ? "" : String(s))
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const now = () => Date.now();
  const uid = () => "s_" + Math.random().toString(36).slice(2, 10) + now().toString(36);
  const bytes = (s) => new Blob([s]).size;
  const fmtBytes = (n) => n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(2) + " MB";
  const fmtDate = (t) => new Date(t).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" });
  const linesToArr = (s) => String(s || "").split("\n").map(x => x.trim()).filter(Boolean);

  function toast(msg, ms) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), ms || 2600);
  }

  // ============================================================
  // IndexedDB layer (replaces the 256 KiB-capped Claude db — BUG #1 fix)
  // ============================================================
  let idb = null;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains(STORE_SAVES)) {
          d.createObjectStore(STORE_SAVES, { keyPath: "id" });
        }
        if (!d.objectStoreNames.contains(STORE_SETTINGS)) {
          d.createObjectStore(STORE_SETTINGS, { keyPath: "k" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("เปิดฐานข้อมูลไม่สำเร็จ"));
    });
  }

  function tx(store, mode) {
    return idb.transaction(store, mode).objectStore(store);
  }
  function wrap(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  const dbGet = (store, key) => wrap(tx(store, "readonly").get(key));
  const dbPut = (store, val) => wrap(tx(store, "readwrite").put(val));
  const dbDel = (store, key) => wrap(tx(store, "readwrite").delete(key));
  const dbAll = (store) => wrap(tx(store, "readonly").getAll());

  async function getSetting(k, fallback) {
    try { const r = await dbGet(STORE_SETTINGS, k); return r ? r.v : fallback; }
    catch (e) { return fallback; }
  }
  const setSetting = (k, v) => dbPut(STORE_SETTINGS, { k, v });

  // ============================================================
  // Persistence with serialized writes (BUG: concurrent writes fix)
  // ============================================================
  let saveChain = Promise.resolve();
  let saveTimer = null;

  function persist(immediate) {
    if (!state) return Promise.resolve();
    state.updatedAt = now();
    const doWrite = () => {
      saveChain = saveChain.then(async () => {
        try {
          await dbPut(STORE_SAVES, JSON.parse(JSON.stringify(state)));
          await setSetting("lastSave", state.id);
          setSaveStatus("ok");
        } catch (e) {
          console.error("บันทึกไม่สำเร็จ:", e);
          setSaveStatus("fail", e && e.name === "QuotaExceededError"
            ? "พื้นที่เก็บข้อมูลเต็ม"
            : "บันทึกไม่สำเร็จ");
        }
      });
      return saveChain;
    };
    if (immediate) { clearTimeout(saveTimer); return doWrite(); }
    clearTimeout(saveTimer);
    return new Promise((r) => { saveTimer = setTimeout(() => doWrite().then(r), 350); });
  }

  function setSaveStatus(kind, msg) {
    const el = $("saveDot");
    if (!el) return;
    if (kind === "ok") { el.className = "savedot ok"; el.title = "บันทึกแล้ว"; }
    else { el.className = "savedot fail"; el.title = msg || "บันทึกไม่สำเร็จ"; toast("⚠️ " + (msg || "บันทึกไม่สำเร็จ")); }
  }

  // ============================================================
  // Gemini API
  // ============================================================
  let settings = { apiKey: "", model: DEFAULT_MODEL, ttsRate: 0.85, ttsPitch: 1, ttsFollow: true };

  function mapTurns(turns) {
    // Gemini wants role "user" | "model"; merge consecutive same-role turns.
    const out = [];
    for (const t of turns) {
      const role = t.role === "assistant" ? "model" : "user";
      const text = String(t.content || "").trim();
      if (!text) continue; // never send empty parts (BUG #3 hardening)
      const last = out[out.length - 1];
      if (last && last.role === role) last.parts[0].text += "\n\n" + text;
      else out.push({ role, parts: [{ text }] });
    }
    return out;
  }

  function apiErr(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  function waitFor(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(apiErr("aborted", "ยกเลิกแล้ว"));
      const t = setTimeout(resolve, ms);
      if (signal) signal.addEventListener("abort", () => {
        clearTimeout(t); reject(apiErr("aborted", "ยกเลิกแล้ว"));
      }, { once: true });
    });
  }

  async function readApiError(res) {
    const info = { message: "", status: "", retryAfter: 0, perDay: false, zeroQuota: false };
    let j = null;
    try { j = await res.json(); } catch (e) { }
    const err = (j && j.error) || {};
    info.message = String(err.message || "");
    info.status = String(err.status || "");
    for (const d of (Array.isArray(err.details) ? err.details : [])) {
      const type = String((d && d["@type"]) || "");
      if (/RetryInfo$/.test(type) && d.retryDelay) {
        info.retryAfter = Math.ceil(parseFloat(d.retryDelay) || 0);
      }
      if (/QuotaFailure$/.test(type) && Array.isArray(d.violations)) {
        for (const v of d.violations) {
          if (/PerDay/i.test(String(v.quotaId || v.quotaMetric || ""))) info.perDay = true;
        }
      }
    }
    if (!info.retryAfter) {
      const m = info.message.match(/retry in ([\d.]+)\s*s/i);
      if (m) info.retryAfter = Math.ceil(parseFloat(m[1]));
    }
    if (/limit:\s*0(?![\d.])/.test(info.message)) info.zeroQuota = true;
    return info;
  }

  function httpErr(status, info, model) {
    const detail = info.message;
    let e;
    if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(detail)) e = apiErr("bad_key", "API key ไม่ถูกต้อง");
    else if (status === 400) e = apiErr("bad_request", detail || "คำขอไม่ถูกต้อง");
    else if (status === 403) e = apiErr("forbidden", "API key ไม่มีสิทธิ์เรียกโมเดล " + model + (detail ? " (" + detail + ")" : ""));
    else if (status === 404) e = apiErr("no_model", "ไม่พบโมเดล \"" + model + "\" สำหรับ key นี้ — เปิดตั้งค่าแล้วกด 🔄 โหลดรายชื่อโมเดล");
    else if (status === 429 && info.zeroQuota) e = apiErr("no_quota",
      "โมเดล " + model + " ไม่มีโควตาฟรีสำหรับ key นี้ — เปลี่ยนเป็นรุ่น Flash หรือ Flash-Lite ในตั้งค่า");
    else if (status === 429 && info.perDay) e = apiErr("no_quota",
      "โควตารายวันของโมเดล " + model + " หมดแล้ว (รีเซ็ตราว 14:00-15:00 น. เวลาไทย) — เปลี่ยนโมเดลในตั้งค่าเพื่อเล่นต่อ");
    else if (status === 429) {
      e = apiErr("rate_limited", "เรียกถี่เกินโควตาต่อนาทีของโมเดลนี้ — " +
        (info.retryAfter ? "รอ " + info.retryAfter + " วินาทีแล้วกดลองใหม่" : "รอสักครู่แล้วกดลองใหม่") +
        " (ถ้าเป็นบ่อย ให้เปลี่ยนเป็นรุ่น Flash-Lite)");
      e.transient = true;
    }
    else if (status === 503) { e = apiErr("server", "เซิร์ฟเวอร์ Gemini มีคนใช้เยอะ ลองใหม่อีกครั้ง"); e.transient = true; }
    else if (status >= 500) e = apiErr("server", "เซิร์ฟเวอร์ Gemini ขัดข้อง ลองใหม่อีกครั้ง");
    else e = apiErr("http_" + status, detail || ("HTTP " + status));
    e.retryAfter = info.retryAfter;
    return e;
  }

  // Ask Google which models this key can actually call.
  async function listModels(apiKey) {
    let res;
    try {
      res = await fetch(API_BASE + "models?pageSize=1000", { headers: { "x-goog-api-key": apiKey } });
    } catch (e) {
      throw apiErr("network", "เชื่อมต่อไม่ได้ — ตรวจสอบอินเทอร์เน็ต");
    }
    if (!res.ok) throw httpErr(res.status, await readApiError(res), "");
    const j = await res.json();
    const skip = /embed|tts|image|audio|live|aqa|imagen|veo|robotics|computer-use|learnlm|gemma|native|dialog|thinking-exp/i;
    const out = [];
    for (const m of (j.models || [])) {
      const id = String(m.name || "").replace(/^models\//, "");
      const methods = m.supportedGenerationMethods || [];
      if (!/^gemini/i.test(id) || skip.test(id)) continue;
      if (methods.length && methods.indexOf("generateContent") < 0) continue;
      out.push({ id, label: (m.displayName || id) + " — " + id });
    }
    // Flash first (best free quota), then others; stable aliases on top.
    const rank = (id) => (/flash-lite/.test(id) ? 1 : /flash/.test(id) ? 0 : 2) * 10 + (/latest$/.test(id) ? 0 : 1);
    out.sort((a, b) => rank(a.id) - rank(b.id) || b.id.localeCompare(a.id));
    return out;
  }

  // Gemini 3 wants thinkingLevel, 2.5 wants thinkingBudget. Thinking tokens
  // count against maxOutputTokens, and a story turn gains little from deep
  // reasoning, so keep it low: faster replies, fewer "truncated" failures.
  function thinkingFor(model) {
    if (/^gemini-2\.5-flash/.test(model)) return { thinkingBudget: 0 };
    if (/^gemini-(3|flash-latest|flash-lite-latest)/.test(model)) return { thinkingLevel: "low" };
    return null;
  }

  // Errors that mean "this model can't serve you right now" — another
  // model with its own quota may still work.
  const SWITCHABLE = { no_model: 1, no_quota: 1, rate_limited: 1 };

  async function gemini({ system, turns, onText, onStatus, temperature, maxTokens, signal, model, noFallback, quiet }) {
    if (!settings.apiKey) throw apiErr("no_key", "ยังไม่ได้ตั้งค่า API key");

    const contents = mapTurns(turns);
    if (!contents.length) throw apiErr("empty_prompt", "ไม่มีเนื้อหาจะส่ง");
    if (contents[contents.length - 1].role !== "user") {
      contents.push({ role: "user", parts: [{ text: "(ดำเนินเรื่องต่อ)" }] });
    }

    const body = {
      contents,
      generationConfig: {
        temperature: temperature == null ? 0.9 : temperature,
        maxOutputTokens: maxTokens || 8192,
      },
      safetySettings: [
        "HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH",
        "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT",
      ].map((category) => ({ category, threshold: "BLOCK_ONLY_HIGH" })),
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };

    const wanted = model || settings.model || DEFAULT_MODEL;
    const chain = [wanted];
    if (!noFallback) {
      for (const m of FALLBACK_MODELS.concat(settings.model || DEFAULT_MODEL)) {
        if (chain.indexOf(m) < 0) chain.push(m);
      }
    }

    async function post(m) {
      const think = thinkingFor(m);
      const b = Object.assign({}, body, { generationConfig: Object.assign({}, body.generationConfig) });
      if (think) b.generationConfig.thinkingConfig = think;
      for (let attempt = 0; ; attempt++) {
        let r;
        try {
          r = await fetch(API_BASE + "models/" + encodeURIComponent(m) + ":streamGenerateContent?alt=sse", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": settings.apiKey },
            body: JSON.stringify(b),
            signal,
          });
        } catch (e) {
          if (e && e.name === "AbortError") throw apiErr("aborted", "ยกเลิกแล้ว");
          throw apiErr("network", "เชื่อมต่อไม่ได้ — ตรวจสอบอินเทอร์เน็ต");
        }
        if (r.ok) return r;
        const info = await readApiError(r);
        // A model that rejects the thinking setting: send it without one.
        if (r.status === 400 && b.generationConfig.thinkingConfig && /thinking/i.test(info.message)) {
          delete b.generationConfig.thinkingConfig;
          continue;
        }
        const err = httpErr(r.status, info, m);
        if (r.status === 503 && attempt < 1) {
          if (onStatus) onStatus(4, attempt + 1);
          await waitFor(4000, signal);
          continue;
        }
        throw err;
      }
    }

    let res, used, firstErr = null, allRateLimited = true;
    for (const m of chain) {
      try { res = await post(m); used = m; break; }
      catch (e) {
        if (!SWITCHABLE[e.code]) throw e;
        if (!firstErr) firstErr = e;
        if (e.code !== "rate_limited") allRateLimited = false;
      }
    }
    // Every model is only briefly over its per-minute limit: wait the time
    // Google asks for, then try the first model once more.
    if (!res && allRateLimited && firstErr.retryAfter && firstErr.retryAfter <= 60) {
      if (onStatus) onStatus(firstErr.retryAfter, 1);
      await waitFor(firstErr.retryAfter * 1000, signal);
      res = await post(wanted); used = wanted;
    }
    if (!res) throw firstErr;
    if (used !== wanted && !quiet) toast("⚠️ " + wanted + " ใช้ไม่ได้ตอนนี้ — สลับไปใช้ " + used + " ให้แทน", 4000);

    // SSE stream
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", full = "", blockReason = null, finishReason = null;

    while (true) {
      let chunk;
      try { chunk = await reader.read(); }
      catch (e) {
        if (e && e.name === "AbortError") throw apiErr("aborted", "ยกเลิกแล้ว");
        throw apiErr("network", "การเชื่อมต่อหลุดระหว่างรับข้อมูล");
      }
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });

      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith("data:")) continue;
        const payload = s.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let j;
        try { j = JSON.parse(payload); } catch (e) { continue; }
        if (j.promptFeedback && j.promptFeedback.blockReason) blockReason = j.promptFeedback.blockReason;
        const cand = j.candidates && j.candidates[0];
        if (!cand) continue;
        if (cand.finishReason) finishReason = cand.finishReason;
        const parts = (cand.content && cand.content.parts) || [];
        for (const p of parts) {
          if (typeof p.text === "string" && p.text) {
            full += p.text;
            if (onText) onText(full);
          }
        }
      }
    }

    if (!full.trim()) {
      if (blockReason || finishReason === "SAFETY") throw apiErr("blocked", "เนื้อหาถูกบล็อกโดยตัวกรองความปลอดภัย ลองเปลี่ยนคำสั่ง");
      if (finishReason === "MAX_TOKENS") throw apiErr("truncated", "AI ใช้ token หมดก่อนตอบ (โมเดลคิดนานเกิน) — ลองใหม่ หรือเปลี่ยนเป็นรุ่น Flash");
      throw apiErr("empty", "AI ไม่ได้ตอบอะไรกลับมา ลองใหม่อีกครั้ง");
    }
    return { text: full, finishReason };
  }

  // ============================================================
  // Game state
  // ============================================================
  let state = null;
  let busy = false;
  let currentAbort = null;

  function defaultState(base) {
    return Object.assign({
      id: uid(),
      title: "",
      name: "นักผจญภัยไร้นาม",
      charDesc: "", world: "", mode: "rpg",
      // Story language/length. Older saves get "auto"/"short", which is
      // exactly how the game behaved before these options existed.
      lang: "auto", length: "short", pov: "second",
      study: false, cefr: "B1", vocab: [],
      // Novel craft knobs. Older saves default to "on" — this is the
      // behaviour the player asked for and it never breaks an old story.
      fx: true, showStatus: true, autoPlay: false,
      // โหมด Qidian: บังคับจังหวะเว็บโนเวลจีน (กฎอยู่ใน qidian-mode/qidian.js)
      // ปิดไว้เป็นค่าเริ่มต้น เซฟเก่าจึงเล่นต่อได้เหมือนเดิมทุกประการ
      qidian: false, qidianNotes: [],
      hp: 20, maxHp: 20, level: 1, xp: 0,
      skills: [], inventory: [],
      location: "", npcs: [], flags: [],
      // Progression / living-world tracking. Every one of these is optional
      // for the model to fill; empty means "the story hasn't used it yet".
      realm: "", realmProgress: 0, worldTime: "",
      titles: [], resources: [], quests: [], factions: [], rivals: [],
      worldEvents: [],
      chapters: [],
      ctx: [],
      log: [],
      createdAt: now(), updatedAt: now(),
    }, base || {});
  }

  // ============================================================
  // Prompt building
  // ============================================================
  const MODE_RULES = {
    rpg: "โหมด RPG: เน้นระบบสกิล ไอเทม และการเติบโตของตัวละคร การกระทำที่สมเหตุสมผลมีโอกาสได้สกิลใหม่ ไอเทมใหม่ หรือ XP เพิ่ม",
    story: "โหมด Story: เน้นเนื้อเรื่องและอารมณ์ความรู้สึกเป็นหลัก ลดความซับซ้อนเชิงกลไก (สกิล/ไอเทม) ใช้เท่าที่จำเป็นต่อเนื้อเรื่อง",
    dnd: "โหมด D&D: ระบบจะทอย d20 ให้อัตโนมัติและส่งมาในรูปแบบ [Dice: d20=X] ให้ตีความว่า 1=ล้มเหลวหายนะ, 2-5=ล้มเหลว/มีผลเสีย, 6-10=สำเร็จแบบมีราคาต้องจ่าย, 11-15=สำเร็จตามปกติ, 16-19=สำเร็จดีเยี่ยม, 20=สำเร็จเกินคาด และอ้างถึงผลทอยในเนื้อเรื่องอย่างเป็นธรรมชาติ",
    cultivation: "โหมดบ่มเพาะ (เซียน/ศิลปะการต่อสู้): ตัวเอกไต่ระดับ \"ฐานบ่มเพาะ\" เป็นขั้นๆ อย่างมีระบบ " +
      "ทุกตอนต้องมีความคืบหน้าหรืออุปสรรคของการบ่มเพาะที่จับต้องได้ (ปริมาณพลัง ความบริสุทธิ์ของจิต อุปสรรคก่อนทะลวงขั้น) " +
      "ให้โลกมีลำดับชั้นชัดเจน: สำนัก ตระกูล ผู้อาวุโส ศัตรูคู่แค้น และอัจฉริยะรุ่นเดียวกันที่ไต่ขั้นแข่งกับตัวเอก " +
      "ทรัพยากร (หินวิญญาณ ยาบำรุง ตำราวิชา) มีจำกัดและต้องแลกมาด้วยอะไรบางอย่างเสมอ " +
      "เวลาทะลวงขั้น ให้บรรยายเป็นฉากใหญ่ มีนิมิต ความเจ็บปวด และผลกระทบที่คนรอบข้างสังเกตเห็น",
  };
  const MODE_LABELS = { rpg: "RPG", story: "Story", dnd: "D&D", cultivation: "บ่มเพาะ" };

  const LENGTH_RULES = {
    short: "ครั้งละ 3-5 ย่อหน้า (ราว 200-300 คำ) กระชับแต่ยังมีบทสนทนาอย่างน้อย 1 ช่วง",
    medium: "ครั้งละ 5-7 ย่อหน้า (ราว 400-550 คำ) มีทั้งการบรรยายฉาก บทสนทนาโต้ตอบ และความคิดภายในของตัวละคร",
    long: "ครั้งละ 8-12 ย่อหน้า (ราว 800-1100 คำ) เขียนแบบนิยายเต็มรูปแบบ: บรรยายฉากผ่านประสาทสัมผัส บทสนทนายาวหลายรอบ " +
      "ความคิดภายในของตัวละคร และจังหวะที่ค่อยๆ ไต่ระดับความตึงเครียด ห้ามรีบสรุปเหตุการณ์",
  };
  const LENGTH_LABELS = { short: "สั้น", medium: "กลาง", long: "ยาว (นิยาย)" };

  // The heart of "ให้มันเป็นนิยายจริงๆ": concrete craft rules, not vibes.
  function craftRules() {
    const r = [
      "",
      "วิธีเขียนให้เป็นนิยายจริง (สำคัญ — ห้ามข้าม):",
      "- ห้ามเขียนเป็น \"รายงานสรุปเหตุการณ์\" ให้เขียนเป็นฉาก: มีสถานที่ เวลา แสง เสียง กลิ่น สัมผัส อุณหภูมิ อย่างน้อย 2 ประสาทสัมผัสต่อฉาก",
      "- ทุกตอนที่มีคนอื่นอยู่ในฉาก ต้องมีบทสนทนาจริงอย่างน้อย 2-4 รอบโต้ตอบ เขียนคำพูดในเครื่องหมายคำพูด ขึ้นบรรทัดใหม่เมื่อเปลี่ยนผู้พูด",
      "  ตัวอย่างรูปแบบ:\n    \"เจ้าจะไปไหน\" เสียงนั้นเย็นจนขนลุก\n    ตัวเอกไม่หันกลับ \"ที่ที่เจ้าตามไม่ทัน\"",
      "- ให้ตัวละครแต่ละตัวมีน้ำเสียงเฉพาะตัว (คำติดปาก จังหวะการพูด ระดับความสุภาพ) คนละแบบกันชัดเจน ห้ามพูดเหมือนกันหมด",
      "- แสดงอารมณ์ด้วยการกระทำและร่างกาย (มือสั่น กรามขบแน่น ลมหายใจสะดุด) มากกว่าบอกตรงๆ ว่า \"เขารู้สึกกลัว\"",
      "- สลับความยาวประโยค ประโยคสั้นๆ ใช้ตอนกระแทกอารมณ์",
      "- ใส่ความคิดภายในของตัวเอกอย่างน้อย 1 ช่วงต่อตอน",
      "- ปิดตอนด้วยจังหวะที่ค้างคา (ประโยคเด็ด คำถาม เงาที่เพิ่งขยับ) ไม่ใช่ถามผู้เล่นตรงๆ ว่า \"คุณจะทำอะไรต่อ\"",
    ];
    if (!state || state.fx !== false) {
      r.push(
        "",
        "ฉากต่อสู้/ฉากบู้ (เมื่อมีการปะทะ):",
        "- แตกเป็นจังหวะสั้นๆ ทีละหมัด ทีละดาบ ห้ามสรุปรวบว่า \"ต่อสู้กันอย่างดุเดือดแล้วชนะ\"",
        "- ใส่เอฟเฟคเสียงและแรงปะทะเป็นบรรทัดของตัวเอง เขียนตัวใหญ่/เน้นได้ เช่น\n    ปัง!\n    เสียงเหล็กกระทบเหล็กดังก้องทั้งลาน",
        "- ทุกการโจมตีต้องมีราคา: เสียเลือด เสียท่า เสียพลัง หรือเสียตำแหน่งยืน",
        "- ระบุผลกระทบต่อสิ่งแวดล้อม (พื้นแตก ฝุ่นฟุ้ง กิ่งไม้หัก) เพื่อให้เห็นระดับพลังจริง",
        "- จบฉากบู้ด้วยสภาพร่างกายของตัวเอกอย่างชัดเจน แล้วอัปเดต HP ให้ตรงกับที่บรรยาย"
      );
    }
    r.push(
      "",
      "โลกที่ยังหายใจอยู่ (สำคัญ — ผู้เล่นไม่ควรต้องถามเอง):",
      "- ทุกตอนต้องมีสัญญาณอย่างน้อย 1 อย่างว่าคนอื่นและโลกกำลังเคลื่อนไหวอยู่ แม้ตัวเอกไม่อยู่ตรงนั้น " +
      "(ข่าวลือในโรงเตี๊ยม ป้ายประกาศ นกสื่อสาร คนเดินผ่านคุยกัน ศัตรูที่ไต่ขั้นไปแล้ว สงครามที่ขยับ)",
      "- คู่แข่ง/ศัตรู/พันธมิตร ต้องเติบโตและลงมือทำอะไรของตัวเองระหว่างที่ตัวเอกไม่อยู่ ไม่ใช่รออยู่เฉยๆ",
      "- เมื่อสถานะของตัวเอกเปลี่ยน (เลเวล ฐานบ่มเพาะ ไอเทมสำคัญ บาดแผล) ต้องบรรยายให้เห็นในเนื้อเรื่องด้วย ไม่ใช่เปลี่ยนแค่ใน JSON",
      "- เวลาในโลกต้องเดิน ระบุช่วงเวลา/วัน/ฤดู ใน worldTime และอ้างถึงในเนื้อเรื่องเป็นระยะ"
    );
    if (state && state.autoPlay) {
      r.push(
        "",
        "โหมด Auto Play (Hardcore) — เปิดอยู่:",
        "- เน้นความท้าทายระดับสูงสุด ศัตรูต้องฉลาด มีการวางแผนและตลบหลัง",
        "- สถานการณ์ต้องบีบให้แก้ปัญหาเฉพาะหน้า (เช่น พิษ, กับดัก, เวลาจำกัด)",
        "- ตัวเอกต้องค่อยๆ เก่งขึ้นอย่างสมเหตุสมผล ห้ามได้พลังก้าวกระโดดแบบง่ายๆ",
        "- ชัยชนะทุกครั้งต้องมีราคา และความผิดพลาดต้องมีผลตามมาจริงในตอนถัดไป",
        "",
        "การจบตอนในโหมดออโต้ (แทนที่กฎการจบตอนด้านบน):",
        "- ห้ามจบด้วยคำถามปลายเปิดแบบ \"คุณจะทำอะไรต่อ\" และห้ามถามผู้เล่นทุกกรณี",
        "- ให้คุณเป็นคนตัดสินใจเนื้อเรื่องต่อเอง เพื่อให้เนื้อเรื่องไหลลื่นและสมเหตุสมผล " +
        "อย่างกับนักเขียนนิยายมืออาชีพของจีน",
        "- ปิดตอนด้วยจังหวะคลิฟแฮงเกอร์ที่พาเข้าสู่ฉากถัดไปโดยตรง"
      );
    }
    return r;
  }

  const CEFR_RULES = {
    A2: "A2 (elementary): short, simple sentences; common everyday words; mostly past simple; avoid idioms",
    B1: "B1 (intermediate): clear, natural sentences; everyday vocabulary plus some descriptive words; few idioms",
    B2: "B2 (upper-intermediate): natural novel prose with varied sentence structure, phrasal verbs and some idioms",
    C1: "C1 (advanced): rich literary prose, wide vocabulary, idioms and figurative language",
  };
  const CEFR_LABELS = { A2: "A2 พื้นฐาน", B1: "B1 กลาง", B2: "B2 กลาง-สูง", C1: "C1 สูง" };
  const LANG_LABELS = { auto: "ตามภาษาที่พิมพ์", th: "ไทย", en: "English" };

  // Study mode only makes sense when the story itself is in English.
  const studyOn = () => !!(state && state.study && state.lang === "en");

  function languageRules() {
    if (state.lang === "en") {
      return [
        "- เขียนเนื้อเรื่องเป็นภาษาอังกฤษเสมอ แม้ผู้เล่นจะพิมพ์คำสั่งเป็นภาษาไทย (Write the story in English, like a published English novel)",
        "- ระดับภาษาอังกฤษของผู้อ่าน: " + (CEFR_RULES[state.cefr] || CEFR_RULES.B1),
      ];
    }
    if (state.lang === "th") return ["- เขียนเนื้อเรื่องเป็นภาษาไทยเสมอ แม้ผู้เล่นจะพิมพ์เป็นภาษาอื่น"];
    return ["- ตอบเป็นภาษาเดียวกับที่ผู้เล่นพิมพ์มา (พิมพ์ไทยตอบไทย)"];
  }

  function povRule() {
    if (state.pov === "third") {
      return '- เล่าแบบบุรุษที่สาม อดีตกาล เหมือนนิยาย เรียกตัวเอกด้วยชื่อ "' + state.name + '" (ไม่ใช้ "คุณ"/"You")';
    }
    return '- เล่าแบบมุมมองบุรุษที่สอง ("คุณ..." / "You...")';
  }

  function studyRules() {
    if (!studyOn()) return [];
    return [
      "",
      "โหมดเพื่อการศึกษา (เปิดอยู่) — ผู้เล่นเป็นคนไทยที่อ่านนิยายนี้เพื่อฝึกภาษาอังกฤษ:",
      "- หลังจบเนื้อเรื่อง ขึ้นบรรทัดใหม่แล้วพิมพ์ <<STUDY>> ตามด้วย JSON บรรทัดเดียว (ก่อน <<STATE>>):",
      '  {"vocab":[{"word":string,"base":string,"pos":string,"th":string,"ex":string,"note":string}],"fix":null}',
      "- vocab: เลือก 5-8 คำหรือวลีจากตอนนี้ที่ยากสำหรับผู้เรียนระดับ " + state.cefr +
      " เน้นคำที่มีประโยชน์ใช้ได้จริง phrasal verb และสำนวน ห้ามเลือกชื่อเฉพาะหรือคำพื้นฐานเกินไป",
      "  - word: คำ/วลีตามที่ปรากฏในเนื้อเรื่องตรงตัว (รูปเดียวกับในเรื่อง)",
      "  - base: รูปพจนานุกรม เช่น trudged → trudge",
      "  - pos: n. / v. / adj. / adv. / phr.v. / idiom / phr.",
      "  - th: ความหมายภาษาไทยตามบริบทในเรื่อง",
      "  - ex: ประโยคจากเนื้อเรื่องที่มีคำนี้ คัดลอกมาตรงตัว",
      "  - note: อธิบายภาษาไทย 1 ประโยค เช่น วิธีใช้ ความรู้สึกของคำ หรือคำที่ใช้แทนได้",
      "- ห้ามเลือกคำที่อยู่ในรายการ \"คำศัพท์ที่ผู้เล่นเรียนแล้ว\"",
      '- fix: ถ้าผู้เล่นพิมพ์คำสั่งเป็นภาษาอังกฤษแล้วมีจุดผิดหรือไม่เป็นธรรมชาติ ให้ใส่ {"original":string,"better":string,"why":"อธิบายภาษาไทยสั้นๆ"} ' +
      "ถ้าพิมพ์ถูกแล้ว พิมพ์เป็นภาษาไทย หรือเป็นการเปิดเรื่อง ให้ใส่ null",
    ];
  }

  // โหมด Qidian อยู่ในไฟล์แยก (qidian-mode/qidian.js) ถ้าไฟล์โหลดไม่ขึ้น
  // เกมต้องเล่นต่อได้ตามปกติ จึงเช็กก่อนทุกครั้งแทนที่จะพึ่งว่ามันมีแน่
  const qidianOn = () => !!(state && state.qidian && window.QIDIAN);

  function qidianRules() {
    return qidianOn() ? window.QIDIAN.rules(state) : [];
  }

  function systemRules() {
    return [
      'คุณคือ Game Master ของเกม text-adventure ส่วนตัวแบบเล่นคนเดียว ชื่อ "Tale Engine"',
      "",
      "กติกาการเล่าเรื่อง:",
      povRule(),
      "- ความยาว: " + (LENGTH_RULES[state.length] || LENGTH_RULES.short),
      ...languageRules(),
      "- " + (MODE_RULES[state.mode] || MODE_RULES.rpg),
      (state.autoPlay
        ? "- โหมดออโต้เปิดอยู่: ห้ามหยุดรอผู้เล่น ให้เล่าต่อเนื่องและตัดสินใจแทนตัวเอกเองอย่างสมเหตุสมผล"
        : "- จบทุกครั้งด้วยสถานการณ์ที่ผู้เล่นต้องตัดสินใจต่อ ห้ามเล่าแทนหรือเดาการกระทำของผู้เล่นเอง"),
      "- คุณจะได้รับบทสรุปเนื้อเรื่องเก่า (ความจำระยะยาว) และสถานะโลก/ตัวละครล่าสุด ต้องยึดข้อมูลเหล่านี้เป็นความจริง ห้ามขัดแย้ง",
      "- HP ห้ามต่ำกว่า 0 หรือเกิน maxHp ถ้า HP ถึง 0 ให้บรรยายภาวะวิกฤต/หมดสติ/ต้องพักฟื้น แต่ห้ามจบเกม (ไม่มี permadeath)",
      ...craftRules(),
      ...qidianRules(),
      "",
      "รูปแบบคำตอบ (สำคัญมาก):",
      "- เล่าเรื่องก่อน จากนั้นขึ้นบรรทัดใหม่แล้วพิมพ์ <<STATE>> ตามด้วย JSON บรรทัดเดียว ห้ามใส่ markdown fence",
      "- JSON ต้องมีคีย์ครบเสมอ:",
      '  {"hp":number,"maxHp":number,"level":number,"xp":number,"realm":string,"realmProgress":number,' +
      '"worldTime":string,"skills":string[],"inventory":string[],"resources":string[],"titles":string[],' +
      '"location":string,"npcs":string[],"factions":string[],"rivals":string[],"quests":string[],' +
      '"worldEvents":string[],"flags":string[]}',
      "",
      "ความหมายของแต่ละฟิลด์ — ต้องอัปเดตทุกเทิร์นโดยไม่ต้องรอให้ผู้เล่นถาม:",
      '- realm: ฐานบ่มเพาะ/ขั้นพลังปัจจุบันของตัวเอก เช่น "หลอมพลัง ชั้น 3" หรือ "อัศวินฝึกหัด ขั้นต้น" (ถ้าโลกนี้ไม่มีระบบขั้น ให้ใส่ระดับฝีมือแทน)',
      "- realmProgress: ความคืบหน้าสู่ขั้นถัดไป 0-100 ต้องขยับตามเนื้อเรื่องจริง",
      '- worldTime: เวลาในโลก เช่น "เช้าวันที่ 3 ของฤดูใบไม้ร่วง"',
      '- resources: ทรัพยากรที่นับได้ รูปแบบ "ชื่อ: จำนวน" เช่น "หินวิญญาณ: 12", "เหรียญเงิน: 40"',
      "- titles: ฉายา/ตำแหน่ง/สังกัดที่ตัวเอกได้มา",
      '- npcs: ตัวละครสำคัญที่เจอแล้ว รูปแบบ "ชื่อ — ระดับพลัง/ตำแหน่ง — ความสัมพันธ์กับเรา — กำลังทำอะไรอยู่" อัปเดตทับของเดิม ไม่ซ้ำรายการ',
      '- factions: สำนัก/ตระกูล/องค์กร รูปแบบ "ชื่อ — ท่าทีต่อเรา — ความเคลื่อนไหวล่าสุด"',
      '- rivals: คู่แข่ง/ศัตรูที่กำลังไต่ขั้นแข่งกับเรา รูปแบบ "ชื่อ — ระดับพลังของเขา — เขาคืบหน้าไปถึงไหน" ต้องเติบโตขึ้นเรื่อยๆ แม้ตัวเอกไม่ได้เจอ',
      '- quests: เป้าหมาย/ภารกิจที่ยังค้าง รูปแบบ "สิ่งที่ต้องทำ — เดดไลน์/อุปสรรค"',
      '- worldEvents: 2-4 รายการ สิ่งที่โลกภายนอกกำลังทำอยู่ตอนนี้ (สงคราม ข่าวลือ การประลอง ภัยพิบัติ) รูปแบบ "เหตุการณ์ — สถานะล่าสุด" อัปเดตให้ขยับทุก 2-3 เทิร์น ห้ามซ้ำเดิมตลอด',
      "- flags: เหตุการณ์/การตัดสินใจที่ยังมีผลต่อเนื้อเรื่อง สั้นๆ ไม่เกิน 15 รายการ ตัดที่หมดความสำคัญออกได้",
      "- ต้องส่งค่าปัจจุบันครบทุกฟิลด์เสมอ แม้ไม่มีอะไรเปลี่ยน (ฟิลด์ที่ยังไม่มีข้อมูล ใส่ \"\" หรือ [] ได้)",
      "- ห้ามพิมพ์อะไรต่อหลัง JSON",
      "- ห้ามตอบว่างเปล่า ต้องมีเนื้อเรื่องก่อน <<STATE>> เสมอ",
      ...studyRules(),
    ].join("\n");
  }

  function worldSnapshot() {
    return {
      character: state.name + (state.charDesc ? " — " + state.charDesc : ""),
      world: state.world || "(ไม่ระบุ — สร้างสรรค์ได้เอง)",
      mode: state.mode,
      hp: state.hp, maxHp: state.maxHp, level: state.level, xp: state.xp,
      realm: state.realm || "", realmProgress: state.realmProgress || 0,
      worldTime: state.worldTime || "",
      skills: state.skills, inventory: state.inventory,
      resources: state.resources || [], titles: state.titles || [],
      location: state.location,
      npcs: state.npcs, factions: state.factions || [], rivals: state.rivals || [],
      quests: state.quests || [], worldEvents: state.worldEvents || [],
      flags: state.flags,
    };
  }

  // Fields worth showing the player as a "what changed" panel each turn.
  function statusSnapshot() {
    return {
      hp: state.hp, maxHp: state.maxHp, level: state.level, xp: state.xp,
      realm: state.realm || "", realmProgress: state.realmProgress || 0,
      worldTime: state.worldTime || "", location: state.location || "",
      skills: (state.skills || []).slice(),
      inventory: (state.inventory || []).slice(),
      resources: (state.resources || []).slice(),
      titles: (state.titles || []).slice(),
      npcs: (state.npcs || []).slice(),
      factions: (state.factions || []).slice(),
      rivals: (state.rivals || []).slice(),
      quests: (state.quests || []).slice(),
      worldEvents: (state.worldEvents || []).slice(),
    };
  }

  function chaptersText() {
    if (!state.chapters.length) return "(ยังไม่มีบทสรุปก่อนหน้า — นี่คือช่วงต้นเรื่อง)";
    return state.chapters.map(c => "[" + (c.label || ("ตอนที่ " + c.index)) + "] " + c.summary).join("\n");
  }

  const KNOWN_WORDS_SENT = 80;

  function memoryHeader() {
    let h = "[บทสรุปเนื้อเรื่องที่ผ่านมา — ความจำระยะยาว]\n" + chaptersText() +
      "\n\n[สถานะโลก/ตัวละครล่าสุด]\n" + JSON.stringify(worldSnapshot());
    if (studyOn() && state.vocab.length) {
      h += "\n\n[คำศัพท์ที่ผู้เล่นเรียนแล้ว — ห้ามเลือกซ้ำ]\n" +
        state.vocab.slice(-KNOWN_WORDS_SENT).map(v => v.base || v.word).join(", ");
    }
    return h;
  }

  // Hard budget guard: trims oldest raw ctx until the prompt fits.
  // Guarantees the game can never become permanently unsendable (BUG #2 fix).
  function buildTurns(actionText) {
    const header = memoryHeader();
    let ctx = state.ctx.slice();
    const sizeOf = (arr) => bytes(header + JSON.stringify(arr) + actionText + systemRules());

    while (ctx.length > 2 && sizeOf(ctx) > PROMPT_CHAR_BUDGET) ctx = ctx.slice(2);

    const turns = [{ role: "user", content: header }, { role: "assistant", content: "รับทราบ ผมจะดำเนินเรื่องต่อโดยยึดข้อมูลทั้งหมดนี้" }];
    for (const m of ctx) turns.push(m);
    turns.push({ role: "user", content: actionText });
    return turns;
  }

  // ============================================================
  // Turn flow
  // ============================================================
  function pushLog(role, content, meta) {
    const entry = { role, content, t: now() };
    if (meta) Object.assign(entry, meta);
    state.log.push(entry);
    return entry;
  }

  async function takeTurn(rawAction, opts) {
    opts = opts || {};
    if (busy) return false;
    if (!settings.apiKey) { openSettings(); toast("ตั้งค่า API key ก่อนเริ่มเล่น"); return false; }

    busy = true;
    setBusyUI(true);

    // Dice is rolled here and SHOWN to the player (was invisible before).
    // It is rendered provisionally and rolled back if the turn fails.
    let sentAction = rawAction;
    let roll = null, diceEl = null;
    if (state.mode === "dnd" && !opts.isOpening) {
      roll = Math.floor(Math.random() * 20) + 1;
      sentAction = rawAction + "\n[Dice: d20=" + roll + "]";
      diceEl = renderDice(roll);
    }

    cancelAuto();   // a turn is starting; any pending auto tick is redundant

    const bubble = document.createElement("div");
    bubble.className = "msg ai streaming";
    bubble.textContent = "…";
    $("log").appendChild(bubble);

    // In auto-play the tool row is created up front so the live reader has a
    // button to drive, and the voice can start on the first finished sentence
    // instead of waiting for the whole turn to land.
    let toolsRow = null, live = null;
    if (state.autoPlay && ttsSupported()) {
      toolsRow = aiTools(bubble, "");
      $("log").appendChild(toolsRow);
      live = startLiveRead(bubble, toolsRow.querySelector("button"));
    }
    scrollLog(true);

    currentAbort = new AbortController();
    let ok = false;

    try {
      const turns = opts.isOpening
        ? [{ role: "user", content: "[ตัวละครและโลกที่ผู้เล่นสร้าง]\n" + JSON.stringify({ name: state.name, charDesc: state.charDesc, world: state.world, mode: state.mode }) },
           { role: "assistant", content: "รับทราบ ผมพร้อมเปิดเรื่องแล้ว" },
           { role: "user", content: sentAction }]
        : buildTurns(sentAction);

      const res = await gemini({
        system: systemRules(),
        turns,
        signal: currentAbort.signal,
        onStatus: (sec, n) => {
          bubble.textContent = "⏳ โควตาต่อนาทีเต็ม — รอ " + sec + " วินาทีแล้วลองให้อัตโนมัติ (ครั้งที่ " + n + ")…";
        },
        onText: (t) => {
          // hide the machine blocks (and a half-streamed "<<STU…" marker)
          const vis = t.split(/<<(?:STATE|STUDY)>>/)[0].replace(/<<[A-Z]*>?$/, "");
          if (reading === live && live) feedLive(live, vis, false);
          else bubble.textContent = vis;
          scrollLog();
        },
      });

      const reply = splitReply(res.text);
      const narrative = reply.narrative;

      // BUG #3 fix: an empty narrative is never accepted and never stored.
      if (!narrative) throw apiErr("empty", "AI ตอบมาแต่ไม่มีเนื้อเรื่อง — กดลองใหม่");

      const study = studyOn() ? parseStudy(reply.study) : null;

      bubble.classList.remove("streaming");
      const stillLive = (live && reading === live) ? live : null;
      fillNarrative(bubble, narrative, study);
      if (toolsRow) {
        // reuse the row created for the live reader; rebind it to the final text
        const b = toolsRow.querySelector("button");
        if (b) b.onclick = () => readAloud(bubble, narrative, b);
      } else {
        $("log").appendChild(aiTools(bubble, narrative));
      }
      // hand the reader the last sentence it was holding back, and close the queue
      if (stillLive) feedLive(stillLive, narrative, true, true);
      if (study) $("log").appendChild(renderStudyCard(study));

      const before = statusSnapshot();
      if (reply.state) applyStatePatch(reply.state);
      const after = statusSnapshot();

      // โหมด Qidian: ตรวจตอนที่เพิ่งได้มาในเครื่อง (ไม่เสียโควตา) แล้วเก็บผลไว้
      // ยัดกลับเข้า prompt ของตอนถัดไปเป็นหัวข้อ "ต้องแก้ให้ได้ในตอนนี้"
      if (qidianOn()) {
        state.qidianNotes = window.QIDIAN.audit(narrative, state).notes;
        state._lastRealm = state.realm;
        state._lastRealmProgress = state.realmProgress;
      }

      const diff = opts.isOpening ? [] : statusDiff(before, after);
      if (state.showStatus !== false) {
        const card = renderStatusCard(after, diff);
        if (card) $("log").appendChild(card);
      }

      // BUG #4 fix: the player's turn is committed to memory only here,
      // after a confirmed good reply. A failed turn leaves nothing behind.
      state.ctx.push({ role: "user", content: sentAction });
      state.ctx.push({ role: "assistant", content: narrative });
      if (opts.isOpening) {
        pushLog("sys", "✨ เริ่มการผจญภัย");
      } else if (opts.isAuto) {
        // the player typed nothing — don't fake a user turn in the transcript
        if (roll !== null) pushLog("dice", "🎲 d20 = " + roll);
      } else {
        if (roll !== null) pushLog("dice", "🎲 d20 = " + roll);
        pushLog("user", rawAction);
      }
      const meta = { status: after, diff };
      if (study) meta.study = study;
      const aiEntry = pushLog("assistant", narrative, meta);
      if (study) addToNotebook(study.vocab, aiEntry.t);
      state.lastAction = opts.isOpening ? null : rawAction;
      ok = true;

      updateHeader();
      renderDrawer();
      await persist(true);
      await maybeCompress();
    } catch (e) {
      if (live && reading === live) stopReading();
      if (toolsRow) toolsRow.remove();
      bubble.remove();
      if (diceEl) diceEl.remove();
      if (e && e.code === "aborted") {
        renderSys("⏹️ ยกเลิกเทิร์นนี้แล้ว (ไม่ถูกบันทึก)");
      } else {
        renderError(e, rawAction, opts);
      }
    } finally {
      currentAbort = null;
      busy = false;
      setBusyUI(false);
      scrollLog();
      renderDrawer();
      // When a reader is running, the *end of the read* chains the next turn.
      // Without one (no speech support, or it stopped early), chain from here
      // so auto-play still works as a plain text crawl.
      if (ok && state && state.autoPlay && !(reading && reading.bubble === bubble)) scheduleAuto();
    }
    return ok;
  }

  // Reply layout: narrative, then optional <<STUDY>>{…}, then <<STATE>>{…}.
  // Models sometimes swap the two blocks, so both orders are accepted.
  function splitReply(text) {
    const out = { narrative: "", study: "", state: "" };
    const re = /<<(STUDY|STATE)>>/g;
    const marks = [];
    let m;
    while ((m = re.exec(text))) marks.push({ kind: m[1], at: m.index, end: re.lastIndex });
    out.narrative = (marks.length ? text.slice(0, marks[0].at) : text).trim();
    marks.forEach((k, i) => {
      const body = text.slice(k.end, i + 1 < marks.length ? marks[i + 1].at : text.length);
      if (k.kind === "STUDY" && !out.study) out.study = body;
      if (k.kind === "STATE" && !out.state) out.state = body;
    });
    return out;
  }

  // Pull the first {...} object out of model text: tolerates code fences and
  // trailing prose, and ignores braces inside JSON strings.
  function extractJson(text) {
    let raw = String(text || "").trim()
      .replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const first = raw.indexOf("{");
    if (first > 0) raw = raw.slice(first);
    let depth = 0, end = -1, inStr = false;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (inStr) {
        if (c === "\\") i++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end > -1) raw = raw.slice(0, end + 1);
    return JSON.parse(raw);
  }

  function parseStudy(text) {
    if (!text || !text.trim()) return null;
    let p;
    try { p = extractJson(text); } catch (e) { console.warn("STUDY JSON ไม่ถูกต้อง:", e); return null; }
    const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
    const vocab = (Array.isArray(p && p.vocab) ? p.vocab : [])
      .filter(v => v && typeof v === "object")
      .map(v => ({
        word: str(v.word, 60), base: str(v.base, 60), pos: str(v.pos, 20),
        th: str(v.th, 200), ex: str(v.ex, 400), note: str(v.note, 300),
      }))
      .filter(v => v.word && v.th)
      .slice(0, 12);
    let fix = null;
    if (p && p.fix && typeof p.fix === "object") {
      const f = { original: str(p.fix.original, 400), better: str(p.fix.better, 400), why: str(p.fix.why, 400) };
      if (f.better && f.better !== f.original) fix = f;
    }
    return (vocab.length || fix) ? { vocab, fix } : null;
  }

  function addToNotebook(vocab, t) {
    const seen = new Set(state.vocab.map(v => (v.base || v.word).toLowerCase()));
    for (const v of vocab) {
      const key = (v.base || v.word).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      state.vocab.push(Object.assign({ t }, v));
    }
  }

  function applyStatePatch(jsonText) {
    let p;
    try { p = extractJson(jsonText); } catch (e) { console.warn("STATE JSON ไม่ถูกต้อง:", e); return; }
    if (!p || typeof p !== "object") return;

    const n = (v, f) => (typeof v === "number" && isFinite(v)) ? v : f;
    state.maxHp = Math.max(1, n(p.maxHp, state.maxHp));
    state.hp = Math.max(0, Math.min(state.maxHp, n(p.hp, state.hp)));
    state.level = Math.max(1, n(p.level, state.level));
    state.xp = Math.max(0, n(p.xp, state.xp));
    state.realmProgress = Math.max(0, Math.min(100, n(p.realmProgress, state.realmProgress || 0)));
    const strArr = (v) => Array.isArray(v) ? v.map(x => String(x)).filter(Boolean).slice(0, 40) : null;
    const sk = strArr(p.skills); if (sk) state.skills = sk;
    const iv = strArr(p.inventory); if (iv) state.inventory = iv;
    const np = strArr(p.npcs); if (np) state.npcs = np;
    const fl = strArr(p.flags); if (fl) state.flags = fl.slice(0, 20);
    const rs = strArr(p.resources); if (rs) state.resources = rs.slice(0, 20);
    const ti = strArr(p.titles); if (ti) state.titles = ti.slice(0, 12);
    const fa = strArr(p.factions); if (fa) state.factions = fa.slice(0, 15);
    const rv = strArr(p.rivals); if (rv) state.rivals = rv.slice(0, 15);
    const qs = strArr(p.quests); if (qs) state.quests = qs.slice(0, 15);
    const we = strArr(p.worldEvents); if (we) state.worldEvents = we.slice(0, 8);
    if (typeof p.location === "string") state.location = p.location;
    if (typeof p.realm === "string" && p.realm.trim()) state.realm = p.realm.trim().slice(0, 80);
    if (typeof p.worldTime === "string" && p.worldTime.trim()) state.worldTime = p.worldTime.trim().slice(0, 80);
  }

  // ---------- Status diff ----------
  // What changed between two snapshots, in the player's language. This is the
  // "ไม่ต้องถามก็รู้" panel: level-ups, realm breakthroughs, new items, and
  // what the world did while the player was busy.
  function statusDiff(before, after) {
    if (!before) return [];
    const out = [];
    const num = (label, key, fmt) => {
      if (before[key] === after[key]) return;
      out.push({ kind: after[key] > before[key] ? "up" : "down",
        text: label + " " + (fmt ? fmt(before[key]) : before[key]) + " → " + (fmt ? fmt(after[key]) : after[key]) });
    };
    if (before.realm !== after.realm && after.realm) {
      out.push({ kind: "big", text: "🌀 ฐานบ่มเพาะ: " + (before.realm || "—") + " → " + after.realm });
    }
    num("⬆️ Level", "level");
    num("❤️ HP", "hp");
    if (before.maxHp !== after.maxHp) out.push({ kind: "up", text: "❤️ HP สูงสุด " + before.maxHp + " → " + after.maxHp });
    num("✨ XP", "xp");
    if (before.realm === after.realm && before.realmProgress !== after.realmProgress) {
      out.push({ kind: after.realmProgress > before.realmProgress ? "up" : "down",
        text: "🌀 ความคืบหน้าขั้นถัดไป " + before.realmProgress + "% → " + after.realmProgress + "%" });
    }
    if (before.location !== after.location && after.location) out.push({ kind: "info", text: "📍 " + after.location });
    const listDiff = (label, key, icon) => {
      const b = new Set(before[key] || []);
      const a = new Set(after[key] || []);
      for (const v of a) if (!b.has(v)) out.push({ kind: "up", text: icon + " ได้" + label + ": " + v });
      for (const v of b) if (!a.has(v)) out.push({ kind: "down", text: icon + " เสีย" + label + ": " + v });
    };
    listDiff("สกิล", "skills", "🔮");
    listDiff("ไอเทม", "inventory", "🎒");
    listDiff("ฉายา", "titles", "🏅");
    const changed = (key, label, icon) => {
      const b = new Set(before[key] || []);
      for (const v of (after[key] || [])) if (!b.has(v)) out.push({ kind: "info", text: icon + " " + label + ": " + v });
    };
    changed("resources", "ทรัพยากร", "💰");
    changed("quests", "ภารกิจ", "🎯");
    changed("rivals", "คู่แข่ง", "⚔️");
    changed("factions", "ฝ่าย", "🏯");
    changed("npcs", "ตัวละคร", "👤");
    changed("worldEvents", "โลกภายนอก", "🌍");
    return out;
  }

  // ============================================================
  // Memory compression (with guaranteed fallback — BUG #2 fix)
  // ============================================================
  async function maybeCompress() {
    if (state.ctx.length <= CTX_TRIGGER) return;

    const overflow = state.ctx.length - CTX_KEEP;
    const chunk = state.ctx.slice(0, overflow);
    const chunkText = chunk.map(m => (m.role === "user" ? "ผู้เล่น: " : "GM: ") + m.content).join("\n\n");

    let summary = null;
    try {
      const res = await gemini({
        system: "คุณเป็นผู้ช่วยสรุปเนื้อเรื่อง ตอบเฉพาะบทสรุป ห้ามเกริ่นนำหรือแสดงความเห็น",
        turns: [{
          role: "user", content:
            "สรุปช่วงเนื้อเรื่อง text-adventure ต่อไปนี้ให้กระชับ 3-5 ประโยค เป็นภาษาเดียวกับต้นฉบับ " +
            "เก็บเฉพาะจุดที่มีผลต่อเนื้อเรื่องต่อ (เหตุการณ์หลัก การตัดสินใจ ความสัมพันธ์ที่เปลี่ยน สิ่งที่ค้างคา) " +
            "ตัดคำบรรยายบรรยากาศที่ไม่จำเป็นออก:\n\n" + chunkText
        }],
        temperature: 0.3,
        maxTokens: 2048, model: SUMMARY_MODEL, quiet: true,
      });
      summary = res.text.trim();
    } catch (e) {
      console.warn("สรุปความจำไม่สำเร็จ:", e);
    }

    if (summary) {
      state.chapters.push({ index: state.chapters.length + 1, summary, t: now() });
      state.ctx = state.ctx.slice(overflow);
      renderChapterMark(summary);
      pushLog("chapter", summary);
    } else {
      // Fallback: trim anyway so ctx can never grow without bound.
      // A local extractive summary keeps *something* rather than nothing.
      const fallback = chunk.filter(m => m.role === "assistant")
        .map(m => m.content.replace(/\s+/g, " ").slice(0, 160))
        .slice(-3).join(" … ");
      state.chapters.push({
        index: state.chapters.length + 1,
        summary: (fallback || "(ช่วงเนื้อเรื่องที่สรุปอัตโนมัติไม่สำเร็จ)"),
        degraded: true, t: now(),
      });
      state.ctx = state.ctx.slice(overflow);
      renderSys("⚠️ สรุปความจำอัตโนมัติไม่สำเร็จ — ใช้สรุปสำรองแทน (แก้ไขได้ในเมนู 📖 ความจำ)");
      pushLog("sys", "สรุปความจำอัตโนมัติไม่สำเร็จ ใช้สรุปสำรองแทน");
    }

    await compressChapters();
    await persist(true);
    renderDrawer();
  }

  async function compressChapters() {
    if (state.chapters.length <= CHAPTER_COMPRESS_AT) return;
    const oldest = state.chapters.slice(0, CHAPTER_MERGE_COUNT);
    const rest = state.chapters.slice(CHAPTER_MERGE_COUNT);
    const combined = oldest.map(c => "(" + (c.label || ("ตอนที่ " + c.index)) + ") " + c.summary).join("\n");

    let arc = null;
    try {
      const res = await gemini({
        system: "คุณเป็นผู้ช่วยสรุปเนื้อเรื่อง ตอบเฉพาะบทสรุป",
        turns: [{
          role: "user", content:
            "รวมสรุปหลายตอนนี้ให้เหลือย่อหน้าเดียว 4-6 ประโยค คงเฉพาะเหตุการณ์/การตัดสินใจที่ยังสำคัญต่อเนื้อเรื่องระยะยาว " +
            "ตัดรายละเอียดที่จบไปแล้วออก:\n\n" + combined
        }],
        temperature: 0.3, maxTokens: 2048, model: SUMMARY_MODEL, quiet: true,
      });
      arc = res.text.trim();
    } catch (e) { console.warn("รวมตอนไม่สำเร็จ:", e); }

    if (!arc) {
      // Fallback merge: concatenate, truncated. Never leave chapters unbounded.
      arc = oldest.map(c => c.summary).join(" ").replace(/\s+/g, " ").slice(0, 900);
    }
    state.chapters = [{
      index: oldest[0].index,
      label: "รวมตอนที่ " + oldest[0].index + "-" + oldest[oldest.length - 1].index,
      summary: arc, t: now(),
    }].concat(rest);
  }

  // ============================================================
  // Rendering
  // ============================================================
  // ---------- Scroll follow ----------
  // The log only snaps to the bottom while the player is already sitting at
  // the bottom. The moment they scroll up — to read while a turn streams in —
  // auto-scroll stops and a "↓ ข้อความใหม่" pill appears instead.
  let followBottom = true;
  let pendingBelow = false;

  function atBottom(slack) {
    const l = $("log");
    return (l.scrollHeight - l.scrollTop - l.clientHeight) <= (slack || 80);
  }
  function updateJumpPill() {
    const p = $("jumpBtn");
    if (!p) return;
    // while a read is driving the scroll, the pill would flash on every
    // streamed token — the reader is already showing the player where they are
    const show = !followBottom && pendingBelow && !(reading && reading.live);
    p.classList.toggle("show", show);
  }
  function scrollLog(force) {
    const l = $("log");
    if (force) {
      followBottom = true;
      pendingBelow = false;
      l.scrollTop = l.scrollHeight;
      updateJumpPill();
      return;
    }
    if (!followBottom) { pendingBelow = true; updateJumpPill(); return; }
    l.scrollTop = l.scrollHeight;
  }
  function bindScrollFollow() {
    const l = $("log");
    l.addEventListener("scroll", () => {
      const now = atBottom();
      if (now !== followBottom) {
        followBottom = now;
        if (now) pendingBelow = false;
        updateJumpPill();
      }
    }, { passive: true });
    const j = $("jumpBtn");
    if (j) j.onclick = () => scrollLog(true);
  }
  function renderSys(text) {
    const el = document.createElement("div");
    el.className = "msg sys";
    el.textContent = text;
    $("log").appendChild(el); scrollLog();
  }
  function renderDice(roll) {
    const el = document.createElement("div");
    el.className = "msg dice" + (roll === 20 ? " crit" : roll === 1 ? " fumble" : "");
    el.textContent = "🎲 d20 = " + roll + (roll === 20 ? " — สำเร็จเกินคาด!" : roll === 1 ? " — หายนะ!" : "");
    $("log").appendChild(el); scrollLog();
    return el;
  }
  function renderChapterMark(summary) {
    const el = document.createElement("div");
    el.className = "msg chapter";
    el.textContent = "📖 บันทึกความทรงจำ: " + summary;
    $("log").appendChild(el); scrollLog();
  }
  function renderUser(text) {
    const el = document.createElement("div");
    el.className = "msg user";
    el.textContent = text;
    $("log").appendChild(el); scrollLog(true);
    return el;
  }

  // ---------- Study mode rendering ----------
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // ---------- Sentence segmentation ----------
  // Splits narrative into sentence-sized pieces whose concatenation is
  // byte-for-byte the original text. Latin prose splits on . ! ? …; Thai
  // rarely uses them, so over-long pieces fall back to splitting on spaces.
  const SENT_END = /[.!?…。！？]/;
  const SENT_TAIL = /[.!?…。！？"”’')\]]/;
  const SENT_MAX = 170;   // a piece longer than this gets split on spaces
  const SENT_AIM = 110;   // …aiming for roughly this length

  function splitLongPiece(s) {
    const out = [];
    while (s.length > SENT_MAX) {
      let cut = s.lastIndexOf(" ", SENT_AIM);
      if (cut < 40) cut = s.indexOf(" ", SENT_AIM);
      if (cut < 0 || cut > SENT_MAX) cut = SENT_AIM;
      out.push(s.slice(0, cut + 1));
      s = s.slice(cut + 1);
    }
    if (s) out.push(s);
    return out;
  }

  function segmentSentences(text) {
    const raw = [];
    let cur = "";
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      cur += c;
      if (c === "\n") { raw.push(cur); cur = ""; continue; }
      if (!SENT_END.test(c)) continue;
      let j = i + 1;
      while (j < text.length && SENT_TAIL.test(text[j])) { cur += text[j]; j++; }
      i = j - 1;
      if (j < text.length && !/\s/.test(text[j])) continue;
      while (j < text.length && text[j] === " ") { cur += text[j]; j++; i = j - 1; }
      raw.push(cur); cur = "";
    }
    if (cur) raw.push(cur);
    const out = [];
    for (const p of raw) {
      if (p.length > SENT_MAX) out.push.apply(out, splitLongPiece(p));
      else out.push(p);
    }
    return out.length ? out : [text];
  }

  // Story text as sentence spans (for read-aloud highlighting), with each
  // vocab word marked inside its own sentence (first occurrence only).
  function fillNarrative(el, text, study) {
    const sents = segmentSentences(text);
    const parts = sents.map(s => [esc(s)]);   // each sentence: odd slots = marks
    if (study && study.vocab.length) {
      study.vocab.forEach((v, i) => {
        const re = new RegExp("(^|[^A-Za-z'])(" + reEsc(esc(v.word)) + ")(?![A-Za-z])", "i");
        let done = false;
        for (let p = 0; p < parts.length && !done; p++) {
          const seg = parts[p];
          for (let k = 0; k < seg.length; k += 2) {
            const hit = re.exec(seg[k]);
            if (!hit) continue;
            const at = hit.index + hit[1].length;
            const s = seg[k];
            seg.splice(k, 1,
              s.slice(0, at),
              '<mark class="vw" data-i="' + i + '">' + hit[2] + "</mark>",
              s.slice(at + hit[2].length));
            done = true;
            break;
          }
        }
      });
    }
    el.innerHTML = parts
      .map((seg, i) => '<span class="sent" data-si="' + i + '">' + seg.join("") + "</span>")
      .join("");
    el._study = study;
  }

  // ---------- Read aloud (browser speech synthesis, no API quota) ----------
  const ttsSupported = () => !!(window.speechSynthesis && typeof window.SpeechSynthesisUtterance === "function");
  const TTS_MIN = 0.4, TTS_MAX = 2.5, TTS_STEP = 0.05;
  const clampRate = (v) => {
    const n = parseFloat(v);
    if (!isFinite(n)) return 0.85;
    const snapped = Math.round(Math.round(n / TTS_STEP) * TTS_STEP * 100) / 100;
    return Math.min(TTS_MAX, Math.max(TTS_MIN, snapped));
  };
  function rateLabel(r) {
    const s = r.toFixed(2).replace(/0$/, "").replace(/\.$/, "");
    const word = r <= 0.6 ? "ช้ามาก" : r <= 0.8 ? "ช้า" : r < 0.95 ? "ค่อนข้างช้า"
      : r <= 1.05 ? "ปกติ" : r <= 1.3 ? "เร็วขึ้น" : r <= 1.7 ? "เร็ว" : "เร็วมาก";
    return "×" + s + " · " + word;
  }
  let reading = null; // { btn, bubble, spans, chunks, i, lang, voice }

  const isThai = (text) => (text.match(/[฀-๿]/g) || []).length > text.length * 0.2;

  function pickVoice(lang) {
    const voices = window.speechSynthesis.getVoices ? window.speechSynthesis.getVoices() : [];
    const pre = lang.slice(0, 2);
    const same = voices.filter(v => String(v.lang || "").replace("_", "-").toLowerCase().startsWith(pre));
    return same.find(v => v.lang === lang && /google|natural|premium|enhanced/i.test(v.name)) ||
      same.find(v => v.lang === lang) || same[0] || null;
  }

  // Speech plan: one chunk per on-screen sentence span, so the highlight and
  // the voice stay in lockstep. Over-long sentences become several chunks that
  // all point back at the same span. Chrome cuts utterances off around 15 s,
  // which is why nothing longer than ~240 chars is ever sent at once.
  function speechPlan(bubble, text) {
    const spans = Array.prototype.slice.call(bubble.querySelectorAll(".sent"));
    const chunks = [];
    if (!spans.length) {
      for (const s of segmentSentences(text)) {
        const t = s.trim();
        if (t) chunks.push({ text: t, si: -1 });
      }
      return { spans: [], chunks };
    }
    spans.forEach((sp, si) => {
      let s = (sp.textContent || "").trim();
      if (!s) return;
      while (s.length > 240) {
        let cut = s.lastIndexOf(" ", 220);
        if (cut < 80) cut = 220;
        chunks.push({ text: s.slice(0, cut).trim(), si });
        s = s.slice(cut).trim();
      }
      if (s) chunks.push({ text: s, si });
    });
    return { spans, chunks };
  }

  function clearHighlight(r) {
    if (r && r.spans) r.spans.forEach(sp => sp.classList.remove("now"));
  }

  // Slide the log so the sentence being read sits in the upper third —
  // the "สไลด์จอควบคู่ขนานไปกับประโยคที่อ่าน" part.
  function followSentence(sp) {
    if (!settings.ttsFollow) return;
    const l = $("log");
    const lr = l.getBoundingClientRect();
    const sr = sp.getBoundingClientRect();
    const target = l.scrollTop + (sr.top - lr.top) - l.clientHeight * 0.35;
    const max = l.scrollHeight - l.clientHeight;
    const top = Math.max(0, Math.min(max, target));
    if (Math.abs(top - l.scrollTop) < 8) return;
    try { l.scrollTo({ top, behavior: "smooth" }); } catch (e) { l.scrollTop = top; }
    followBottom = atBottom();
    updateJumpPill();
  }

  // A read session ends one of three ways: the player stops it, a new one
  // replaces it, or it runs out of chunks. Only the last one is "finished"
  // and therefore allowed to chain into the next auto-play turn.
  function stopReading(opts) {
    if (!reading) return;
    const r = reading;
    reading = null;
    clearHighlight(r);
    r.btn.textContent = "🔊 ฟังตอนนี้";
    r.btn.classList.remove("on");
    r.bubble.classList.remove("reading");
    if (r.nav) r.nav.remove();
    if (ttsSupported()) window.speechSynthesis.cancel();
    updateJumpPill();
    // a pending auto tick belongs to the read that just died
    cancelAuto(opts && opts.userStop ? { off: true } : null);
  }

  function finishReading(r) {
    const chain = !!(state && state.autoPlay);
    stopReading();
    if (chain) scheduleAuto();
  }

  // Speak the chunk at r.i, then the next, and so on. A *live* session can
  // run dry while the model is still streaming: it parks in "waiting" and
  // feedLive() wakes it up as soon as another sentence lands.
  function speakStep(r) {
    if (reading !== r) return;
    if (r.i >= r.chunks.length) {
      if (r.open) {
        r.waiting = true;
        r.btn.textContent = "⏳ กำลังเขียนต่อ…";
        return;
      }
      finishReading(r);
      return;
    }
    r.waiting = false;
    if (!r.lang) {
      r.lang = isThai(r.text || r.chunks[r.i].text) ? "th-TH" : "en-US";
      r.voice = pickVoice(r.lang);
    }
    const c = r.chunks[r.i];
    clearHighlight(r);
    if (c.si >= 0 && r.spans[c.si]) {
      r.spans[c.si].classList.add("now");
      followSentence(r.spans[c.si]);
    }
    r.btn.textContent = "⏹ หยุด (" + (r.i + 1) + "/" + r.chunks.length + (r.open ? "+" : "") + ")";
    const u = new window.SpeechSynthesisUtterance(c.text);
    u.lang = r.lang;
    u.rate = settings.ttsRate;
    u.pitch = settings.ttsPitch;
    if (r.voice) u.voice = r.voice;
    u.onend = () => { if (reading === r) { r.i++; speakStep(r); } };
    u.onerror = (e) => {
      if (reading !== r) return;
      if (e && (e.error === "interrupted" || e.error === "canceled")) return;
      stopReading(); toast("อ่านออกเสียงไม่สำเร็จ");
    };
    window.speechSynthesis.speak(u);
  }

  // Speak from chunk index `at`. Restarting mid-read is how a rate change or
  // a ⏮/⏭ tap takes effect immediately instead of at the next sentence.
  function playFrom(r, at) {
    if (reading !== r) return;
    r.i = Math.max(0, Math.min(r.chunks.length, at));
    window.speechSynthesis.cancel();
    speakStep(r);
  }

  // Rate changed mid-read: re-speak the current sentence at the new speed.
  function applyLiveRate() {
    if (reading && !reading.waiting) playFrom(reading, reading.i);
  }

  function jumpSentence(delta) {
    if (!reading || !reading.chunks.length) return;
    const r = reading;
    const curSi = r.chunks[Math.min(r.i, r.chunks.length - 1)].si;
    let at = r.i + (delta > 0 ? 1 : -1);
    // step to the first chunk of a *different* sentence
    while (at > 0 && at < r.chunks.length && r.chunks[at].si === curSi) at += (delta > 0 ? 1 : -1);
    while (at > 0 && r.chunks[at - 1] && r.chunks[at - 1].si === r.chunks[at].si) at--;
    if (at >= r.chunks.length) {
      if (r.open) { r.i = r.chunks.length; r.waiting = true; return; }
      finishReading(r); return;
    }
    playFrom(r, Math.max(0, at));
  }

  // The ⏮ ⏭ 🐢 🐇 strip that sits beside 🔊 only while a bubble is being read.
  function makeReadNav() {
    const nav = document.createElement("span");
    nav.className = "readnav";
    const mk = (label, title, fn) => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = label; b.title = title;
      b.onclick = fn;
      nav.appendChild(b);
    };
    mk("⏮", "ประโยคก่อนหน้า", () => jumpSentence(-1));
    mk("⏭", "ประโยคถัดไป", () => jumpSentence(1));
    mk("🐢", "ช้าลง", () => nudgeRate(-0.1));
    mk("🐇", "เร็วขึ้น", () => nudgeRate(0.1));
    return nav;
  }

  function beginSession(r) {
    reading = r;
    r.btn.classList.add("on");
    r.bubble.classList.add("reading");
    r.nav = makeReadNav();
    r.btn.parentNode.appendChild(r.nav);
  }

  function readAloud(bubble, text, btn) {
    if (reading && reading.btn === btn) { stopReading({ userStop: true }); return; }
    stopReading();
    const lang = isThai(text) ? "th-TH" : "en-US";
    const voice = pickVoice(lang);
    if (lang === "th-TH" && !voice) toast("เครื่องนี้อาจไม่มีเสียงภาษาไทย — ลองติดตั้งในการตั้งค่า Text-to-speech ของเครื่อง", 4000);
    const plan = speechPlan(bubble, text);
    if (!plan.chunks.length) { toast("ไม่มีข้อความให้อ่าน"); return; }

    const r = { btn, bubble, text, spans: plan.spans, chunks: plan.chunks,
      i: 0, committed: plan.spans.length, open: false, lang, voice };
    beginSession(r);
    playFrom(r, 0);
  }

  // ---------- Live (read-while-it-writes) session ----------
  // Started the moment a turn begins in auto-play, so the voice can catch up
  // to the very first finished sentence instead of waiting for the whole turn.
  function startLiveRead(bubble, btn) {
    if (!ttsSupported()) return null;
    stopReading();
    const lang = state.lang === "en" ? "en-US" : state.lang === "th" ? "th-TH" : null;
    const r = { btn, bubble, text: "", spans: [], chunks: [],
      i: 0, committed: 0, open: true, live: true, waiting: true,
      lang, voice: lang ? pickVoice(lang) : null };
    beginSession(r);
    btn.textContent = "⏳ กำลังเขียนต่อ…";
    return r;
  }

  // Hand the live session however much narrative exists so far. Only sentences
  // that can no longer change are queued for speech — the final one keeps
  // growing until `done`, so it is held back.
  function feedLive(r, text, done, skipRender) {
    if (reading !== r) return;
    r.text = text;
    if (!skipRender) fillNarrative(r.bubble, text, null);
    r.spans = Array.prototype.slice.call(r.bubble.querySelectorAll(".sent"));

    const sents = segmentSentences(text);
    const limit = done ? sents.length : Math.max(0, sents.length - 1);
    for (let si = r.committed; si < limit; si++) {
      let piece = (sents[si] || "").trim();
      while (piece.length > 240) {
        let cut = piece.lastIndexOf(" ", 220);
        if (cut < 80) cut = 220;
        r.chunks.push({ text: piece.slice(0, cut).trim(), si });
        piece = piece.slice(cut).trim();
      }
      if (piece) r.chunks.push({ text: piece, si });
    }
    r.committed = Math.max(r.committed, limit);
    if (done) r.open = false;

    // re-rendering wiped the highlight — put it back on the live sentence
    const cur = r.chunks[r.i];
    if (!r.waiting && cur && cur.si >= 0 && r.spans[cur.si]) r.spans[cur.si].classList.add("now");
    if (r.waiting) speakStep(r);
  }

  // ============================================================
  // Auto Play (Hardcore) — the audiobook loop
  // ============================================================
  // write → speak → (1.5 s) → write again, hands-free, until the player
  // stops the read or flips the switch back off.
  const AUTO_DELAY = 1500;
  const AUTO_ACTION =
    "(ดำเนินเรื่องต่อเองตามสถานการณ์ที่บีบคั้นที่สุด — ตัดสินใจแทนตัวเอกให้สมเหตุสมผลกับบุคลิก " +
    "สถานะ และสิ่งที่เพิ่งเกิดขึ้น แล้วเล่าผลลัพธ์ต่อเป็นฉากเต็ม)";
  let autoTimer = null;

  function cancelAuto(opts) {
    if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
    if (opts && opts.off && state && state.autoPlay) {
      state.autoPlay = false;
      const t = $("autoToggle");
      if (t) t.checked = false;
      updateHeader();
      persist(true);
    }
  }

  function scheduleAuto() {
    cancelAuto();
    if (!state || !state.autoPlay || busy) return;
    autoTimer = setTimeout(() => { autoTimer = null; runAutoTurn(); }, AUTO_DELAY);
  }

  async function runAutoTurn() {
    if (!state || !state.autoPlay || busy) return;
    const ok = await takeTurn(AUTO_ACTION, { isAuto: true });
    // A failed auto turn stops the loop rather than retrying forever on a
    // dead key or an exhausted quota.
    if (!ok) {
      cancelAuto({ off: true });
      toast("ออโต้หยุดแล้ว — เทิร์นล่าสุดไม่สำเร็จ", 4000);
    }
  }

  // Turning the switch on picks up wherever the story already is: read the
  // latest chapter aloud, and let the end of that read trigger the next turn.
  function startAutoPlay() {
    if (!state || !state.autoPlay) return;
    if (busy) return;                       // the in-flight turn will chain
    const rows = $("log").querySelectorAll(".msgtools");
    const lastRow = rows[rows.length - 1];
    const btn = lastRow && lastRow.querySelector("button");
    if (btn && ttsSupported()) { btn.click(); return; }
    runAutoTurn();
  }

  // Row under each story bubble; hidden where the browser can't speak.
  function aiTools(bubble, text) {
    const row = document.createElement("div");
    row.className = "msgtools";
    if (!ttsSupported()) return row;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "🔊 ฟังตอนนี้";
    btn.onclick = () => readAloud(bubble, text, btn);
    row.appendChild(btn);
    return row;
  }

  // Single place that writes the speed: keeps slider, label, storage and any
  // in-flight utterance in sync.
  async function setRate(v, opts) {
    settings.ttsRate = clampRate(v);
    const sl = $("ttsRateRange");
    if (sl) sl.value = String(settings.ttsRate);
    const lb = $("ttsRateLabel");
    if (lb) lb.textContent = rateLabel(settings.ttsRate);
    if (!opts || !opts.quiet) toast("ความเร็วเสียงอ่าน " + rateLabel(settings.ttsRate));
    if (!opts || !opts.noRestart) applyLiveRate();
    try { await setSetting("ttsRate", String(settings.ttsRate)); } catch (e) { }
  }
  function nudgeRate(d) { setRate(settings.ttsRate + d); }

  function speak(text) {
    if (!ttsSupported()) { toast("เครื่องนี้ไม่รองรับการอ่านออกเสียง"); return; }
    stopReading({ userStop: true });
    window.speechSynthesis.cancel();
    const u = new window.SpeechSynthesisUtterance(text);
    u.lang = "en-US"; u.rate = Math.min(settings.ttsRate, 0.9);
    const voice = pickVoice("en-US");
    if (voice) u.voice = voice;
    window.speechSynthesis.speak(u);
  }

  // Preview the current speed from the settings drawer.
  function speakSample(text, lang) {
    if (!ttsSupported()) { toast("เครื่องนี้ไม่รองรับการอ่านออกเสียง"); return; }
    window.speechSynthesis.cancel();
    const u = new window.SpeechSynthesisUtterance(text);
    u.lang = lang; u.rate = settings.ttsRate; u.pitch = settings.ttsPitch;
    const voice = pickVoice(lang);
    if (voice) u.voice = voice;
    window.speechSynthesis.speak(u);
  }

  function vocabItemEl(v) {
    const item = document.createElement("div");
    item.className = "vitem";
    item.innerHTML =
      '<div class="vtop"><b>' + esc(v.word) + "</b>" +
      (v.base && v.base.toLowerCase() !== v.word.toLowerCase() ? ' <span class="dim">(' + esc(v.base) + ")</span>" : "") +
      (v.pos ? ' <span class="pos">' + esc(v.pos) + "</span>" : "") +
      '<button class="say" type="button" title="ฟังเสียง">🔊</button></div>' +
      '<div class="vth">' + esc(v.th) + "</div>" +
      (v.ex ? '<div class="vex">“' + esc(v.ex) + "”</div>" : "") +
      (v.note ? '<div class="vnote">💡 ' + esc(v.note) + "</div>" : "");
    item.querySelector(".say").onclick = () => speak(v.base || v.word);
    return item;
  }

  function renderStudyCard(study) {
    const box = document.createElement("details");
    box.className = "msg study";
    box.open = true;
    const sum = document.createElement("summary");
    sum.textContent = "📚 คำศัพท์ในตอนนี้ (" + study.vocab.length + " คำ)";
    box.appendChild(sum);
    for (const v of study.vocab) box.appendChild(vocabItemEl(v));
    if (study.fix) {
      const f = document.createElement("div");
      f.className = "vfix";
      f.innerHTML = '<div class="vfixhead">✍️ ภาษาอังกฤษที่คุณพิมพ์</div>' +
        '<div class="vold">' + esc(study.fix.original) + "</div>" +
        '<div class="vnew">→ ' + esc(study.fix.better) + "</div>" +
        (study.fix.why ? '<div class="vnote">' + esc(study.fix.why) + "</div>" : "");
      box.appendChild(f);
    }
    return box;
  }

  // ---------- Per-turn status panel ----------
  // "ใครเลเวลเท่าไร ฐานบ่มเพาะเท่าไร คนอื่นกำลังทำอะไร" — shown after every
  // turn without the player having to ask for it.
  function renderStatusCard(snap, diff) {
    if (!snap) return null;
    const box = document.createElement("details");
    box.className = "msg status";
    box.open = !!(diff && diff.length);

    const head = document.createElement("summary");
    const bits = ["Lv." + snap.level];
    if (snap.realm) bits.push(snap.realm);
    bits.push("❤️ " + snap.hp + "/" + snap.maxHp);
    head.textContent = "📊 " + bits.join(" · ") + (diff && diff.length ? "  (" + diff.length + " อัปเดต)" : "");
    box.appendChild(head);

    if (diff && diff.length) {
      const d = document.createElement("div");
      d.className = "stdiff";
      d.innerHTML = diff.map(x => '<div class="d-' + x.kind + '">' + esc(x.text) + "</div>").join("");
      box.appendChild(d);
    }

    const grid = document.createElement("div");
    grid.className = "stgrid";
    const cell = (label, value) => {
      if (!value) return "";
      return '<div class="stcell"><span class="stl">' + esc(label) + '</span><span class="stv">' + esc(value) + "</span></div>";
    };
    grid.innerHTML =
      cell("เลเวล", "Lv." + snap.level + " · XP " + snap.xp) +
      cell("ฐานบ่มเพาะ", snap.realm ? snap.realm + (snap.realmProgress ? " (" + snap.realmProgress + "%)" : "") : "") +
      cell("HP", snap.hp + " / " + snap.maxHp) +
      cell("เวลา", snap.worldTime) +
      cell("สถานที่", snap.location) +
      cell("ฉายา", (snap.titles || []).join(" · ")) +
      cell("ทรัพยากร", (snap.resources || []).join(" · "));
    if (grid.innerHTML) box.appendChild(grid);

    const list = (label, arr, icon) => {
      if (!arr || !arr.length) return;
      const s = document.createElement("div");
      s.className = "stlist";
      s.innerHTML = '<div class="stlh">' + icon + " " + esc(label) + "</div>" +
        arr.slice(0, 8).map(x => '<div class="stli">• ' + esc(x) + "</div>").join("");
      box.appendChild(s);
    };
    list("โลกภายนอกตอนนี้", snap.worldEvents, "🌍");
    list("คู่แข่ง / ศัตรู", snap.rivals, "⚔️");
    list("ฝ่าย / สำนัก", snap.factions, "🏯");
    list("ภารกิจค้าง", snap.quests, "🎯");
    return box;
  }

  function renderError(e, rawAction, opts) {
    const wrapEl = document.createElement("div");
    wrapEl.className = "msg err";
    const msg = document.createElement("div");
    msg.textContent = "⚠️ " + ((e && e.message) || "เกิดข้อผิดพลาด");
    wrapEl.appendChild(msg);

    const row = document.createElement("div");
    row.className = "errbtns";

    const retry = document.createElement("button");
    retry.textContent = "🔄 ลองใหม่";
    retry.onclick = () => {
      wrapEl.remove();
      takeTurn(rawAction, Object.assign({}, opts, { isRetry: false }));
    };
    row.appendChild(retry);

    if (e && (e.code === "no_key" || e.code === "bad_key" || e.code === "forbidden" || e.code === "no_model" || e.code === "no_quota" || e.code === "rate_limited")) {
      const st = document.createElement("button");
      st.textContent = "⚙️ ตั้งค่า";
      st.onclick = openSettings;
      row.appendChild(st);
    }
    wrapEl.appendChild(row);
    $("log").appendChild(wrapEl);
    scrollLog();
  }

  function setBusyUI(b) {
    $("sendBtn").disabled = b;
    $("actionInput").disabled = b;
    $("stopBtn").style.display = b ? "block" : "none";
    $("sendBtn").style.display = b ? "none" : "block";
    document.querySelectorAll("#chips button").forEach(x => x.disabled = b);
  }

  function updateHeader() {
    $("headerTitle").textContent = state.title || state.name;
    $("headerHp").textContent = (state.autoPlay ? "▶️ ออโต้ · " : "") +
      "❤️ " + state.hp + "/" + state.maxHp + " · Lv." + state.level;
    $("autoStopBtn").style.display = state.autoPlay ? "block" : "none";
  }

  function memSize() {
    return bytes(JSON.stringify(state || {}));
  }
  function promptSize() {
    if (!state) return 0;
    return bytes(systemRules() + memoryHeader() + JSON.stringify(state.ctx));
  }

  function renderDrawer() {
    if (!state) return;
    $("charName").textContent = state.name;
    $("charDescView").textContent = state.charDesc || "(ยังไม่ระบุ — กด ✏️ เพื่อเพิ่ม)";
    $("worldView").textContent = state.world || "(ยังไม่ระบุ — AI สร้างสรรค์เอง)";
    $("modeView").textContent = MODE_LABELS[state.mode] || state.mode;
    if ($("modeSelect").value !== state.mode) $("modeSelect").value = state.mode;
    $("hpText").textContent = "HP " + state.hp + " / " + state.maxHp;
    $("lvText").textContent = "Lv." + state.level + " · XP " + state.xp;
    $("hpBar").style.width = Math.round((state.hp / Math.max(1, state.maxHp)) * 100) + "%";
    $("skillsList").innerHTML = state.skills.length
      ? state.skills.map(s => '<span class="tag">' + esc(s) + "</span>").join("")
      : '<span class="dim">ยังไม่มี</span>';
    $("invList").innerHTML = state.inventory.length
      ? state.inventory.map(s => '<span class="tag">' + esc(s) + "</span>").join("")
      : '<span class="dim">ว่างเปล่า</span>';
    $("langSelect").value = state.lang;
    $("lengthSelect").value = state.length;
    $("povSelect").value = state.pov;
    $("studyToggle").checked = !!state.study;
    $("cefrSelect").value = state.cefr;
    $("studyOpts").style.display = state.lang === "en" ? "block" : "none";
    $("vocabBtn").textContent = "📚 สมุดคำศัพท์ (" + state.vocab.length + " คำ)";
    $("ttsRateRange").value = String(settings.ttsRate);
    $("ttsRateLabel").textContent = rateLabel(settings.ttsRate);
    $("ttsFollowToggle").checked = !!settings.ttsFollow;
    $("autoToggle").checked = !!state.autoPlay;
    $("fxToggle").checked = state.fx !== false;
    $("statusToggle").checked = state.showStatus !== false;
    $("qidianToggle").checked = !!state.qidian;
    $("realmText").textContent = state.realm || "-";
    $("realmBar").style.width = Math.max(0, Math.min(100, state.realmProgress || 0)) + "%";
    $("realmPct").textContent = (state.realmProgress || 0) + "%";
    $("worldTimeText").textContent = state.worldTime || "-";
    const lines = (arr, bullet) => (arr && arr.length)
      ? arr.map(x => (bullet ? "• " : "") + esc(x)).join("<br>") : '<span class="dim">-</span>';
    $("titlesText").innerHTML = lines(state.titles);
    $("resText").innerHTML = lines(state.resources);
    $("locationText").textContent = state.location || "-";
    $("npcsText").innerHTML = lines(state.npcs);
    $("factionsText").innerHTML = lines(state.factions);
    $("rivalsText").innerHTML = lines(state.rivals);
    $("questsText").innerHTML = lines(state.quests, true);
    $("worldEventsText").innerHTML = lines(state.worldEvents, true);
    $("flagsText").innerHTML = lines(state.flags, true);
    $("memStat").innerHTML =
      "บทสรุปสะสม <b>" + state.chapters.length + "</b> ตอน · บทสนทนาสด <b>" + state.ctx.length + "</b> ข้อความ<br>" +
      "ขนาดเซฟ <b>" + fmtBytes(memSize()) + "</b> · ขนาด prompt/เทิร์น <b>" + fmtBytes(promptSize()) + "</b><br>" +
      "ประวัติทั้งหมด <b>" + state.log.length + "</b> รายการ";
  }

  const RENDER_WINDOW = 120;
  let renderFrom = 0;

  function renderAll(showAll) {
    const l = $("log");
    stopReading({ userStop: true });   // undo/retry/reload ends the audiobook
    l.innerHTML = "";
    const total = state.log.length;
    renderFrom = showAll ? 0 : Math.max(0, total - RENDER_WINDOW);
    if (renderFrom > 0) {
      const more = document.createElement("button");
      more.className = "ghost full loadmore";
      more.textContent = "↑ แสดงเนื้อเรื่องก่อนหน้าทั้งหมด (" + renderFrom + " รายการ)";
      more.onclick = () => renderAll(true);
      l.appendChild(more);
    }
    for (const m of state.log.slice(renderFrom)) {
      const el = document.createElement("div");
      if (m.role === "user") el.className = "msg user";
      else if (m.role === "assistant") el.className = "msg ai";
      else if (m.role === "chapter") { el.className = "msg chapter"; el.textContent = "📖 บันทึกความทรงจำ: " + m.content; l.appendChild(el); continue; }
      else if (m.role === "dice") el.className = "msg dice";
      else el.className = "msg sys";
      if (m.role === "assistant") {
        fillNarrative(el, m.content, m.study);
        l.appendChild(el);
        l.appendChild(aiTools(el, m.content));
        if (m.study) l.appendChild(renderStudyCard(m.study));
        if (state.showStatus !== false && m.status) {
          const card = renderStatusCard(m.status, m.diff);
          if (card) { card.open = false; l.appendChild(card); }
        }
        continue;
      }
      el.textContent = m.content;
      l.appendChild(el);
    }
    updateHeader();
    applyInputHint();
    renderDrawer();
    if (!showAll) scrollLog(true);
  }

  // ============================================================
  // Screens
  // ============================================================
  function show(screen) {
    for (const s of ["boot", "setup", "game"]) {
      $(s).style.display = (s === screen) ? (s === "game" ? "flex" : "block") : "none";
    }
  }

  // ============================================================
  // Setup
  // ============================================================
  const PRESETS = {
    darkfantasy: {
      charDesc: "อดีตทหารรับจ้างที่เคยทำพลาดจนทีมตัวเองตาย ตอนนี้เก็บตัวเงียบและไม่ไว้ใจใครง่ายๆ",
      world: "แฟนตาซียุคกลางที่เวทมนตร์กำลังเลือนหายไปจากโลก เทพเจ้าเงียบหายไปนาน ปีศาจเริ่มคืบคลานเข้ามาตามเมืองชายแดน กฎหมายอ่อนแอ ทุกคนต้องพึ่งพาตัวเอง",
    },
    scifi: {
      charDesc: "อดีตวิศวกรของบรรษัทใหญ่ที่แปรพักตร์หลังรู้ความจริงเบื้องหลังโปรเจกต์ลับ ตอนนี้ใช้ชีวิตหลบๆ ซ่อนๆ ในเมืองใต้ดิน",
      world: "อนาคตอันใกล้ที่บรรษัทข้ามชาติปกครองเมืองแทนรัฐบาล ความเหลื่อมล้ำสูงมาก ไซเบอร์เนติกส์แพร่หลายแต่ราคาแพง ตำรวจเอกชนไล่ล่าคนที่รู้ความลับเกินไป",
    },
    horror: {
      charDesc: "นักข่าวสืบสวนที่ตามหาความจริงเรื่องคนหายในเมืองเล็กๆ แห่งหนึ่ง เริ่มรู้สึกว่ามีอะไรบางอย่างจับตาดูอยู่",
      world: "เมืองเล็กที่ถูกหมอกปกคลุมบ่อยผิดปกติ ชาวเมืองพูดกันเบาๆ ว่าอย่าออกจากบ้านหลังพระอาทิตย์ตก มีตำนานท้องถิ่นเกี่ยวกับสิ่งที่อาศัยอยู่ในป่าใกล้เมือง",
    },
    magicschool: {
      charDesc: "นักเรียนปีสุดท้ายที่เวทมนตร์อ่อนกว่าคนอื่นแต่ขยันเป็นพิเศษ มีความลับเกี่ยวกับตระกูลที่ไม่อยากให้ใครรู้",
      world: "โรงเรียนเวทมนตร์เก่าแก่กลางหุบเขา มีระบบคณะแข่งขันกันเอง ครูใหญ่หายตัวไปอย่างลึกลับเมื่อต้นเทอม และไม่มีใครพูดถึงเรื่องนี้ตรงๆ",
    },
    postapoc: {
      charDesc: "ผู้รอดชีวิตที่เติบโตหลังหายนะ ไม่เคยเห็นโลกเก่าด้วยตาตัวเอง เก่งเรื่องเอาตัวรอดแต่ไม่ไว้ใจคนแปลกหน้า",
      world: "โลกหลังภัยพิบัติที่ทรัพยากรขาดแคลน เมืองใหญ่กลายเป็นซากปรักหักพัง ผู้คนรวมกลุ่มเป็นชุมชนเล็กๆ เพื่อความอยู่รอด กฎของแต่ละชุมชนไม่เหมือนกัน",
    },
    custom: { charDesc: "", world: "" },
  };

  let chosenMode = "rpg";
  const SETUP_DEFAULTS = { lang: "th", length: "medium", pov: "second" };
  let chosen = Object.assign({}, SETUP_DEFAULTS);

  // Button groups like <div class="modes" data-seg="lang"><button data-v="th">
  function setSeg(key, value) {
    chosen[key] = value;
    document.querySelectorAll('[data-seg="' + key + '"] button').forEach(b =>
      b.classList.toggle("active", b.dataset.v === value));
    if (key === "lang") $("studyField").style.display = value === "en" ? "block" : "none";
  }

  function bindSetup() {
    document.querySelectorAll("[data-seg] button").forEach(b => {
      b.onclick = () => setSeg(b.parentElement.dataset.seg, b.dataset.v);
    });
    document.querySelectorAll(".mode-btn").forEach(b => {
      b.onclick = () => {
        document.querySelectorAll(".mode-btn").forEach(x => x.classList.remove("active"));
        b.classList.add("active");
        chosenMode = b.dataset.mode;
      };
    });
    document.querySelectorAll(".preset-btn").forEach(b => {
      b.onclick = () => {
        document.querySelectorAll(".preset-btn").forEach(x => x.classList.remove("active"));
        b.classList.add("active");
        const p = PRESETS[b.dataset.preset];
        if (p) { $("setupChar").value = p.charDesc; $("setupWorld").value = p.world; }
      };
    });

    $("startBtn").onclick = async () => {
      if (!settings.apiKey) { openSettings(); toast("ตั้งค่า API key ก่อนเริ่มเล่น"); return; }
      const name = $("setupName").value.trim() || "นักผจญภัยไร้นาม";
      state = defaultState({
        name,
        title: $("setupTitle").value.trim() || name,
        charDesc: $("setupChar").value.trim(),
        world: $("setupWorld").value.trim(),
        mode: chosenMode,
        lang: chosen.lang, length: chosen.length, pov: chosen.pov,
        study: chosen.lang === "en" && $("setupStudy").checked,
        cefr: $("setupCefr").value,
      });
      show("game");
      $("log").innerHTML = "";
      applyInputHint();
      await persist(true);
      const ok = await takeTurn(
        "(เริ่มต้นการผจญภัย — เขียนฉากเปิดเรื่อง แนะนำโลกและสถานการณ์เริ่มต้นของตัวละคร จบด้วยสถานการณ์ที่ต้องตัดสินใจ)",
        { isOpening: true }
      );
      if (!ok) toast("เปิดเรื่องไม่สำเร็จ — กดลองใหม่ในกล่องข้อความแดง");
    };

    $("setupSettingsBtn").onclick = openSettings;
    $("setupSlotsBtn").onclick = openSlots;
  }

  function resetSetupForm() {
    $("setupName").value = "";
    $("setupTitle").value = "";
    $("setupChar").value = "";
    $("setupWorld").value = "";
    document.querySelectorAll(".preset-btn").forEach(x => x.classList.remove("active"));
    document.querySelectorAll(".mode-btn").forEach((x, i) => x.classList.toggle("active", i === 0));
    chosenMode = "rpg";
    for (const k in SETUP_DEFAULTS) setSeg(k, SETUP_DEFAULTS[k]);
    $("setupStudy").checked = true;
    $("setupCefr").value = "B1";
  }

  // In English stories, nudge the player to write their actions in English too.
  function applyInputHint() {
    $("actionInput").placeholder = state && state.lang === "en"
      ? "Type your action in English (Thai is OK too)…"
      : "พิมพ์การกระทำของคุณ…";
  }

  // ============================================================
  // Input bar
  // ============================================================
  function bindInput() {
    const ta = $("actionInput");
    ta.addEventListener("input", function () {
      this.style.height = "auto";
      this.style.height = Math.min(120, this.scrollHeight) + "px";
    });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });
    $("sendBtn").onclick = send;
    $("stopBtn").onclick = () => { if (currentAbort) currentAbort.abort(); };
    // one big obvious brake for the hands-free loop
    $("autoStopBtn").onclick = () => {
      cancelAuto({ off: true });
      stopReading();
      if (currentAbort) currentAbort.abort();
      renderSys("⏹️ หยุด Auto Play แล้ว");
      pushLog("sys", "หยุด Auto Play");
      persist(true);
    };
    document.querySelectorAll("#chips button").forEach(b => {
      b.onclick = () => { $("actionInput").value = b.dataset.a; send(); };
    });
    // tap a highlighted word in the story → its Thai meaning
    $("log").addEventListener("click", (e) => {
      const mk = e.target.closest && e.target.closest("mark.vw");
      // marks live inside .sent spans now, so walk up to the bubble itself
      const bub = mk && mk.closest(".msg.ai");
      const st = bub && bub._study;
      if (!st) return;
      const v = st.vocab[+mk.dataset.i];
      if (v) toast(v.word + (v.pos ? " (" + v.pos + ")" : "") + " — " + v.th, 4500);
    });

    async function send() {
      const v = $("actionInput").value.trim();
      if (!v || busy) return;
      $("actionInput").value = "";
      $("actionInput").style.height = "auto";
      const bubble = renderUser(v);
      const ok = await takeTurn(v);
      if (!ok) {
        // failed turn: remove optimistic bubble, restore text so nothing is lost
        bubble.remove();
        $("actionInput").value = v;
      }
    }
  }

  // ============================================================
  // Turn tools: retry / undo
  // ============================================================
  function bindTurnTools() {
    $("retryBtn").onclick = async () => {
      if (busy || !state) return;
      const lastUserIdx = findLastIndex(state.ctx, m => m.role === "user");
      if (lastUserIdx < 0) { toast("ยังไม่มีเทิร์นให้ลองใหม่"); return; }
      const lastUser = state.ctx[lastUserIdx];
      // drop the assistant reply that followed
      state.ctx = state.ctx.slice(0, lastUserIdx);
      dropLastTurnLog(false);
      const raw = (state.lastAction || lastUser.content).replace(/\n\[Dice: d20=\d+\]$/, "");
      closeDrawer();
      renderAll();
      await takeTurn(raw, { isRetry: false });
    };

    $("undoBtn").onclick = async () => {
      if (busy || !state) return;
      if (!confirm("ย้อนกลับ 1 เทิร์น? (ลบคำสั่งล่าสุดและคำตอบของ AI)")) return;
      const lastUserIdx = findLastIndex(state.ctx, m => m.role === "user");
      if (lastUserIdx < 0) { toast("ไม่มีเทิร์นให้ย้อน"); return; }
      state.ctx = state.ctx.slice(0, lastUserIdx);
      dropLastTurnLog(false);
      closeDrawer();
      renderAll();
      await persist(true);
      toast("ย้อนกลับ 1 เทิร์นแล้ว");
    };
  }
  function findLastIndex(arr, fn) {
    for (let i = arr.length - 1; i >= 0; i--) if (fn(arr[i])) return i;
    return -1;
  }
  // Remove the trailing turn group from the display log:
  // everything back to and including the most recent user entry.
  function dropLastTurnLog(keepUser) {
    const idx = findLastIndex(state.log, m => m.role === "user");
    // words learned in the dropped turn leave the notebook with it
    const cutoff = idx < 0 ? 0 : state.log[idx].t;
    state.vocab = state.vocab.filter(v => v.t < cutoff);
    if (idx < 0) { state.log.length = 0; return; }
    state.log.length = keepUser ? idx + 1 : idx;
  }

  // ============================================================
  // Drawer + modals
  // ============================================================
  function openDrawer() { $("drawer").classList.add("open"); $("overlay").classList.add("open"); renderDrawer(); }
  function closeDrawer() { $("drawer").classList.remove("open"); $("overlay").classList.remove("open"); }

  function openModal(id) { $(id).classList.add("open"); $("overlay").classList.add("open"); }
  function closeModals() {
    document.querySelectorAll(".modal").forEach(m => m.classList.remove("open"));
    if (!$("drawer").classList.contains("open")) $("overlay").classList.remove("open");
  }

  function bindDrawer() {
    $("openDrawer").onclick = openDrawer;
    $("drawerClose").onclick = closeDrawer;
    $("overlay").onclick = () => { closeDrawer(); closeModals(); };
    document.querySelectorAll("[data-close]").forEach(b => b.onclick = closeModals);

    // background editors
    bindEditor("editCharBtn", "charDescView", "charDescEdit", "charDescInput", "saveCharBtn", "cancelCharBtn",
      () => state.charDesc, (v) => { state.charDesc = v; }, "background ตัวละคร");
    bindEditor("editWorldBtn", "worldView", "worldEdit", "worldInput", "saveWorldBtn", "cancelWorldBtn",
      () => state.world, (v) => { state.world = v; }, "background โลก/ฉาก");

    $("modeSelect").onchange = async () => {
      state.mode = $("modeSelect").value;
      renderDrawer();
      await persist(true);
      toast("เปลี่ยนโหมดเป็น " + (MODE_LABELS[state.mode] || state.mode) + " แล้ว");
    };

    // language / length / study options — take effect from the next turn
    const optChange = (id, apply, describe) => {
      $(id).onchange = async () => {
        apply();
        renderDrawer(); applyInputHint();
        await persist(true);
        const msg = describe();
        renderSys("⚙️ " + msg + " — มีผลตั้งแต่เทิร์นถัดไป");
        pushLog("sys", msg);
      };
    };
    optChange("langSelect", () => { state.lang = $("langSelect").value; },
      () => "ภาษาเนื้อเรื่อง: " + LANG_LABELS[state.lang]);
    optChange("lengthSelect", () => { state.length = $("lengthSelect").value; },
      () => "ความยาวต่อตอน: " + LENGTH_LABELS[state.length]);
    optChange("povSelect", () => { state.pov = $("povSelect").value; },
      () => "มุมมองการเล่า: " + (state.pov === "third" ? "บุรุษที่ 3" : "บุรุษที่ 2"));
    optChange("studyToggle", () => { state.study = $("studyToggle").checked; },
      () => "โหมดเพื่อการศึกษา: " + (state.study ? "เปิด" : "ปิด"));
    optChange("cefrSelect", () => { state.cefr = $("cefrSelect").value; },
      () => "ระดับภาษาอังกฤษ: " + CEFR_LABELS[state.cefr]);
    optChange("fxToggle", () => { state.fx = $("fxToggle").checked; },
      () => "เอฟเฟคฉากบู้: " + (state.fx ? "เปิด" : "ปิด"));
    optChange("qidianToggle", () => {
      state.qidian = $("qidianToggle").checked;
      if (!state.qidian) state.qidianNotes = [];
    }, () => "โหมด Qidian: " + (state.qidian ? "เปิด — บังคับจังหวะเว็บโนเวลจีน" : "ปิด"));
    $("autoToggle").onchange = async () => {
      state.autoPlay = $("autoToggle").checked;
      updateHeader();
      await persist(true);
      if (state.autoPlay) {
        renderSys("▶️ Auto Play (Hardcore) เปิดแล้ว — AI จะเล่าและอ่านต่อเองจนกว่าจะกดหยุด");
        pushLog("sys", "เปิด Auto Play (Hardcore)");
        closeDrawer();
        startAutoPlay();
      } else {
        cancelAuto();
        stopReading();
        renderSys("⏹️ ปิด Auto Play แล้ว");
        pushLog("sys", "ปิด Auto Play");
      }
    };
    $("statusToggle").onchange = async () => {
      state.showStatus = $("statusToggle").checked;
      await persist(true);
      toast("แผงสถานะท้ายตอน: " + (state.showStatus ? "เปิด" : "ปิด"));
    };
    $("vocabBtn").onclick = openVocab;

    // speech speed is a device preference, shared by every game.
    // input = live label (no restart), change = commit + re-speak at the new speed
    $("ttsRateRange").oninput = () => {
      settings.ttsRate = clampRate($("ttsRateRange").value);
      $("ttsRateLabel").textContent = rateLabel(settings.ttsRate);
    };
    $("ttsRateRange").onchange = () => setRate($("ttsRateRange").value);
    $("ttsSlower").onclick = () => nudgeRate(-TTS_STEP);
    $("ttsFaster").onclick = () => nudgeRate(TTS_STEP);
    $("ttsReset").onclick = () => setRate(1);
    $("ttsTest").onclick = () => {
      stopReading({ userStop: true });
      const th = !state || state.lang !== "en";
      speakSample(th ? "นี่คือความเร็วในการอ่านที่คุณเลือกไว้ ลองฟังดูว่าพอดีไหม"
        : "This is the reading speed you picked. Listen and see if it feels right.", th ? "th-TH" : "en-US");
    };
    $("ttsFollowToggle").onchange = async () => {
      settings.ttsFollow = $("ttsFollowToggle").checked;
      await setSetting("ttsFollow", settings.ttsFollow ? "1" : "0");
      toast("เลื่อนจอตามประโยคที่อ่าน: " + (settings.ttsFollow ? "เปิด" : "ปิด"));
    };

    $("editStateBtn").onclick = openStateEditor;
    $("chaptersBtn").onclick = openChapters;
    $("exportBtn").onclick = openExport;
    $("slotsBtn").onclick = openSlots;
    $("settingsBtn").onclick = openSettings;
    $("newGameBtn").onclick = async () => {
      if (!confirm("เริ่มการผจญภัยใหม่? (เกมปัจจุบันยังถูกเก็บไว้ใน 'เกมที่บันทึกไว้')")) return;
      state = null;
      closeDrawer();
      resetSetupForm();
      show("setup");
    };
  }

  function bindEditor(btnId, viewId, editId, inputId, saveId, cancelId, get, set, label) {
    $(btnId).onclick = () => {
      $(inputId).value = get() || "";
      $(viewId).style.display = "none";
      $(editId).style.display = "block";
      $(inputId).focus();
    };
    $(cancelId).onclick = () => { $(editId).style.display = "none"; $(viewId).style.display = "block"; };
    $(saveId).onclick = async () => {
      set($(inputId).value.trim());
      $(editId).style.display = "none";
      $(viewId).style.display = "block";
      renderDrawer();
      await persist(true);
      renderSys("🖊️ ปรับปรุง " + label + " แล้ว — มีผลตั้งแต่เทิร์นถัดไป");
      pushLog("sys", "ปรับปรุง " + label);
      toast("บันทึกแล้ว");
    };
  }

  // ---------- State editor ----------
  function openStateEditor() {
    $("seHp").value = state.hp;
    $("seMaxHp").value = state.maxHp;
    $("seLevel").value = state.level;
    $("seXp").value = state.xp;
    $("seRealm").value = state.realm || "";
    $("seRealmProgress").value = state.realmProgress || 0;
    $("seWorldTime").value = state.worldTime || "";
    $("seLocation").value = state.location || "";
    $("seTitles").value = (state.titles || []).join("\n");
    $("seRes").value = (state.resources || []).join("\n");
    $("seSkills").value = state.skills.join("\n");
    $("seInv").value = state.inventory.join("\n");
    $("seNpcs").value = state.npcs.join("\n");
    $("seFactions").value = (state.factions || []).join("\n");
    $("seRivals").value = (state.rivals || []).join("\n");
    $("seQuests").value = (state.quests || []).join("\n");
    $("seWorldEvents").value = (state.worldEvents || []).join("\n");
    $("seFlags").value = state.flags.join("\n");
    openModal("stateModal");
  }
  function bindStateEditor() {
    $("seSave").onclick = async () => {
      const mh = Math.max(1, parseInt($("seMaxHp").value, 10) || state.maxHp);
      state.maxHp = mh;
      state.hp = Math.max(0, Math.min(mh, parseInt($("seHp").value, 10) || 0));
      state.level = Math.max(1, parseInt($("seLevel").value, 10) || 1);
      state.xp = Math.max(0, parseInt($("seXp").value, 10) || 0);
      state.realm = $("seRealm").value.trim();
      state.realmProgress = Math.max(0, Math.min(100, parseInt($("seRealmProgress").value, 10) || 0));
      state.worldTime = $("seWorldTime").value.trim();
      state.location = $("seLocation").value.trim();
      state.titles = linesToArr($("seTitles").value);
      state.resources = linesToArr($("seRes").value);
      state.skills = linesToArr($("seSkills").value);
      state.inventory = linesToArr($("seInv").value);
      state.npcs = linesToArr($("seNpcs").value);
      state.factions = linesToArr($("seFactions").value);
      state.rivals = linesToArr($("seRivals").value);
      state.quests = linesToArr($("seQuests").value);
      state.worldEvents = linesToArr($("seWorldEvents").value);
      state.flags = linesToArr($("seFlags").value);
      closeModals();
      updateHeader(); renderDrawer();
      await persist(true);
      renderSys("🛠️ แก้ไขสถานะด้วยตนเองแล้ว — มีผลตั้งแต่เทิร์นถัดไป");
      pushLog("sys", "แก้ไขสถานะด้วยตนเอง");
      toast("บันทึกสถานะแล้ว");
    };
  }

  // ---------- Chapters viewer ----------
  function openChapters() {
    const box = $("chaptersList");
    if (!state.chapters.length) {
      box.innerHTML = '<div class="dim" style="padding:12px 0">ยังไม่มีบทสรุป — จะเริ่มสร้างอัตโนมัติเมื่อเล่นไปสักพัก</div>';
    } else {
      box.innerHTML = "";
      state.chapters.forEach((c, i) => {
        const card = document.createElement("div");
        card.className = "chapcard";
        const h = document.createElement("div");
        h.className = "chaphead";
        h.innerHTML = "<b>" + esc(c.label || ("ตอนที่ " + c.index)) + "</b>" +
          (c.degraded ? ' <span class="warnpill">สรุปสำรอง</span>' : "");
        const ta = document.createElement("textarea");
        ta.value = c.summary;
        ta.rows = 4;
        ta.oninput = () => { c.summary = ta.value; };
        const row = document.createElement("div");
        row.className = "chapbtns";
        const del = document.createElement("button");
        del.textContent = "🗑️ ลบตอนนี้";
        del.onclick = async () => {
          if (!confirm("ลบบทสรุปตอนนี้? AI จะลืมช่วงนั้นถาวร")) return;
          state.chapters.splice(i, 1);
          await persist(true); openChapters(); renderDrawer();
        };
        row.appendChild(del);
        card.appendChild(h); card.appendChild(ta); card.appendChild(row);
        box.appendChild(card);
      });
    }
    openModal("chaptersModal");
  }
  function bindChapters() {
    $("chapSave").onclick = async () => {
      await persist(true);
      closeModals(); renderDrawer();
      toast("บันทึกความทรงจำแล้ว");
    };
  }

  // ---------- Vocabulary notebook ----------
  function openVocab() {
    $("vocabSearch").value = "";
    renderVocabList();
    openModal("vocabModal");
  }
  function renderVocabList() {
    const box = $("vocabList");
    const q = $("vocabSearch").value.trim().toLowerCase();
    const list = state.vocab.slice().reverse().filter(v => !q ||
      (v.word + " " + v.base + " " + v.th).toLowerCase().indexOf(q) >= 0);
    $("vocabInfo").textContent = "ทั้งหมด " + state.vocab.length + " คำ" + (q ? " · ตรงกับคำค้น " + list.length + " คำ" : "") +
      " — คำใหม่อยู่บนสุด";
    box.innerHTML = "";
    if (!list.length) {
      box.innerHTML = '<div class="dim" style="padding:12px 0">' +
        (state.vocab.length ? "ไม่พบคำที่ค้นหา" : "ยังไม่มีคำศัพท์ — เปิดโหมดเพื่อการศึกษาแล้วเล่นต่อ คำยากจะถูกเก็บไว้ที่นี่อัตโนมัติ") + "</div>";
      return;
    }
    for (const v of list) {
      const item = vocabItemEl(v);
      const del = document.createElement("button");
      del.className = "vdel"; del.type = "button"; del.textContent = "✕"; del.title = "ลบคำนี้";
      del.onclick = async () => {
        state.vocab.splice(state.vocab.indexOf(v), 1);
        await persist(true);
        renderVocabList(); renderDrawer();
      };
      item.querySelector(".vtop").appendChild(del);
      box.appendChild(item);
    }
  }
  function vocabToCsv() {
    const cell = (s) => '"' + String(s || "").replace(/"/g, '""') + '"';
    const rows = [["word", "base", "pos", "meaning_th", "example", "note"]]
      .concat(state.vocab.map(v => [v.word, v.base, v.pos, v.th, v.ex, v.note]));
    // BOM so Excel opens Thai text correctly
    return "﻿" + rows.map(r => r.map(cell).join(",")).join("\r\n");
  }
  function bindVocab() {
    $("vocabSearch").oninput = renderVocabList;
    $("vocabCsv").onclick = () => {
      if (!state.vocab.length) { toast("ยังไม่มีคำศัพท์"); return; }
      download(safeName() + "-vocab.csv", vocabToCsv(), "text/csv;charset=utf-8");
      toast("ดาวน์โหลดสมุดคำศัพท์แล้ว (นำเข้า Anki / Excel ได้)");
    };
  }

  // ---------- Export ----------
  function studyToMarkdown(study) {
    const lines = [];
    if (study.vocab.length) {
      lines.push("> **📚 Vocabulary**", ">");
      for (const v of study.vocab) {
        lines.push("> - **" + v.word + "**" + (v.pos ? " *(" + v.pos + ")*" : "") + " — " + v.th +
          (v.note ? " · " + v.note : ""));
      }
    }
    if (study.fix) {
      lines.push(">", "> ✍️ ~~" + study.fix.original + "~~ → **" + study.fix.better + "**" +
        (study.fix.why ? " — " + study.fix.why : ""));
    }
    lines.push("");
    return lines;
  }

  function storyToMarkdown() {
    const lines = [];
    lines.push("# " + (state.title || state.name));
    lines.push("");
    lines.push("- **ตัวละคร:** " + state.name + (state.charDesc ? " — " + state.charDesc : ""));
    if (state.world) lines.push("- **โลก/ฉาก:** " + state.world);
    lines.push("- **โหมด:** " + state.mode.toUpperCase());
    lines.push("- **สถานะล่าสุด:** HP " + state.hp + "/" + state.maxHp + " · Lv." + state.level + " · XP " + state.xp);
    if (state.location) lines.push("- **สถานที่:** " + state.location);
    if (state.inventory.length) lines.push("- **ไอเทม:** " + state.inventory.join(", "));
    if (state.skills.length) lines.push("- **สกิล:** " + state.skills.join(", "));
    lines.push("");
    lines.push("---");
    lines.push("");
    for (const m of state.log) {
      if (m.role === "user") lines.push("**▶ " + m.content + "**", "");
      else if (m.role === "assistant") {
        lines.push(m.content, "");
        if (m.study) lines.push(...studyToMarkdown(m.study));
      }
      else if (m.role === "dice") lines.push("*" + m.content + "*", "");
      else if (m.role === "chapter") lines.push("> 📖 " + m.content, "");
      else lines.push("*" + m.content + "*", "");
    }
    return lines.join("\n");
  }
  function storyToText() {
    return state.log.map(m =>
      m.role === "user" ? "▶ " + m.content :
        m.role === "assistant" ? m.content :
          "[" + m.content + "]"
    ).join("\n\n");
  }
  function download(filename, content, type) {
    const blob = new Blob([content], { type: type || "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function safeName() {
    return (state.title || state.name || "tale").replace(/[^\w\u0E00-\u0E7F-]+/g, "_").slice(0, 40);
  }
  function openExport() {
    $("exportInfo").textContent =
      "ประวัติ " + state.log.length + " รายการ · ขนาดเซฟ " + fmtBytes(memSize());
    openModal("exportModal");
  }
  function bindExport() {
    $("expMd").onclick = () => { download(safeName() + ".md", storyToMarkdown(), "text/markdown;charset=utf-8"); toast("ดาวน์โหลด Markdown แล้ว"); };
    $("expTxt").onclick = () => { download(safeName() + ".txt", storyToText()); toast("ดาวน์โหลด TXT แล้ว"); };
    $("expJson").onclick = () => { download(safeName() + ".json", JSON.stringify(state, null, 2), "application/json"); toast("ดาวน์โหลดเซฟ JSON แล้ว"); };
    $("expCopy").onclick = async () => {
      try { await navigator.clipboard.writeText(storyToMarkdown()); toast("คัดลอกเนื้อเรื่องแล้ว"); }
      catch (e) { toast("คัดลอกไม่สำเร็จ — ใช้ปุ่มดาวน์โหลดแทน"); }
    };
    $("impJson").onchange = async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try {
        const txt = await f.text();
        const obj = JSON.parse(txt);
        if (!obj || typeof obj !== "object" || !Array.isArray(obj.log)) throw new Error("รูปแบบไฟล์ไม่ถูกต้อง");
        const restored = defaultState(obj);
        restored.id = uid(); // import as a new slot, never overwrite
        restored.title = (restored.title || restored.name) + " (นำเข้า)";
        await dbPut(STORE_SAVES, restored);
        state = restored;
        await setSetting("lastSave", state.id);
        closeModals();
        show("game"); renderAll();
        toast("นำเข้าเซฟสำเร็จ");
      } catch (err) {
        toast("นำเข้าไม่สำเร็จ: " + (err.message || "ไฟล์เสียหาย"));
      }
      e.target.value = "";
    };
  }

  // ---------- Save slots ----------
  async function openSlots() {
    const box = $("slotsList");
    box.innerHTML = '<div class="dim">กำลังโหลด…</div>';
    openModal("slotsModal");
    let all = [];
    try { all = await dbAll(STORE_SAVES); } catch (e) { box.innerHTML = '<div class="dim">โหลดรายการไม่สำเร็จ</div>'; return; }
    all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (!all.length) { box.innerHTML = '<div class="dim" style="padding:12px 0">ยังไม่มีเกมที่บันทึกไว้</div>'; return; }
    box.innerHTML = "";
    for (const s of all) {
      const card = document.createElement("div");
      card.className = "slotcard" + (state && s.id === state.id ? " current" : "");
      const info = document.createElement("div");
      info.className = "slotinfo";
      info.innerHTML = "<b>" + esc(s.title || s.name) + "</b>" +
        (state && s.id === state.id ? ' <span class="pill">กำลังเล่น</span>' : "") +
        '<div class="dim">' + esc((s.mode || "rpg").toUpperCase()) +
        (s.lang === "en" ? " · EN" + (s.study ? " 📚" : "") : "") + " · Lv." + (s.level || 1) +
        " · " + (s.log ? s.log.length : 0) + " รายการ · " + fmtDate(s.updatedAt || s.createdAt || now()) + "</div>";
      const btns = document.createElement("div");
      btns.className = "slotbtns";
      const load = document.createElement("button");
      load.textContent = "เปิด";
      load.disabled = !!(state && s.id === state.id);
      load.onclick = async () => {
        if (busy) { toast("รอให้เทิร์นปัจจุบันจบก่อน"); return; }
        await persist(true);
        state = defaultState(s);
        await setSetting("lastSave", state.id);
        closeModals(); closeDrawer();
        show("game"); renderAll();
        toast("เปิดเกม: " + (state.title || state.name));
      };
      const del = document.createElement("button");
      del.textContent = "🗑️";
      del.className = "danger";
      del.onclick = async () => {
        if (!confirm("ลบเกม \"" + (s.title || s.name) + "\" ถาวร?")) return;
        await dbDel(STORE_SAVES, s.id);
        if (state && state.id === s.id) { state = null; resetSetupForm(); show("setup"); closeModals(); }
        else openSlots();
        toast("ลบแล้ว");
      };
      btns.appendChild(load); btns.appendChild(del);
      card.appendChild(info); card.appendChild(btns);
      box.appendChild(card);
    }
  }
  function bindSlots() {
    $("slotNew").onclick = () => {
      closeModals(); closeDrawer();
      state = null; resetSetupForm(); show("setup");
    };
  }

  // ---------- Settings ----------
  let modelList = null; // models this key can call, fetched via ListModels

  function fillModelSelect(current) {
    const sel = $("modelSelect");
    const list = (modelList && modelList.length) ? modelList.slice() : MODELS.slice();
    if (current && !list.some(m => m.id === current)) {
      list.unshift({ id: current, label: current + " (⚠️ ไม่พบในรายชื่อของ key นี้)" });
    }
    sel.innerHTML = list.map(m => '<option value="' + esc(m.id) + '">' + esc(m.label) + "</option>").join("");
    sel.value = current || list[0].id;
  }

  function openSettings() {
    $("apiKeyInput").value = settings.apiKey || "";
    fillModelSelect(settings.model || DEFAULT_MODEL);
    $("keyStatus").textContent = settings.apiKey ? "✅ ตั้งค่าแล้ว" : "⚠️ ยังไม่ได้ตั้งค่า";
    $("keyStatus").className = settings.apiKey ? "keystat ok" : "keystat warn";
    openModal("settingsModal");
  }
  function bindSettings() {
    $("saveKeyBtn").onclick = async () => {
      settings.apiKey = $("apiKeyInput").value.trim();
      settings.model = $("modelSelect").value;
      await setSetting("apiKey", settings.apiKey);
      await setSetting("model", settings.model);
      $("keyStatus").textContent = settings.apiKey ? "✅ ตั้งค่าแล้ว" : "⚠️ ยังไม่ได้ตั้งค่า";
      $("keyStatus").className = settings.apiKey ? "keystat ok" : "keystat warn";
      toast("บันทึกการตั้งค่าแล้ว");
      closeModals();
    };
    $("loadModelsBtn").onclick = async () => {
      const key = $("apiKeyInput").value.trim();
      if (!key) { toast("ใส่ API key ก่อน"); return; }
      const btn = $("loadModelsBtn");
      const prev = btn.textContent;
      btn.disabled = true; btn.textContent = "กำลังโหลด…";
      try {
        const list = await listModels(key);
        if (!list.length) throw apiErr("empty", "key นี้ไม่มีโมเดล Gemini ที่ใช้เขียนข้อความได้");
        modelList = list;
        await setSetting("modelList", list);
        const cur = $("modelSelect").value;
        fillModelSelect(list.some(m => m.id === cur) ? cur : list[0].id);
        $("keyStatus").textContent = "✅ พบ " + list.length + " โมเดลที่ key นี้ใช้ได้ — เลือกแล้วกดบันทึก";
        $("keyStatus").className = "keystat ok";
      } catch (e) {
        $("keyStatus").textContent = "❌ " + (e.message || "โหลดรายชื่อไม่สำเร็จ");
        $("keyStatus").className = "keystat warn";
      }
      btn.disabled = false; btn.textContent = prev;
    };
    $("testKeyBtn").onclick = async () => {
      const btn = $("testKeyBtn");
      const prev = btn.textContent;
      btn.disabled = true; btn.textContent = "กำลังทดสอบ…";
      const saved = settings.apiKey, savedModel = settings.model;
      settings.apiKey = $("apiKeyInput").value.trim();
      settings.model = $("modelSelect").value;
      try {
        await gemini({ turns: [{ role: "user", content: "ตอบกลับด้วยคำว่า OK เท่านั้น" }], maxTokens: 1024, temperature: 0, noFallback: true });
        $("keyStatus").textContent = "✅ ใช้งานได้";
        $("keyStatus").className = "keystat ok";
        toast("เชื่อมต่อ Gemini สำเร็จ");
      } catch (e) {
        $("keyStatus").textContent = "❌ " + (e.message || "ทดสอบไม่ผ่าน");
        $("keyStatus").className = "keystat warn";
        settings.apiKey = saved; settings.model = savedModel;
      }
      btn.disabled = false; btn.textContent = prev;
    };
    $("clearKeyBtn").onclick = async () => {
      if (!confirm("ลบ API key ออกจากเครื่องนี้?")) return;
      settings.apiKey = "";
      await setSetting("apiKey", "");
      $("apiKeyInput").value = "";
      $("keyStatus").textContent = "⚠️ ยังไม่ได้ตั้งค่า";
      $("keyStatus").className = "keystat warn";
      toast("ลบ API key แล้ว");
    };
    $("toggleKeyBtn").onclick = () => {
      const i = $("apiKeyInput");
      i.type = i.type === "password" ? "text" : "password";
      $("toggleKeyBtn").textContent = i.type === "password" ? "👁️" : "🙈";
    };
  }

  // ============================================================
  // Boot
  // ============================================================
  async function boot() {
    show("boot");
    try {
      idb = await openDB();
    } catch (e) {
      $("bootMsg").innerHTML = "⚠️ เปิดฐานข้อมูลในเครื่องไม่ได้<br><span class='dim'>" +
        esc(e.message || "") + "</span><br><span class='dim'>ถ้าใช้โหมดส่วนตัว/ไม่ระบุตัวตน ให้ลองเปิดในโหมดปกติ</span>";
      return;
    }

    settings.apiKey = await getSetting("apiKey", "");
    settings.model = await getSetting("model", DEFAULT_MODEL) || DEFAULT_MODEL;
    settings.ttsRate = clampRate(await getSetting("ttsRate", "0.85"));
    settings.ttsPitch = 1;
    settings.ttsFollow = String(await getSetting("ttsFollow", "1")) !== "0";
    const savedList = await getSetting("modelList", null);
    if (Array.isArray(savedList) && savedList.length) modelList = savedList;

    bindSetup(); bindInput(); bindDrawer(); bindTurnTools(); bindScrollFollow();
    bindStateEditor(); bindChapters(); bindExport(); bindSlots(); bindSettings(); bindVocab();

    // Chrome loads voices lazily; ask early so the first 🔊 gets a good one
    if (ttsSupported() && window.speechSynthesis.getVoices) window.speechSynthesis.getVoices();

    const lastId = await getSetting("lastSave", null);
    let loaded = null;
    if (lastId) {
      try { loaded = await dbGet(STORE_SAVES, lastId); } catch (e) { }
    }
    if (!loaded) {
      try {
        const all = await dbAll(STORE_SAVES);
        all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        loaded = all[0] || null;
      } catch (e) { }
    }

    if (loaded) {
      state = defaultState(loaded);
      state.autoPlay = false;   // reopening the app never restarts the loop by itself
      $("modeSelect").value = state.mode;
      show("game");
      renderAll();
      await setSetting("lastSave", state.id);
    } else {
      resetSetupForm();
      show("setup");
      if (!settings.apiKey) setTimeout(openSettings, 400);
    }

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(() => { });
    }
  }

  boot();
})();
