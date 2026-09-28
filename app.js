(() => {
  "use strict";
  const MIN = 60000, DAY = 86400000, NEW_PER_SESSION = 20, MATURE = 21;
  const $ = s => document.querySelector(s);
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  };

  /* ================= data ================= */
  const decks = new Map();       // id -> {name, parent?, created}
  const content = new Map();     // id -> card content from cartes.json
  const cards = new Map();       // id -> content + progress (what the UI reads)
  let progress = LS.get("cdl-progress", {});   // id -> {state,due,interval,ease,step,reps,lapses,seen,hits,t}
  let progressDirty = LS.get("cdl-progress-dirty", false);
  const blobUrls = {};           // freshly uploaded image path -> object URL (Pages rebuild lag)

  const DEFAULT_P = { state: "new", due: 0, interval: 0, ease: 2.5, step: 0, reps: 0, lapses: 0, seen: 0, hits: 0 };
  function rebuild() {
    cards.clear();
    for (const [id, c] of content) cards.set(id, { ...DEFAULT_P, due: c.created || 0, ...c, ...(progress[id] || {}), id });
  }
  function applyData(json) {
    decks.clear(); content.clear();
    for (const d of json.decks || []) if (d && d.id) decks.set(d.id, { name: d.name, parent: d.parent, created: d.created });
    for (const c of json.cards || []) if (c && c.id) content.set(c.id, c);
    rebuild();
  }

  /* ================= GitHub ================= */
  function guessRepo() {
    const h = location.hostname, m = h.match(/^([a-z0-9-]+)\.github\.io$/i);
    if (!m) return { owner: "", repo: "" };
    const seg = location.pathname.split("/").filter(Boolean)[0];
    return { owner: m[1], repo: seg && !seg.includes(".") ? seg : `${m[1]}.github.io` };
  }
  let gh = { ...guessRepo(), branch: "main", token: "", ...LS.get("cdl-github", {}) };
  const canWrite = () => !!(gh.token && gh.owner && gh.repo);
  const b64FromBytes = bytes => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
  const bytesFromB64 = b64 => { const s = atob(b64.replace(/\s/g, "")); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
  const enc = new TextEncoder(), dec = new TextDecoder();

  async function api(path, opts = {}) {
    const r = await fetch(`https://api.github.com/repos/${gh.owner}/${gh.repo}/${path}`, {
      ...opts,
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${gh.token}`, "X-GitHub-Api-Version": "2022-11-28", ...(opts.headers || {}) },
      cache: "no-store",
    });
    if (!r.ok) { let msg = ""; try { msg = (await r.json()).message || ""; } catch {} throw { status: r.status, message: msg }; }
    return r.status === 204 ? null : r.json();
  }
  async function ghGetFile(path) {
    try {
      const j = await api(`contents/${path}?ref=${encodeURIComponent(gh.branch)}`);
      let bytes;
      if (j.content && j.encoding === "base64") bytes = bytesFromB64(j.content);
      else { const b = await api(`git/blobs/${j.sha}`); bytes = bytesFromB64(b.content); }
      return { sha: j.sha, text: dec.decode(bytes) };
    } catch (e) { if (e.status === 404) return { sha: null, text: null }; throw e; }
  }
  const ghPut = (path, b64, sha, message) => api(`contents/${path}`, { method: "PUT", body: JSON.stringify({ message, content: b64, branch: gh.branch, ...(sha ? { sha } : {}) }) });
  async function ghDelete(path, message) {
    try { const j = await api(`contents/${path}?ref=${encodeURIComponent(gh.branch)}`); await api(`contents/${path}`, { method: "DELETE", body: JSON.stringify({ message, sha: j.sha, branch: gh.branch }) }); }
    catch (e) { if (e.status !== 404) throw e; }
  }
  const ghErr = e => {
    if (!e) return "erreur inconnue";
    if (e.code === "no_token") return "connecte GitHub dans Réglages pour modifier les cartes";
    if (e.status === 401) return "token GitHub refusé (expiré ou mal copié) — vérifie dans Réglages";
    if (e.status === 403) return "le token n'a pas le droit d'écrire sur ce dépôt (permission Contents : Read and write)";
    if (e.status === 404) return "dépôt introuvable — vérifie le nom dans Réglages";
    if (e.status === 409 || e.status === 422) return "conflit de version, réessaie";
    if (e instanceof TypeError || e.name === "TypeError") return "pas de connexion internet";
    return e.message || ("erreur " + (e.status || ""));
  };

  // Every card/deck change: read the latest cartes.json, apply the change, write it back.
  async function commit(message, mutate) {
    if (!canWrite()) throw { code: "no_token" };
    for (let attempt = 0; attempt < 3; attempt++) {
      const f = await ghGetFile("cartes.json");
      const json = f.text ? JSON.parse(f.text) : { version: 1, decks: [], cards: [] };
      json.decks ||= []; json.cards ||= [];
      mutate(json);
      json.updated = Date.now();
      try {
        await ghPut("cartes.json", b64FromBytes(enc.encode(JSON.stringify(json, null, 1))), f.sha, message);
        applyData(json); LS.set("cdl-cache", json); setSync("ok");
        return json;
      } catch (e) { if ((e.status === 409 || e.status === 422) && attempt < 2) continue; throw e; }
    }
  }

  /* ================= load & sync ================= */
  let syncState = "idle";
  function setSync(s) { syncState = s; const el = $("#sync"); if (!el) return;
    const map = { ok: ["À jour", "ok"], loading: ["Synchro…", ""], offline: ["Hors ligne", "warn"], local: ["Lecture seule", ""], err: ["Erreur de synchro", "warn"], idle: ["", ""] };
    const [t, k] = map[s] || map.idle; el.textContent = t; el.className = "sync " + k; el.hidden = !t; }

  async function loadCards() {
    setSync("loading");
    try {
      let json;
      if (canWrite()) { const f = await ghGetFile("cartes.json"); json = f.text ? JSON.parse(f.text) : { decks: [], cards: [] }; }
      else { const r = await fetch("cartes.json?t=" + Date.now(), { cache: "no-store" }); if (!r.ok) throw { status: r.status }; json = await r.json(); }
      const cached = LS.get("cdl-cache", null);
      if (cached && (cached.updated || 0) > (json.updated || 0)) json = cached; // Pages can lag behind a fresh write
      applyData(json); LS.set("cdl-cache", json);
      setSync(canWrite() ? "ok" : "local");
    } catch (e) {
      const cached = LS.get("cdl-cache", null);
      if (cached) applyData(cached);
      setSync(e && e.status ? "err" : "offline");
      if (e && e.status && canWrite()) banner("Impossible de lire les cartes sur GitHub : " + ghErr(e) + ".");
    }
    await pullProgress();
    loaded = true; render();
  }

  // Progress backup on GitHub (progression.json): newest review per card wins.
  function mergeProgress(remote) {
    let changed = false;
    for (const [id, p] of Object.entries(remote || {})) {
      const mine = progress[id];
      if (!mine || (p.t || 0) > (mine.t || 0)) { progress[id] = p; changed = true; }
    }
    return changed;
  }
  async function pullProgress() {
    if (!canWrite()) return;
    try {
      const f = await ghGetFile("progression.json");
      if (f.text && mergeProgress(JSON.parse(f.text).progress)) { LS.set("cdl-progress", progress); rebuild(); }
    } catch {}
  }
  let pushing = false;
  async function pushProgress() {
    if (!canWrite() || !progressDirty || pushing) return;
    pushing = true;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const f = await ghGetFile("progression.json");
        if (f.text) mergeProgress(JSON.parse(f.text).progress);
        const body = { updated: Date.now(), progress };
        try { await ghPut("progression.json", b64FromBytes(enc.encode(JSON.stringify(body))), f.sha, "Progression"); break; }
        catch (e) { if ((e.status === 409 || e.status === 422) && attempt < 2) continue; throw e; }
      }
      progressDirty = false; LS.set("cdl-progress-dirty", false); LS.set("cdl-progress", progress);
    } catch {} finally { pushing = false; }
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") pushProgress(); else if (loaded && !session) loadCards(); });

  /* ================= text ================= */
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const fmt = s => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/_\{([^}]*)\}/g, "<sub>$1</sub>").replace(/\^\{([^}]*)\}/g, "<sup>$1</sup>").replace(/\n/g, "<br>");
  const human = ms => {
    if (ms < 60*MIN) return Math.max(1, Math.round(ms/MIN)) + " min";
    if (ms < DAY) return Math.round(ms/(60*MIN)) + " h";
    const d = ms/DAY;
    if (d < 30) return Math.round(d) + " j";
    if (d < 365) return Math.round(d/30) + " mois";
    return (d/365).toFixed(1).replace(".0","").replace(".",",") + " an";
  };
  const imgSrc = p => { if (!p || !/^images\/[A-Za-z0-9._-]+$/.test(p)) return ""; return blobUrls[p] || p; };
  const imgTag = (p, cls, alt) => { const u = imgSrc(p); return u ? `<img class="${cls}" src="${esc(u)}" alt="${esc(alt)}" loading="lazy">` : ""; };

  /* ================= scheduling ================= */
  function schedule(c, r, now) {
    let state = c.state || "new", interval = c.interval || 0, ease = c.ease || 2.5, step = c.step || 0, reps = c.reps || 0, lapses = c.lapses || 0, due;
    if (state === "new" || state === "learning") {
      if (r === 1) { state = "learning"; step = 0; due = now + MIN; }
      else if (r === 2) { state = "learning"; due = now + 6*MIN; }
      else if (r === 3) { if (step >= 1) { state = "review"; interval = 1; due = now + DAY; } else { state = "learning"; step = 1; due = now + 10*MIN; } }
      else { state = "review"; interval = 4; due = now + 4*DAY; }
    } else if (state === "relearn") {
      if (r <= 2) due = now + 10*MIN; else { state = "review"; if (r === 4) interval += 1; due = now + interval*DAY; }
    } else {
      if (r === 1) { lapses++; ease = Math.max(1.3, ease - 0.2); interval = Math.max(1, Math.round(interval*0.5)); state = "relearn"; due = now + 10*MIN; }
      else if (r === 2) { ease = Math.max(1.3, ease - 0.15); interval = Math.max(interval+1, Math.round(interval*1.2)); due = now + interval*DAY; }
      else if (r === 3) { interval = Math.max(interval+1, Math.round(interval*ease)); due = now + interval*DAY; }
      else { ease += 0.15; interval = Math.max(interval+1, Math.round(interval*ease*1.3)); due = now + interval*DAY; }
    }
    return { state, interval, ease: Math.round(ease*100)/100, step, reps: reps+1, lapses, due };
  }
  const isNew = c => (c.state || "new") === "new";
  const isDue = (c, now) => !isNew(c) && (c.due || 0) <= now;
  const isLearning = c => c.state === "learning" || c.state === "relearn";

  /* ================= deck tree ================= */
  const sortedDecks = () => [...decks.entries()].sort((a,b) => (a[1].name||"").localeCompare(b[1].name||"", "fr"));
  const parentOf = id => { const p = decks.get(id)?.parent; return p && decks.has(p) && p !== id ? p : null; };
  const childrenOf = pid => sortedDecks().filter(([id]) => parentOf(id) === pid);
  function deckTree() { const out = [], seen = new Set();
    const walk = (pid, depth) => { for (const [id, d] of childrenOf(pid)) { if (seen.has(id)) continue; seen.add(id); out.push([id, d, depth]); walk(id, depth + 1); } };
    walk(null, 0); return out; }
  function subtree(id) { const s = new Set([id]); let grew = true;
    while (grew) { grew = false; for (const k of decks.keys()) { const p = parentOf(k); if (!s.has(k) && p && s.has(p)) { s.add(k); grew = true; } } } return s; }
  const deckPath = id => { const parts = []; let cur = id, g = 0; while (cur && decks.has(cur) && g++ < 12) { parts.unshift(decks.get(cur).name); cur = parentOf(cur); } return parts.join(" › "); };
  const deckCards = id => { if (id == null) return [...cards.values()]; const s = subtree(id); return [...cards.values()].filter(c => s.has(c.deck)); };
  const countsOf = id => { const now = Date.now(), list = deckCards(id); return { total: list.length, nw: list.filter(isNew).length, due: list.filter(c => isDue(c, now)).length }; };
  const slugify = (name, taken) => { const base = name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,40) || "paquet"; let id = base, i = 2; while (taken(id)) id = base + "-" + i++; return id; };
  const newId = prefix => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2,6)}`;

  /* ================= views ================= */
  let view = "home", session = null, waitTimer = null, loaded = false;
  function show(v) {
    if (view === "study" && v !== "study") pushProgress();
    view = v;
    for (const s of ["home","study","add","browse","settings"]) $("#view-"+s).hidden = s !== v;
    document.querySelectorAll("nav.tabs button").forEach(b => {
      const active = b.dataset.view === v || (v === "study" && b.dataset.view === "home");
      if (active) b.setAttribute("aria-current","page"); else b.removeAttribute("aria-current");
    });
    if (v !== "study") { session = null; clearTimeout(waitTimer); }
    render();
  }
  document.querySelectorAll("nav.tabs button").forEach(b => b.addEventListener("click", () => show(b.dataset.view)));
  function render() {
    if (view === "home") renderHome(); else if (view === "study") renderStudy();
    else if (view === "add") renderAdd(); else if (view === "browse") renderBrowse(); else if (view === "settings") renderSettings();
  }
  const writeGate = () => canWrite() ? "" : `<div class="gate">Pour ajouter ou modifier des cartes depuis ce téléphone, <button class="linkbtn" data-goto="settings">connecte GitHub dans Réglages</button>.</div>`;
  document.addEventListener("click", e => { const g = e.target.closest("[data-goto]"); if (g) show(g.dataset.goto); });

  /* ================= mastery ================= */
  const LEVELS = [{ key: "new", label: "Jamais vues" }, { key: "learn", label: "En apprentissage" }, { key: "young", label: "En cours" }, { key: "done", label: "Maîtrisées" }];
  const levelOf = c => isNew(c) ? "new" : isLearning(c) ? "learn" : (c.interval || 0) >= MATURE ? "done" : "young";
  const cardScore = c => { const l = levelOf(c); return l === "new" ? 0 : l === "learn" ? 0.15 : l === "done" ? 1 : 0.3 + 0.7 * Math.min(1, (c.interval || 0) / MATURE); };
  function masteryOf(id) {
    const list = deckCards(id), now = Date.now(), n = { new: 0, learn: 0, young: 0, done: 0 };
    let score = 0, seen = 0, hits = 0, tomorrow = 0, week = 0;
    const endTomorrow = new Date(); endTomorrow.setHours(47, 59, 59, 999);
    for (const c of list) { n[levelOf(c)]++; score += cardScore(c); seen += c.seen || 0; hits += c.hits || 0;
      if (!isNew(c) && c.due > now) { if (c.due <= endTomorrow.getTime()) tomorrow++; if (c.due <= now + 7*DAY) week++; } }
    const weak = list.filter(c => (c.seen||0) - (c.hits||0) > 0).sort((a,b) => ((b.seen-b.hits) - (a.seen-a.hits)) || ((a.ease||2.5) - (b.ease||2.5))).slice(0, 5);
    return { total: list.length, n, pct: list.length ? Math.round(100 * score / list.length) : 0, rate: seen ? Math.round(100 * hits / seen) : null, seen, tomorrow, week, weak };
  }
  function masteryBar(m) {
    if (!m.total) return `<div class="mbar"></div>`;
    return `<div class="mbar" role="img" aria-label="${LEVELS.map(l => `${m.n[l.key]} ${l.label.toLowerCase()}`).join(", ")}">` +
      LEVELS.filter(l => m.n[l.key]).map(l => `<span class="seg s-${l.key}" style="flex-grow:${m.n[l.key]}" title="${l.label} : ${m.n[l.key]}"></span>`).join("") + `</div>`;
  }

  /* ================= home ================= */
  const openDetails = new Set(), folded = new Set(), deleting = new Set();
  let armedHomeDel = null, armedTimer = null;
  function renderHome() {
    const all = countsOf(null);
    $("#t-due").textContent = all.due; $("#t-new").textContent = all.nw; $("#t-total").textContent = all.total;
    $("#t-pct").textContent = all.total ? masteryOf(null).pct + " %" : "–";
    $("#study-all").disabled = !(all.due || all.nw);
    fillDeckSelect($("#newdeck-parent"), "Paquet principal");
    $("#newdeck-form").hidden = !canWrite();
    $("#home-gate").innerHTML = loaded && !canWrite() ? writeGate() : "";
    const el = $("#decks");
    if (!loaded) return;
    if (!decks.size) { el.innerHTML = `<div class="empty">Aucun paquet pour l'instant. ${canWrite() ? "Crée-en un ci-dessous ou demande à Claude d'en remplir un." : ""}</div>`; return; }
    const hiddenByFold = id => { let p = parentOf(id), g = 0; while (p && g++ < 12) { if (folded.has(p)) return true; p = parentOf(p); } return false; };
    el.innerHTML = deckTree().filter(([id]) => !hiddenByFold(id)).map(([id, d, depth]) => {
      const c = countsOf(id), m = masteryOf(id), open = openDetails.has(id), kids = childrenOf(id).length;
      let details = "";
      if (open) details = `<div class="details">
          <div class="legend">${LEVELS.map(l => `<div class="lg"><span class="sw s-${l.key}"></span><span>${l.label}</span><b class="mono">${m.n[l.key]}</b></div>`).join("")}</div>
          <div class="kpis">
            <div><div class="kv mono">${m.rate == null ? "–" : m.rate + " %"}</div><div class="label">réussite${m.seen ? ` · ${m.seen} réponses` : ""}</div></div>
            <div><div class="kv mono">${m.tomorrow}</div><div class="label">à revoir d'ici demain soir</div></div>
            <div><div class="kv mono">${m.week}</div><div class="label">sur 7 jours</div></div>
          </div>
          ${m.weak.length ? `<div><div class="label" style="margin-bottom:6px">Points faibles</div><ul class="weak">${m.weak.map(w => `<li><span>${fmt(w.front)}</span><span class="mono miss">ratée ${w.seen - w.hits}×</span></li>`).join("")}</ul></div>`
            : `<p class="hint">${m.seen ? "Aucune carte ratée pour l'instant 👌" : "Les points faibles apparaîtront après tes premières révisions."}</p>`}
        </div>`;
      const fold = kids ? `<button class="linkbtn fold" data-fold="${esc(id)}" aria-expanded="${!folded.has(id)}">${folded.has(id) ? "▸" : "▾"} ${kids} sous-paquet${kids>1?"s":""}</button>` : "";
      const nSub = subtree(id).size - 1;
      const confirm = armedHomeDel === id ? `<div class="confirm" role="alert">
          <span>Supprimer <b>${esc(d.name)}</b>${nSub ? `, ses ${nSub} sous-paquet${nSub>1?"s":""}` : ""} et ${c.total} carte${c.total>1?"s":""} ? Ta progression sur ces cartes sera perdue.</span>
          <span class="row"><button class="btn danger armed" data-hdel-ok="${esc(id)}">Supprimer définitivement</button><button class="btn ghost" data-hdel-no>Annuler</button></span></div>` : "";
      return `<div class="deck${depth ? " sub" : ""}" style="--depth:${depth}"><div class="deck-main"><div class="deck-title"><h3>${depth ? `<span class="twig" aria-hidden="true">↳</span>` : ""}${esc(d.name)}</h3><span class="pct mono">${m.pct} %<span class="label"> maîtrise</span></span></div>
        ${masteryBar(m)}
        <div class="counts"><span class="c-due">${c.due} à revoir</span><span class="c-new">${c.nw} nouvelles</span><span class="muted">${c.total} au total</span>${fold}
          <button class="linkbtn" data-details="${esc(id)}" aria-expanded="${open}">${open ? "Masquer l'analyse" : "Voir l'analyse"}</button>
          ${canWrite() ? `<button class="linkbtn delbtn" data-hdel="${esc(id)}" ${deleting.has(id) ? "disabled" : ""}>${deleting.has(id) ? "Suppression…" : "Supprimer"}</button>` : ""}</div>
        ${confirm}${details}</div>
        <button class="btn ${c.due||c.nw ? "primary":""}" data-study="${esc(id)}" ${c.due||c.nw ? "" : "disabled"}>${c.due||c.nw ? "Réviser" : "À jour ✓"}</button></div>`;
    }).join("");
  }
  $("#decks").addEventListener("click", e => {
    const b = e.target.closest("[data-study]"); if (b) return startStudy(b.dataset.study);
    const ok = e.target.closest("[data-hdel-ok]"); if (ok) { armedHomeDel = null; clearTimeout(armedTimer); return deleteDeck(ok.dataset.hdelOk); }
    if (e.target.closest("[data-hdel-no]")) { armedHomeDel = null; return renderHome(); }
    const hd = e.target.closest("[data-hdel]"); if (hd) { armedHomeDel = hd.dataset.hdel; clearTimeout(armedTimer); armedTimer = setTimeout(() => { armedHomeDel = null; renderHome(); }, 15000); return renderHome(); }
    const f = e.target.closest("[data-fold]"); if (f) { const id = f.dataset.fold; folded.has(id) ? folded.delete(id) : folded.add(id); return renderHome(); }
    const d = e.target.closest("[data-details]"); if (d) { const id = d.dataset.details; openDetails.has(id) ? openDetails.delete(id) : openDetails.add(id); renderHome(); }
  });
  $("#study-all").addEventListener("click", () => startStudy(null));
  $("#newdeck-form").addEventListener("submit", async e => {
    e.preventDefault();
    const name = $("#newdeck-name").value.trim(), parent = $("#newdeck-parent").value; if (!name) return;
    const btn = $("#newdeck-form button"); btn.disabled = true;
    try {
      await commit(`Nouveau paquet : ${name}`, json => {
        const id = slugify(name, x => json.decks.some(d => d.id === x));
        json.decks.push({ id, name, created: Date.now(), ...(parent ? { parent } : {}) });
      });
      $("#newdeck-name").value = ""; if (parent) folded.delete(parent);
    } catch (err) { banner("Le paquet n'a pas pu être créé : " + ghErr(err) + "."); }
    btn.disabled = false; render();
  });

  /* ================= study ================= */
  function startStudy(deck) { session = { deck, newSeen: 0, reviewed: 0, current: null, revealed: false }; show("study"); }
  function pickNext() {
    const now = Date.now(), list = deckCards(session.deck);
    const due = list.filter(c => isDue(c, now)).sort((a,b) => a.due - b.due);
    if (due.length) return due[0];
    if (session.newSeen < NEW_PER_SESSION) { const nw = list.filter(isNew).sort((a,b) => (a.created||0) - (b.created||0)); if (nw.length) return nw[0]; }
    return null;
  }
  function renderStudy() {
    if (!session) return;
    const body = $("#study-body"), now = Date.now(), list = deckCards(session.deck);
    const due = list.filter(c => isDue(c, now)).length, nw = Math.min(list.filter(isNew).length, NEW_PER_SESSION - session.newSeen);
    const name = session.deck ? (deckPath(session.deck) || "Paquet") : "Tous les paquets";
    $("#study-progress").innerHTML = `<span class="muted">${esc(name)}</span><span class="c-due">${due} à revoir</span><span class="c-new">${Math.max(0,nw)} nouv.</span><span class="muted">${session.reviewed} faites</span>`;
    if (session.current && !cards.has(session.current.id)) session.current = null;
    if (!session.current) { session.current = pickNext(); session.revealed = false; }
    const c = session.current ? cards.get(session.current.id) || session.current : null;
    clearTimeout(waitTimer);
    if (!c) {
      const pending = list.filter(x => isLearning(x) && x.due > now).sort((a,b) => a.due - b.due);
      if (pending.length) {
        const wait = pending[0].due - now;
        body.innerHTML = `<div class="done"><h2>Petite pause</h2><p class="muted">Prochaine carte en apprentissage dans <b>${human(wait)}</b>. Elle s'affichera ici automatiquement.</p><div><button class="btn" id="study-home">Retour aux paquets</button></div></div>`;
        waitTimer = setTimeout(renderStudy, Math.min(wait + 500, 30000));
      } else {
        body.innerHTML = `<div class="done"><h2>Séance terminée</h2><p class="muted">${session.reviewed} carte${session.reviewed>1?"s":""} révisée${session.reviewed>1?"s":""}. Rien d'autre à revoir pour l'instant — reviens demain.</p><div><button class="btn primary" id="study-home">Retour aux paquets</button></div></div>`;
        pushProgress();
      }
      $("#study-home").addEventListener("click", () => show("home"));
      return;
    }
    const deckName = session.deck === c.deck ? "" : `<span class="label">${esc(deckPath(c.deck))}</span>`;
    let html = `<article class="card" aria-live="polite">${deckName}<div class="q">${fmt(c.front)}${imgTag(c.frontImg, "cimg", "Image de la question")}</div>`;
    if (session.revealed) html += `<div class="a">${fmt(c.back)}${imgTag(c.backImg, "cimg", "Image de la réponse")}</div>`;
    html += `</article>`;
    if (!session.revealed) html += `<button class="btn primary reveal" id="reveal">Afficher la réponse</button>`;
    else html += `<div class="grades">` + ["À revoir","Difficile","Bien","Facile"].map((l,i) => { const s = schedule(c, i+1, now);
        return `<button class="grade g${i+1}" data-r="${i+1}">${l}<small>${human(s.due - now)}</small><kbd>${i+1}</kbd></button>`; }).join("") + `</div>`;
    body.innerHTML = html;
    const rv = $("#reveal"); if (rv) { rv.addEventListener("click", reveal); rv.focus({ preventScroll: true }); }
  }
  function reveal() { if (session && session.current && !session.revealed) { session.revealed = true; renderStudy(); } }
  function rate(r) {
    if (!session || !session.current || !session.revealed) return;
    const c = cards.get(session.current.id); if (!c) return;
    const upd = schedule(c, r, Date.now());
    upd.seen = (c.seen || 0) + 1; upd.hits = (c.hits || 0) + (r >= 3 ? 1 : 0); upd.t = Date.now();
    if (isNew(c)) session.newSeen++;
    session.reviewed++;
    progress[c.id] = upd; LS.set("cdl-progress", progress);
    progressDirty = true; LS.set("cdl-progress-dirty", true);
    cards.set(c.id, { ...c, ...upd });
    session.current = null;
    if (session.reviewed % 15 === 0) pushProgress();
    renderStudy();
  }
  $("#study-body").addEventListener("click", e => { const g = e.target.closest("[data-r]"); if (g) rate(+g.dataset.r); });
  $("#study-back").addEventListener("click", () => show("home"));
  document.addEventListener("keydown", e => {
    if (view !== "study" || !session || e.target.matches("input,textarea,select")) return;
    if ((e.key === " " || e.key === "Enter") && !session.revealed) { e.preventDefault(); reveal(); }
    else if (session.revealed && ["1","2","3","4"].includes(e.key)) { e.preventDefault(); rate(+e.key); }
  });

  /* ================= selects ================= */
  function fillDeckSelect(sel, emptyLabel, exclude) {
    const prev = sel.value;
    const opts = (emptyLabel ? `<option value="">${esc(emptyLabel)}</option>` : "") +
      deckTree().filter(([id]) => !exclude || !exclude.has(id)).map(([id,d,depth]) => `<option value="${esc(id)}">${"   ".repeat(depth)}${depth ? "↳ " : ""}${esc(d.name)}</option>`).join("");
    if (sel.dataset.sig !== opts) { sel.innerHTML = opts; sel.dataset.sig = opts; }
    if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
  }

  /* ================= images ================= */
  const OK_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
  async function capture(file) { const buf = await file.arrayBuffer(); return new File([buf], file.name || "image", { type: file.type || "image/jpeg" }); }
  async function shrink(file) {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const cv = document.createElement("canvas"); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
    const g = cv.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, cv.width, cv.height); g.drawImage(bmp, 0, 0, cv.width, cv.height);
    return await new Promise(res => cv.toBlob(b => res(b), "image/jpeg", 0.85));
  }
  async function uploadImg(file) {
    let blob = file;
    if (!OK_TYPES[file.type] || (file.size > 1.2e6 && file.type !== "image/gif")) { try { blob = await shrink(file); } catch { throw { message: "format d'image non pris en charge" }; } }
    if (blob.size > 20e6) throw { message: "image trop lourde" };
    const path = `images/${newId("img")}.${OK_TYPES[blob.type] || "jpg"}`;
    await ghPut(path, b64FromBytes(new Uint8Array(await blob.arrayBuffer())), null, "Image");
    blobUrls[path] = URL.createObjectURL(blob);
    return path;
  }
  async function dropImgs(...paths) { for (const p of paths) if (p && imgSrc(p)) { try { await ghDelete(p, "Suppression image"); } catch {} } }

  /* ================= add ================= */
  function renderAdd() {
    for (const s of ["#add-deck","#bulk-deck"]) fillDeckSelect($(s));
    $("#add-gate").innerHTML = writeGate();
    const ok = canWrite() && decks.size;
    for (const s of ["#add-form button[type=submit]","#bulk-go"]) $(s).disabled = !ok;
    if (canWrite() && !decks.size) status($("#add-status"), "Crée d'abord un paquet dans l'onglet Réviser.");
  }
  const status = (el, msg, kind) => { el.textContent = msg; el.className = "status" + (kind ? " "+kind : ""); };
  const newCard = (deck, front, back, extra) => ({ id: newId("c"), deck, front: front.trim(), back: back.trim(), created: Date.now(), ...(extra || {}) });

  const pending = { front: null, back: null };
  function setPending(side, file) {
    const old = pending[side]; if (old?.url) URL.revokeObjectURL(old.url);
    pending[side] = file ? { file, url: URL.createObjectURL(file) } : null;
    const box = document.querySelector(`.imgpick[data-side="${side}"]`);
    box.querySelector(".thumb").hidden = !file; box.querySelector(".pickbtn").hidden = !!file;
    if (file) box.querySelector(".thumb img").src = pending[side].url;
  }
  document.querySelectorAll("[data-pick]").forEach(b => b.addEventListener("click", () => $(`#add-${b.dataset.pick}-file`).click()));
  document.querySelectorAll("[data-unpick]").forEach(b => b.addEventListener("click", () => setPending(b.dataset.unpick, null)));
  for (const side of ["front","back"]) {
    $(`#add-${side}-file`).addEventListener("change", async e => {
      const f = e.target.files[0]; if (!f) return;
      try { setPending(side, await capture(f)); status($("#add-status"), ""); } catch { status($("#add-status"), "Impossible de lire cette image. Réessaie ou choisis-en une autre.", "err"); }
      e.target.value = "";
    });
    $(`#add-${side}`).addEventListener("paste", e => {
      const f = [...(e.clipboardData?.files || [])].find(x => x.type.startsWith("image/"));
      if (f) { e.preventDefault(); capture(f).then(c => setPending(side, c)).catch(() => {}); }
    });
  }
  const imageFrom = dt => [...(dt?.files || [])].find(f => f.type.startsWith("image/") || /\.(heic|heif|png|jpe?g|gif|webp)$/i.test(f.name));
  const hasFiles = dt => [...(dt?.types || [])].includes("Files");
  function wireDrop(root, attr, onFile) {
    let depth = 0;
    root.addEventListener("dragenter", e => { const z = e.target.closest?.(`[${attr}]`); if (!z || !hasFiles(e.dataTransfer)) return; e.preventDefault(); depth++; z.classList.add("over"); });
    root.addEventListener("dragover", e => { const z = e.target.closest?.(`[${attr}]`); if (!z || !hasFiles(e.dataTransfer)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
    root.addEventListener("dragleave", e => { const z = e.target.closest?.(`[${attr}]`); if (!z) return; depth = Math.max(0, depth - 1); if (!depth) z.classList.remove("over"); });
    root.addEventListener("drop", async e => {
      const z = e.target.closest?.(`[${attr}]`); if (!z) return; e.preventDefault(); depth = 0; z.classList.remove("over");
      const f = imageFrom(e.dataTransfer); if (!f) { banner("Ce fichier n'est pas une image."); return; }
      try { onFile(z.getAttribute(attr), await capture(f)); } catch { banner("Impossible de lire cette image."); }
    });
  }
  wireDrop($("#add-form"), "data-drop", (side, file) => setPending(side, file));
  wireDrop($("#br-list"), "data-eddrop", (side, file) => { keepEditText(); edImg[side] = { id: edImg[side].id, file, url: URL.createObjectURL(file) }; renderBrowse(); });
  window.addEventListener("dragover", e => { if (hasFiles(e.dataTransfer)) e.preventDefault(); });
  window.addEventListener("drop", e => { if (hasFiles(e.dataTransfer) && !e.target.closest?.("[data-drop],[data-eddrop]")) e.preventDefault(); });

  $("#add-form").addEventListener("submit", async e => {
    e.preventDefault();
    const f = $("#add-front").value, b = $("#add-back").value, d = $("#add-deck").value, st = $("#add-status");
    if (!d) return;
    if (!f.trim() && !pending.front) { status(st, "Il faut une question (texte ou image).", "err"); return; }
    if (!b.trim() && !pending.back) { status(st, "Il faut une réponse (texte ou image).", "err"); return; }
    const btn = $("#add-form button[type=submit]"); btn.disabled = true;
    const extra = {};
    try {
      for (const side of ["front","back"]) if (pending[side]) { status(st, "Envoi de l'image…"); extra[side + "Img"] = await uploadImg(pending[side].file); }
      status(st, "Enregistrement…");
      await commit("Nouvelle carte", json => json.cards.push(newCard(d, f, b, extra)));
      $("#add-front").value = ""; $("#add-back").value = ""; setPending("front", null); setPending("back", null); $("#add-front").focus();
      status(st, "Carte ajoutée ✓", "ok");
    } catch (err) { status(st, "Pas enregistrée : " + ghErr(err) + ".", "err"); await dropImgs(extra.frontImg, extra.backImg); }
    btn.disabled = false;
  });

  // Import format (what Claude produces):
  //   #paquet: UE 3 › Chromatographie      <- optional, switches target deck (created if missing, "›" or ">" for sub-decks)
  //   question ;; réponse                   <- one card per line (";;" or a tab)
  function parseImport(text) {
    const groups = []; let cur = { path: null, pairs: [] };
    for (const raw of text.split("\n")) {
      const l = raw.trim(); if (!l) continue;
      const m = l.match(/^#\s*paquet\s*:\s*(.+)$/i);
      if (m) { if (cur.pairs.length || cur.path) groups.push(cur); cur = { path: m[1].split(/\s*[›>]\s*/).map(x => x.trim()).filter(Boolean), pairs: [] }; continue; }
      if (l.startsWith("```")) continue;
      const parts = l.includes(";;") ? l.split(";;") : l.split("\t");
      if (parts.length >= 2 && parts[0].trim() && parts.slice(1).join(" ").trim())
        cur.pairs.push([parts[0].trim().replace(/\\n/g, "\n"), parts.slice(1).join(";;").trim().replace(/\\n/g, "\n")]);
    }
    if (cur.pairs.length) groups.push(cur);
    return groups.filter(g => g.pairs.length);
  }
  $("#bulk-go").addEventListener("click", async () => {
    const st = $("#bulk-status"), fallback = $("#bulk-deck").value;
    const groups = parseImport($("#bulk-text").value);
    const total = groups.reduce((n, g) => n + g.pairs.length, 0);
    if (!total) { status(st, "Aucune ligne valide : vérifie le séparateur ;; entre question et réponse.", "err"); return; }
    if (groups.some(g => !g.path) && !fallback) { status(st, "Choisis un paquet (ou ajoute une ligne #paquet: …).", "err"); return; }
    $("#bulk-go").disabled = true; status(st, "Enregistrement…");
    let createdDecks = 0;
    try {
      const t0 = Date.now(); let k = 0;
      await commit(`Import de ${total} cartes`, json => {
        createdDecks = 0;
        const findOrCreate = path => {
          let parent = null;
          for (const name of path) {
            let d = json.decks.find(x => (x.parent || null) === parent && x.name.toLowerCase() === name.toLowerCase());
            if (!d) { d = { id: slugify(name, x => json.decks.some(y => y.id === x)), name, created: Date.now(), ...(parent ? { parent } : {}) }; json.decks.push(d); createdDecks++; }
            parent = d.id;
          }
          return parent;
        };
        for (const g of groups) {
          const deck = g.path ? findOrCreate(g.path) : fallback;
          for (const [f, b] of g.pairs) json.cards.push({ ...newCard(deck, f, b), created: t0 + k++ });
        }
      });
      $("#bulk-text").value = "";
      status(st, `${total} carte${total>1?"s":""} importée${total>1?"s":""} ✓${createdDecks ? ` (${createdDecks} paquet${createdDecks>1?"s":""} créé${createdDecks>1?"s":""})` : ""}`, "ok");
    } catch (err) { status(st, "Import impossible : " + ghErr(err) + ".", "err"); }
    $("#bulk-go").disabled = false;
  });

  /* ================= browse ================= */
  let editing = null, armedDel = null, armedDeck = false, edImg = { front: {}, back: {} }, editText = null;
  const startEdit = c => { editing = c.id; editText = null; edImg = { front: { id: c.frontImg || null }, back: { id: c.backImg || null } }; };
  function keepEditText() { const f = $("#ed-f"), b = $("#ed-b"); if (f && editing) editText = { f: f.value, b: b.value }; }
  function chipFor(c, now) {
    if (isNew(c)) return `<span class="chip new">nouvelle</span>`;
    if (c.due <= now) return `<span class="chip due">à revoir</span>`;
    return `<span class="chip ${isLearning(c) ? "learn" : "later"}">dans ${human(c.due-now)}</span>`;
  }
  function renderBrowse() {
    fillDeckSelect($("#br-deck"), "Tous les paquets");
    $("#br-gate").innerHTML = writeGate();
    const d = $("#br-deck").value, q = $("#br-q").value.trim().toLowerCase(), now = Date.now(), w = canWrite();
    let list = deckCards(d || null);
    if (q) list = list.filter(c => (c.front + " " + c.back).toLowerCase().includes(q));
    list.sort((a,b) => (b.created||0) - (a.created||0));
    $("#br-count").textContent = `${list.length} carte${list.length>1?"s":""}`;
    $("#br-tools").hidden = !d || !w;
    if (d && w) {
      if ($("#br-tools").dataset.for !== d) { $("#br-tools").dataset.for = d; $("#br-name").value = decks.get(d)?.name || ""; }
      fillDeckSelect($("#br-parent"), "Paquet principal", subtree(d));
      if ($("#br-parent").dataset.for !== d) { $("#br-parent").dataset.for = d; $("#br-parent").value = parentOf(d) || ""; }
      const nSub = subtree(d).size - 1, dd = $("#br-deldeck");
      dd.classList.toggle("armed", armedDeck);
      dd.textContent = armedDeck ? `Confirmer : supprimer${nSub ? ` avec ${nSub} sous-paquet${nSub>1?"s":""}` : ""} et toutes les cartes` : "Supprimer ce paquet";
    }
    if (!list.length) { $("#br-list").innerHTML = `<div class="empty">${q ? "Aucune carte ne correspond." : "Aucune carte ici pour l'instant."}</div>`; return; }
    $("#br-list").innerHTML = list.slice(0, 400).map(c => {
      if (editing === c.id) return `<div class="item"><div class="edit">
        <textarea id="ed-f">${esc(c.front)}</textarea><textarea id="ed-b">${esc(c.back)}</textarea>
        <div class="imgrow">${["front","back"].map(side => { const cur = edImg[side]; const label = side === "front" ? "question" : "réponse";
          return `<div class="imgpick dropzone" data-eddrop="${side}"><input type="file" accept="image/*" id="ed-${side}-file" data-edfile="${side}" hidden>
            ${cur.file ? `<div class="thumb"><img src="${cur.url}" alt=""></div>` : cur.id ? `<div class="thumb">${imgTag(cur.id, "", "Image " + label)}</div>` : ""}
            <button type="button" class="btn ghost pickbtn" data-edpick="${side}">${cur.id || cur.file ? "Changer" : "+ Image"} (${label})</button>
            ${cur.id || cur.file ? `<button type="button" class="btn ghost" data-edclear="${side}">Retirer</button>` : ""}</div>`; }).join("")}</div>
        <div class="row"><button class="btn primary" data-save="${c.id}">Enregistrer</button><button class="btn ghost" data-cancel>Annuler</button></div></div></div>`;
      return `<div class="item"><div><div class="f">${fmt(c.front)}</div>${imgTag(c.frontImg, "minithumb", "Image de la question")}<div class="b">${fmt(c.back)}</div>${imgTag(c.backImg, "minithumb", "Image de la réponse")}${c.deck === d ? "" : `<div class="label" style="margin-top:4px">${esc(deckPath(c.deck))}</div>`}</div>
        <div class="meta">${chipFor(c, now)}${w ? `<button class="btn ghost" data-edit="${c.id}">Modifier</button>
        <button class="btn ghost danger ${armedDel===c.id?"armed":""}" data-del="${c.id}">${armedDel===c.id?"Confirmer":"Suppr."}</button>` : ""}</div></div>`;
    }).join("") + (list.length > 400 ? `<div class="empty">+ ${list.length-400} autres : affine la recherche.</div>` : "");
    if (editing && editText && $("#ed-f")) { $("#ed-f").value = editText.f; $("#ed-b").value = editText.b; }
    if (!editing) editText = null;
  }
  $("#br-deck").addEventListener("change", () => { armedDeck = false; renderBrowse(); });
  $("#br-q").addEventListener("input", renderBrowse);
  $("#br-list").addEventListener("change", async e => {
    const side = e.target.dataset?.edfile; if (!side) return;
    const raw = e.target.files[0]; if (!raw) return;
    let file; try { file = await capture(raw); } catch { banner("Impossible de lire cette image."); return; }
    keepEditText(); edImg[side] = { id: edImg[side].id, file, url: URL.createObjectURL(file) }; renderBrowse();
  });
  $("#br-list").addEventListener("click", async e => {
    const t = e.target.closest("button"); if (!t) return;
    if (t.dataset.edit) { const c = cards.get(t.dataset.edit); if (c) startEdit(c); armedDel = null; renderBrowse(); $("#ed-f")?.focus(); }
    else if (t.dataset.edpick) $(`#ed-${t.dataset.edpick}-file`).click();
    else if (t.dataset.edclear) { keepEditText(); edImg[t.dataset.edclear] = { id: null, file: null }; renderBrowse(); }
    else if (t.hasAttribute("data-cancel")) { editing = null; renderBrowse(); }
    else if (t.dataset.save) {
      const id = t.dataset.save, c = cards.get(id);
      const f = $("#ed-f").value.trim(), b = $("#ed-b").value.trim();
      if ((!f && !edImg.front.id && !edImg.front.file) || (!b && !edImg.back.id && !edImg.back.file)) { banner("Il faut une question et une réponse (texte ou image)."); return; }
      t.disabled = true;
      const set = { front: f, back: b }, fresh = [], removed = [];
      try {
        for (const side of ["front","back"]) {
          const key = side + "Img", cur = edImg[side];
          if (cur.file) { const p = await uploadImg(cur.file); fresh.push(p); set[key] = p; if (c?.[key]) removed.push(c[key]); }
          else if (!cur.id && c?.[key]) { set[key] = null; removed.push(c[key]); }
        }
        await commit("Carte modifiée", json => { const x = json.cards.find(k => k.id === id); if (!x) return;
          for (const [k, v] of Object.entries(set)) { if (v === null) delete x[k]; else x[k] = v; } });
        editing = null; await dropImgs(...removed);
      } catch (err) { banner("Modification non enregistrée : " + ghErr(err) + "."); await dropImgs(...fresh); t.disabled = false; }
      renderBrowse();
    } else if (t.dataset.del) {
      if (armedDel !== t.dataset.del) { armedDel = t.dataset.del; renderBrowse(); return; }
      armedDel = null; const id = t.dataset.del, dc = cards.get(id);
      try { await commit("Carte supprimée", json => { json.cards = json.cards.filter(k => k.id !== id); }); delete progress[id]; LS.set("cdl-progress", progress); await dropImgs(dc?.frontImg, dc?.backImg); }
      catch (err) { banner("Suppression impossible : " + ghErr(err) + "."); }
      renderBrowse();
    }
  });
  async function deleteDeck(d) {
    const tree = subtree(d), list = deckCards(d), name = decks.get(d)?.name;
    deleting.add(d); render();
    try {
      await commit(`Paquet supprimé : ${name}`, json => { json.decks = json.decks.filter(x => !tree.has(x.id)); json.cards = json.cards.filter(c => !tree.has(c.deck)); });
      for (const c of list) { delete progress[c.id]; await dropImgs(c.frontImg, c.backImg); }
      LS.set("cdl-progress", progress);
      banner(`« ${name || "Paquet"} » supprimé (${list.length} carte${list.length>1?"s":""}).`, "ok");
    } catch (err) { banner("Suppression du paquet impossible : " + ghErr(err) + "."); }
    deleting.delete(d); render();
  }
  $("#br-deldeck").addEventListener("click", async () => {
    const d = $("#br-deck").value; if (!d) return;
    if (!armedDeck) { armedDeck = true; renderBrowse(); return; }
    armedDeck = false; $("#br-deck").value = ""; await deleteDeck(d);
  });
  $("#br-save").addEventListener("click", async () => {
    const d = $("#br-deck").value; if (!d || !decks.has(d)) return;
    const name = $("#br-name").value.trim(), parent = $("#br-parent").value;
    if (!name) { banner("Donne un nom au paquet."); return; }
    if (parent && subtree(d).has(parent)) { banner("Un paquet ne peut pas être rangé dans un de ses propres sous-paquets."); return; }
    $("#br-save").disabled = true;
    try {
      await commit(`Paquet modifié : ${name}`, json => { const x = json.decks.find(k => k.id === d); if (!x) return; x.name = name; if (parent) x.parent = parent; else delete x.parent; });
      $("#br-save").textContent = "Enregistré ✓"; setTimeout(() => $("#br-save").textContent = "Enregistrer", 1500);
    } catch (err) { banner("Modification du paquet non enregistrée : " + ghErr(err) + "."); }
    $("#br-save").disabled = false; renderBrowse();
  });

  /* ================= settings ================= */
  function renderSettings() {
    if (document.activeElement?.closest?.("#view-settings")) return;
    $("#set-owner").value = gh.owner; $("#set-repo").value = gh.repo; $("#set-branch").value = gh.branch;
    $("#set-token").value = gh.token ? "••••••••••••" + gh.token.slice(-4) : "";
    $("#set-state").textContent = canWrite() ? "Connecté : tu peux ajouter, modifier et supprimer depuis ce téléphone, et ta progression est sauvegardée sur GitHub." : "Non connecté : tu peux réviser, mais pas modifier les cartes depuis ce téléphone.";
    $("#set-logout").hidden = !gh.token;
  }
  $("#set-form").addEventListener("submit", async e => {
    e.preventDefault();
    const tok = $("#set-token").value.trim();
    const next = { owner: $("#set-owner").value.trim(), repo: $("#set-repo").value.trim(), branch: $("#set-branch").value.trim() || "main", token: tok.startsWith("•") ? gh.token : tok };
    const st = $("#set-status"); status(st, "Vérification…");
    const prev = gh; gh = next;
    try {
      const r = await fetch(`https://api.github.com/repos/${gh.owner}/${gh.repo}`, { headers: { Authorization: `Bearer ${gh.token}`, Accept: "application/vnd.github+json" }, cache: "no-store" });
      if (!r.ok) throw { status: r.status };
      const j = await r.json();
      if (!j.permissions?.push) throw { status: 403 };
      LS.set("cdl-github", gh); status(st, "Connecté ✓", "ok"); document.activeElement?.blur(); renderSettings(); loadCards();
    } catch (err) { gh = prev; status(st, "Échec : " + ghErr(err) + ".", "err"); }
  });
  $("#set-logout").addEventListener("click", async () => { await pushProgress(); gh = { ...gh, token: "" }; LS.set("cdl-github", gh); status($("#set-status"), "Déconnecté."); renderSettings(); render(); });
  $("#set-export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), progress }, null, 1)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `progression-cartes-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  $("#set-import").addEventListener("click", () => $("#set-import-file").click());
  $("#set-import-file").addEventListener("change", async e => {
    const f = e.target.files[0]; if (!f) return; e.target.value = "";
    try { const j = JSON.parse(await f.text()); mergeProgress(j.progress || j); LS.set("cdl-progress", progress); progressDirty = true; LS.set("cdl-progress-dirty", true); rebuild(); status($("#set-status"), "Progression restaurée ✓", "ok"); pushProgress(); }
    catch { status($("#set-status"), "Ce fichier n'est pas une sauvegarde valide.", "err"); }
  });
  $("#set-reload").addEventListener("click", () => loadCards());

  function banner(msg, kind) { const b = $("#banner"); b.textContent = msg; b.hidden = !msg; b.classList.toggle("ok", kind === "ok"); clearTimeout(banner.t); banner.t = setTimeout(() => b.hidden = true, 8000); }

  /* ================= boot ================= */
  const cached = LS.get("cdl-cache", null);
  if (cached) { applyData(cached); loaded = true; }
  render();
  loadCards();
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();
