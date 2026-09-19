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
  let settings = { apiKey: "", model: DEFAULT_MODEL };

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
      hp: 20, maxHp: 20, level: 1, xp: 0,
      skills: [], inventory: [],
      location: "", npcs: [], flags: [],
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
  };

  function systemRules() {
    return [
      'คุณคือ Game Master ของเกม text-adventure ส่วนตัวแบบเล่นคนเดียว ชื่อ "Tale Engine"',
      "",
      "กติกาการเล่าเรื่อง:",
      '- เล่าแบบมุมมองบุรุษที่สอง ("คุณ...") ครั้งละ 2-5 ย่อหน้าสั้น กระชับ มีบรรยากาศ ไม่ยืดเยื้อ',
      "- ตอบเป็นภาษาเดียวกับที่ผู้เล่นพิมพ์มา (พิมพ์ไทยตอบไทย)",
      "- " + (MODE_RULES[state.mode] || MODE_RULES.rpg),
      "- จบทุกครั้งด้วยสถานการณ์ที่ผู้เล่นต้องตัดสินใจต่อ ห้ามเล่าแทนหรือเดาการกระทำของผู้เล่นเอง",
      "- คุณจะได้รับบทสรุปเนื้อเรื่องเก่า (ความจำระยะยาว) และสถานะโลก/ตัวละครล่าสุด ต้องยึดข้อมูลเหล่านี้เป็นความจริง ห้ามขัดแย้ง",
      "- HP ห้ามต่ำกว่า 0 หรือเกิน maxHp ถ้า HP ถึง 0 ให้บรรยายภาวะวิกฤต/หมดสติ/ต้องพักฟื้น แต่ห้ามจบเกม (ไม่มี permadeath)",
      "",
      "รูปแบบคำตอบ (สำคัญมาก):",
      "- เล่าเรื่องก่อน จากนั้นขึ้นบรรทัดใหม่แล้วพิมพ์ <<STATE>> ตามด้วย JSON บรรทัดเดียว ห้ามใส่ markdown fence",
      '- JSON ต้องมีคีย์ครบเสมอ: {"hp":number,"maxHp":number,"level":number,"xp":number,"skills":string[],"inventory":string[],"location":string,"npcs":string[],"flags":string[]}',
      '- npcs: ตัวละครสำคัญที่เจอแล้ว รูปแบบ "ชื่อ — ความสัมพันธ์/สถานะล่าสุด" อัปเดตทับของเดิม ไม่ซ้ำรายการ',
      "- flags: เหตุการณ์/การตัดสินใจที่ยังมีผลต่อเนื้อเรื่อง สั้นๆ ไม่เกิน 15 รายการ ตัดที่หมดความสำคัญออกได้",
      "- ต้องส่งค่าปัจจุบันครบทุกฟิลด์เสมอ แม้ไม่มีอะไรเปลี่ยน",
      "- ห้ามพิมพ์อะไรต่อหลัง JSON",
      "- ห้ามตอบว่างเปล่า ต้องมีเนื้อเรื่องก่อน <<STATE>> เสมอ",
    ].join("\n");
  }

  function worldSnapshot() {
    return {
      character: state.name + (state.charDesc ? " — " + state.charDesc : ""),
      world: state.world || "(ไม่ระบุ — สร้างสรรค์ได้เอง)",
      mode: state.mode,
      hp: state.hp, maxHp: state.maxHp, level: state.level, xp: state.xp,
      skills: state.skills, inventory: state.inventory,
      location: state.location, npcs: state.npcs, flags: state.flags,
    };
  }

  function chaptersText() {
    if (!state.chapters.length) return "(ยังไม่มีบทสรุปก่อนหน้า — นี่คือช่วงต้นเรื่อง)";
    return state.chapters.map(c => "[" + (c.label || ("ตอนที่ " + c.index)) + "] " + c.summary).join("\n");
  }

  function memoryHeader() {
    return "[บทสรุปเนื้อเรื่องที่ผ่านมา — ความจำระยะยาว]\n" + chaptersText() +
      "\n\n[สถานะโลก/ตัวละครล่าสุด]\n" + JSON.stringify(worldSnapshot());
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

    const bubble = document.createElement("div");
    bubble.className = "msg ai streaming";
    bubble.textContent = "…";
    $("log").appendChild(bubble);
    scrollLog();

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
          bubble.textContent = t.split("<<STATE>>")[0];
          scrollLog();
        },
      });

      const parts = res.text.split("<<STATE>>");
      const narrative = (parts[0] || "").trim();

      // BUG #3 fix: an empty narrative is never accepted and never stored.
      if (!narrative) throw apiErr("empty", "AI ตอบมาแต่ไม่มีเนื้อเรื่อง — กดลองใหม่");

      bubble.classList.remove("streaming");
      bubble.textContent = narrative;

      if (parts[1]) applyStatePatch(parts[1]);

      // BUG #4 fix: the player's turn is committed to memory only here,
      // after a confirmed good reply. A failed turn leaves nothing behind.
      state.ctx.push({ role: "user", content: sentAction });
      state.ctx.push({ role: "assistant", content: narrative });
      if (opts.isOpening) {
        pushLog("sys", "✨ เริ่มการผจญภัย");
      } else {
        if (roll !== null) pushLog("dice", "🎲 d20 = " + roll);
        pushLog("user", rawAction);
      }
      pushLog("assistant", narrative);
      state.lastAction = opts.isOpening ? null : rawAction;
      ok = true;

      updateHeader();
      renderDrawer();
      await persist(true);
      await maybeCompress();
    } catch (e) {
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
    }
    return ok;
  }

  function applyStatePatch(jsonText) {
    let raw = String(jsonText).trim()
      .replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    // tolerate trailing prose after the object
    const first = raw.indexOf("{");
    if (first > 0) raw = raw.slice(first);
    let depth = 0, end = -1;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === "{") depth++;
      else if (raw[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end > -1) raw = raw.slice(0, end + 1);

    let p;
    try { p = JSON.parse(raw); } catch (e) { console.warn("STATE JSON ไม่ถูกต้อง:", e); return; }

    const n = (v, f) => (typeof v === "number" && isFinite(v)) ? v : f;
    state.maxHp = Math.max(1, n(p.maxHp, state.maxHp));
    state.hp = Math.max(0, Math.min(state.maxHp, n(p.hp, state.hp)));
    state.level = Math.max(1, n(p.level, state.level));
    state.xp = Math.max(0, n(p.xp, state.xp));
    const strArr = (v) => Array.isArray(v) ? v.map(x => String(x)).filter(Boolean).slice(0, 40) : null;
    const sk = strArr(p.skills); if (sk) state.skills = sk;
    const iv = strArr(p.inventory); if (iv) state.inventory = iv;
    const np = strArr(p.npcs); if (np) state.npcs = np;
    const fl = strArr(p.flags); if (fl) state.flags = fl.slice(0, 20);
    if (typeof p.location === "string") state.location = p.location;
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
  function scrollLog() {
    const l = $("log");
    l.scrollTop = l.scrollHeight;
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
    $("log").appendChild(el); scrollLog();
    return el;
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
    $("headerHp").textContent = "❤️ " + state.hp + "/" + state.maxHp + " · Lv." + state.level;
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
    $("modeView").textContent = { rpg: "RPG", story: "Story", dnd: "D&D" }[state.mode] || state.mode;
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
    $("locationText").textContent = state.location || "-";
    $("npcsText").innerHTML = state.npcs.length ? state.npcs.map(esc).join("<br>") : '<span class="dim">-</span>';
    $("flagsText").innerHTML = state.flags.length ? state.flags.map(f => "• " + esc(f)).join("<br>") : '<span class="dim">-</span>';
    $("memStat").innerHTML =
      "บทสรุปสะสม <b>" + state.chapters.length + "</b> ตอน · บทสนทนาสด <b>" + state.ctx.length + "</b> ข้อความ<br>" +
      "ขนาดเซฟ <b>" + fmtBytes(memSize()) + "</b> · ขนาด prompt/เทิร์น <b>" + fmtBytes(promptSize()) + "</b><br>" +
      "ประวัติทั้งหมด <b>" + state.log.length + "</b> รายการ";
  }

  const RENDER_WINDOW = 120;
  let renderFrom = 0;

  function renderAll(showAll) {
    const l = $("log");
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
      el.textContent = m.content;
      l.appendChild(el);
    }
    updateHeader();
    renderDrawer();
    if (!showAll) scrollLog();
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

  function bindSetup() {
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
      });
      show("game");
      $("log").innerHTML = "";
      await persist(true);
      const ok = await takeTurn(
        "(เริ่มต้นการผจญภัย — เขียนฉากเปิดเรื่อง 2-4 ย่อหน้า แนะนำโลกและสถานการณ์เริ่มต้นของตัวละคร จบด้วยสถานการณ์ที่ต้องตัดสินใจ)",
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
    document.querySelectorAll("#chips button").forEach(b => {
      b.onclick = () => { $("actionInput").value = b.dataset.a; send(); };
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
      toast("เปลี่ยนโหมดเป็น " + state.mode.toUpperCase() + " แล้ว");
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
    $("seLocation").value = state.location || "";
    $("seSkills").value = state.skills.join("\n");
    $("seInv").value = state.inventory.join("\n");
    $("seNpcs").value = state.npcs.join("\n");
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
      state.location = $("seLocation").value.trim();
      state.skills = linesToArr($("seSkills").value);
      state.inventory = linesToArr($("seInv").value);
      state.npcs = linesToArr($("seNpcs").value);
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

  // ---------- Export ----------
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
      else if (m.role === "assistant") lines.push(m.content, "");
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
        '<div class="dim">' + esc((s.mode || "rpg").toUpperCase()) + " · Lv." + (s.level || 1) +
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
    const savedList = await getSetting("modelList", null);
    if (Array.isArray(savedList) && savedList.length) modelList = savedList;

    bindSetup(); bindInput(); bindDrawer(); bindTurnTools();
    bindStateEditor(); bindChapters(); bindExport(); bindSlots(); bindSettings();

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
