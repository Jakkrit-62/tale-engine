/* Tale Engine service worker — app-shell cache only.
 * Gemini / translation calls are NEVER cached (cross-origin, not touched).
 *
 * Cache-first: the app opens from this device instantly, even on a bad
 * connection. It used to be network-first with no timeout, so a slow or
 * half-dead mobile connection left the boot spinner turning forever.
 *
 * Updates: after each launch the shell is re-downloaded in the background
 * (bypassing the browser's HTTP cache — GitHub Pages sends max-age=600).
 * Only when EVERY file downloaded fine and something changed is the whole
 * set written, and the page is told a new version is ready. The files
 * are always swapped together, so a new app.js never runs against an old
 * index.html (that mismatch crashed boot and hid the new buttons).
 * No need to bump anything on deploy; bump CACHE only to force a reset.
 */
const CACHE = "tale-engine-shell-v10";
const SHELL = [
  "./index.html", "./styles.css", "./app.js", "./qidian-mode/qidian.js", "./manifest.json",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-maskable-512.png"
];
const CHECK_EVERY = 10 * 1000;   // at most one background check per 10 s
const TIMEOUT = 20 * 1000;       // a dead connection must not stall checks forever
let lastCheck = 0;
let checking = null;

const abs = (u) => new URL(u, self.registration.scope).href;

async function download() {
  const got = await Promise.all(SHELL.map(async (u) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT);
    try {
      const res = await fetch(new Request(abs(u), { cache: "no-store" }), { signal: ctl.signal });
      if (!res.ok) throw new Error(u + " → HTTP " + res.status);
      // read the body inside the timeout too — a stall mid-download counts
      const body = await res.arrayBuffer();
      return [u, new Response(body, { status: 200, headers: { "Content-Type": res.headers.get("Content-Type") || "" } })];
    } finally { clearTimeout(timer); }
  }));
  return got;
}

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const files = await download();
    const c = await caches.open(CACHE);
    for (const [u, res] of files) await c.put(abs(u), res);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Re-download the shell; swap it in only if all of it arrived and it differs.
async function refresh() {
  const files = await download();
  const c = await caches.open(CACHE);
  const fresh = [];
  let changed = false;
  for (const [u, res] of files) {
    const body = await res.clone().arrayBuffer();
    fresh.push([u, res]);
    if (changed) continue;
    const old = await c.match(abs(u));
    if (!old) { changed = true; continue; }
    const ob = new Uint8Array(await old.arrayBuffer()), nb = new Uint8Array(body);
    if (ob.length !== nb.length || ob.some((b, i) => b !== nb[i])) changed = true;
  }
  if (!changed) return false;
  for (const [u, res] of fresh) await c.put(abs(u), res);
  const wins = await self.clients.matchAll({ type: "window" });
  for (const w of wins) w.postMessage({ type: "tale-updated" });
  return true;
}

function backgroundCheck() {
  if (checking || Date.now() - lastCheck < CHECK_EVERY) return checking || Promise.resolve();
  lastCheck = Date.now();
  checking = refresh().catch(() => { }).finally(() => { checking = null; });
  return checking;
}

self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "tale-check") { lastCheck = 0; e.waitUntil(backgroundCheck()); }
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const isNav = req.mode === "navigate";
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = isNav
      ? await c.match(abs("./index.html"))
      : await c.match(req, { ignoreSearch: true });
    if (hit) {
      if (isNav) e.waitUntil(backgroundCheck());
      return hit;
    }
    // not cached (first visit before install finished, or an extra file)
    try {
      return await fetch(req);
    } catch (err) {
      return (await c.match(abs("./index.html"))) || Response.error();
    }
  })());
});
