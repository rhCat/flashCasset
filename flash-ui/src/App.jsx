import React, { useEffect, useMemo, useRef, useState } from "react";
import { useSwipeable } from "react-swipeable";

/** ------- deployment-aware bases (subpath + api) ------- */
const BASE = (import.meta.env.BASE_URL || "/");              // e.g. "/fcasset/"
const API_BASE = (import.meta.env.VITE_API_BASE || `${BASE}api/`); // e.g. "/fcasset/api/"

/**
 * Flash Coach — Study (refined) + Test (minimal)
 * - Study: Left/Right navigate; Up=Hard; Down=Know; tap to flip (overlay swap)
 * - Filters: All | Marked | Hard
 * - Card matrix: quick jump + status rings
 * - Decks: load/save to server via /fcasset/api/cards[?name=...]
 * - Loads /public/cards.json on boot if available
 */

const SAMPLE = `front,back,durationSec
abate,减弱; 缓和; to lessen in intensity,10
banal,陈腐的; 平庸的; common or overused,10
capricious,反复无常的; given to sudden changes,10`;

function fixText(s) {
  if (typeof s !== "string") return "";
  return s.replace(/\\r?\\n/g, "\n");
}

function parseDeck(raw, defaultSeconds = 12) {
  const lines = raw.trim().split(/\r?\n/);
  if (!lines.length) return [];
  let rows = [];
  if (lines[0].includes(",")) rows = lines.map(l => l.split(",").map(s => s.trim()));
  else if (lines[0].includes("|")) rows = lines.map(l => l.split("|").map(s => s.trim()));
  else rows = lines.map(l => { const [f, ...r] = l.split(/\s+/); return [f, r.join(" ")]; });
  if (rows.length && rows[0][0].toLowerCase() === "front") rows.shift();
  return rows
    .filter(r => r[0] && r[1])
    .map((r, i) => ({
      id: `c${i}-${r[0]}`,
      front: r[0],
      back: r[1],
      durationSec: Number(r[2]) > 0 ? Number(r[2]) : defaultSeconds,
      ease: 2.5,
      interval: 0,
      reps: 0,
      due: Date.now(),
      lastGrade: 0, // 0=unseen, 3=hard, 5=know
      marked: false,
    }));
}

const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const load = (k, f) => { try { return JSON.parse(localStorage.getItem(k)) ?? f; } catch { return f; } };

/** ------- cards.json → local state (used by first boot hydrate) ------- */
function applyCardsJsonObject(j, name = "default") {
  const hard = new Set(j.hard || []);
  const know = new Set(j.know || []);
  const mark = new Set(j.mark || []);
  const cards = (j.cards || []).map((c, i) => ({
    id: c.id ?? `r${i}`,
    front: c.term,
    back: fixText(c.meaning),
    durationSec: 12,
    ease: 2.5,
    interval: 0,
    reps: 0,
    due: Date.now(),
    lastGrade: know.has(c.id) ? 5 : hard.has(c.id) ? 3 : 0,
    marked: mark.has(c.id),
  }));
  save("study_cards", cards);
  save("study_queue", cards.map(c => c.id));
  const testCsv = ["front,back,durationSec", ...(j.cards || []).map(c => `${c.term},${c.meaning},12`)].join("\n");
  save("test_deckRaw", testCsv);
  save("deck_name", name);
  window.dispatchEvent(new CustomEvent("cardsjson:loaded"));
}

/** ------- optional: first-boot hydrate from /public/cards.json ------- */
async function hydrateFromCardsJson() {
  try {
    const r = await fetch(`${BASE}cards.json`, { cache: "no-store", credentials: "include" });
    if (!r.ok) return false;
    const j = await r.json();
    applyCardsJsonObject(j, "default");
    return true;
  } catch {
    return false;
  }
}

/** ------- scheduler ------- */
function schedule(card, grade) {
  let { ease, interval, reps } = card;
  if (grade >= 3) {
    if (reps === 0) interval = 1;
    else if (reps === 1) interval = 3;
    else interval = Math.max(1, Math.round(interval * ease));
    reps += 1;
    ease = Math.max(1.3, ease + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02)));
  } else {
    reps = 0; interval = 0.02;
  }
  const due = Date.now() + interval * 86400000;
  return { ...card, ease, interval, reps, due, lastGrade: grade };
}

/** ------- shared study state ------- */
function useStudyDeck() {
  const [cards, setCards] = useState(() => load("study_cards", parseDeck(SAMPLE)));
  const [queue, setQueue] = useState(() => {
    const ids = load("study_queue", cards.map(c => c.id));
    return [...new Set(ids)];
  });

  // persist
  useEffect(() => { save("study_cards", cards); }, [cards]);
  useEffect(() => { save("study_queue", queue); }, [queue]);

  // react to cardsjson:loaded (hydrate)
  useEffect(() => {
    const h = () => { setCards(load("study_cards", [])); setQueue(load("study_queue", [])); };
    window.addEventListener("cardsjson:loaded", h);
    return () => window.removeEventListener("cardsjson:loaded", h);
  }, []);

  const replaceCard = (u) => setCards(cs => cs.map(c => c.id === u.id ? u : c));
  const byId = (id) => cards.find(c => c.id === id);

  return { cards, setCards, queue, setQueue, replaceCard, byId };
}

/** ===================== Study Mode ===================== */
function StudyMode({ externalFilter = "all", setExternalFilter }) {
  const { cards, queue, setQueue, replaceCard, byId } = useStudyDeck();

  // server-side decks
  const [serverDecks, setServerDecks] = useState([]);
  const [serverName, setServerName] = useState(""); // without .json
  const [deckName, setDeckName] = useState(load("deck_name", "default"));

  useEffect(() => {
    fetch(`${API_BASE}cards/list`, { credentials: "include" })
      .then(r => r.json())
      .then(j => {
        const files = j.files || [];
        setServerDecks(files);
        const guess = files.includes("cards.json")
          ? "cards"
          : (files[0]?.replace(/\.json$/,"") || "");
        if (guess) setServerName(guess);
      })
      .catch(() => {});
  }, []);

  async function loadServerDeck() {
    if (!serverName) return;
    const r = await fetch(`${API_BASE}cards?name=${encodeURIComponent(serverName)}`, { credentials: "include" });
    if (!r.ok) return alert("Failed to load deck from server");
    const obj = await r.json();
    applyDeckFromJson(obj, serverName);
  }
  async function saveServerDeck() {
    if (!serverName) return alert("Pick a server deck name first");
    const payload = {
      name: serverName,
      cards: cards.map(c => ({ id: c.id, term: c.front, meaning: c.back })),
      hard:  cards.filter(c => c.lastGrade === 3).map(c => c.id),
      know:  cards.filter(c => c.lastGrade === 5).map(c => c.id),
      mark:  cards.filter(c => c.marked).map(c => c.id),
    };
    const r = await fetch(`${API_BASE}cards?name=${encodeURIComponent(serverName)}`, {
      method: "PUT",
      headers: { "Content-Type":"application/json" },
      credentials: "include",
      body: JSON.stringify(payload),
    });
    if (!r.ok) return alert("Save failed");
    alert("Saved ✔︎");
  }

  // filter driven by header (parent)
  const [filter, setFilter] = useState(externalFilter);
  useEffect(() => setFilter(externalFilter), [externalFilter]);
  useEffect(() => { setExternalFilter?.(filter); }, [filter, setExternalFilter]);

  // visible queue
  const visibleIds = useMemo(() => {
    if (filter === "marked") return queue.filter(id => byId(id)?.marked);
    if (filter === "hard")   return queue.filter(id => byId(id)?.lastGrade === 3);
    return queue;
  }, [queue, filter, cards]);

  // index within visible list
  const [i, setI] = useState(0);
  useEffect(() => { if (i >= visibleIds.length) setI(Math.max(0, visibleIds.length - 1)); }, [visibleIds.length, i]);
  const current = byId(visibleIds[i]);

  function jumpRandom() {
    if (!visibleIds.length) return;
    let ni = Math.floor(Math.random() * visibleIds.length);
    if (visibleIds.length > 1 && ni === i) ni = (ni + 1) % visibleIds.length;
    setI(ni);
    setFlipped(false);
  }

  const isMobile = typeof navigator !== "undefined" && /iPhone|iPad|Android/i.test(navigator.userAgent);

  // swipe + keys
  const handlers = useSwipeable({
    onSwipedLeft:  () => setI(v => Math.min(visibleIds.length - 1, v + 1)),
    onSwipedRight: () => setI(v => Math.max(0, v - 1)),
    onSwipedUp:    () => { if (!isMobile) grade(3); },
    onSwipedDown:  () => { if (!isMobile) grade(5); },
    trackMouse: true,
    preventScrollOnSwipe: false,
    touchEventOptions: { passive: true },
    delta: 20,
  });

  useEffect(() => {
    function onKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "arrowleft") setI(v => Math.max(0, v - 1));
      else if (k === "arrowright" || k === "enter") setI(v => Math.min(visibleIds.length - 1, v + 1));
      else if (k === "arrowup") grade(3);
      else if (k === "arrowdown" || k === " ") { e.preventDefault(); grade(5); }
      else if (k === "f") setFlipped(f => !f);
      else if (k === "r") jumpRandom();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visibleIds.length, current]);

  // flip (overlay swap)
  const [flipped, setFlipped] = useState(false);
  function grade(g) {
    if (!current) return;
    const updated = schedule(current, g);
    replaceCard(updated);
    if (g === 5) setI(v => Math.min(visibleIds.length - 1, v + 1));
    setFlipped(false);
  }

  // absolute index (1-based)
  const absoluteIdx = useMemo(() => {
    if (!current) return 0;
    const pos = cards.findIndex(c => c.id === current.id);
    return pos >= 0 ? pos + 1 : 0;
  }, [cards, current]);

  const countText = current ? (
    <>
      Card <span className="font-semibold">{i + 1}</span>/
      <span className="font-semibold">{visibleIds.length}</span>
      <span className="mx-1 text-neutral-400">•</span>
      <span className="text-neutral-700">
        #<span className="font-semibold">{absoluteIdx}</span>/
        <span className="font-semibold">{cards.length}</span>
      </span>
      <span className="mx-1 text-neutral-400">•</span>
      <span className="text-neutral-700">
        ID: <span className="font-semibold">{current.id}</span>
      </span>
    </>
  ) : <>No cards</>;

  // ---- local JSON apply/choose/save (kept) ----
  function applyDeckFromJson(obj, name = "custom") {
    try {
      const hard = new Set(obj.hard || []);
      const know = new Set(obj.know || []);
      const mark = new Set(obj.mark || []);
      const next = (obj.cards || []).map((c, idx) => ({
        id: c.id ?? `r${idx}`,
        front: c.term,
        back: typeof fixText === "function" ? fixText(c.meaning) : c.meaning,
        durationSec: 12,
        ease: 2.5, interval: 0, reps: 0, due: Date.now(),
        lastGrade: know.has(c.id) ? 5 : hard.has(c.id) ? 3 : 0,
        marked: mark.has(c.id),
      }));
      save("study_cards", next);
      const ids = next.map(c => c.id);
      setQueue(ids);
      save("study_queue", ids);
      setDeckName(name);
      save("deck_name", name);
      window.dispatchEvent(new CustomEvent("cardsjson:loaded"));
    } catch (e) { console.error(e); alert("Invalid JSON"); }
  }
  async function onChooseJson(ev) {
    const f = ev.target.files?.[0]; if (!f) return;
    const txt = await f.text(); const obj = JSON.parse(txt);
    applyDeckFromJson(obj, f.name.replace(/\.[^.]+$/, ""));
    ev.target.value = "";
  }
  async function saveDeck() {
    const payload = {
      name: deckName,
      cards: cards.map(c => ({ id: c.id, term: c.front, meaning: c.back })),
      hard: cards.filter(c => c.lastGrade === 3).map(c => c.id),
      know: cards.filter(c => c.lastGrade === 5).map(c => c.id),
      mark: cards.filter(c => c.marked).map(c => c.id),
    };
    try {
      await fetch(`${API_BASE}cards`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload)
      });
      alert("Deck saved.");
    } catch (e) { console.error(e); alert("Save failed"); }
  }

  return (
    <div className="grid grid-cols-5 gap-3" style={{ minHeight: "82vh" }} {...handlers}>
      <aside className="hidden md:block col-span-1" />
      <section className="col-span-5 md:col-span-3">
        <div className="bg-white rounded-2xl border shadow flex flex-col" style={{ minHeight: "82vh" }}>



          {/* CARD — bounded, mobile-safe, auto-height */}
          <div className="flex-1 p-2 md:p-3">
            <div className="mx-auto w-full max-w-[900px]">
              {current ? (
                <button
                  onClick={() => setFlipped(f => !f)}
                  aria-label="Toggle face"
                  // grid overlay keeps faces stacked while letting the container
                  // size to the tallest face (no absolute/fixed height!)
                  className="w-full rounded-2xl ring-1 ring-neutral-200 shadow-sm overflow-hidden
                            bg-white"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr",
                    gridTemplateRows: "1fr",
                    touchAction: "pan-y",
                  }}
                >
                  {/* visual card surface */}
                  <div className="col-start-1 row-start-1 rounded-2xl bg-neutral-900" />

                  {/* FRONT */}
                  <div
                    className="col-start-1 row-start-1 transition-opacity duration-200"
                    style={{ opacity: flipped ? 0 : 1, zIndex: 1 }}
                  >
                    <div
                      className="px-6 py-8 text-center text-white font-bold"
                      style={{
                        // content can scroll only if it needs to (no fixed height cap)
                        overflow: "auto",
                        WebkitOverflowScrolling: "touch",
                        overscrollBehavior: "contain",
                        whiteSpace: "pre-wrap",
                        overflowWrap: "anywhere",
                        lineHeight: 1.25,
                        // responsive type: small phones → big desktops
                        fontSize: "clamp(20px, 6vw, 64px)",
                      }}
                    >
                      {current.front}
                    </div>
                  </div>

                  {/* BACK */}
                  <div
                    className="col-start-1 row-start-1 transition-opacity duration-200"
                    style={{ opacity: flipped ? 1 : 0, zIndex: 2 }}
                  >
                    <div
                      className="px-6 py-8 text-center text-white font-bold"
                      style={{
                        overflow: "auto",
                        WebkitOverflowScrolling: "touch",
                        overscrollBehavior: "contain",
                        whiteSpace: "pre-wrap",
                        overflowWrap: "anywhere",
                        lineHeight: 1.25,
                        fontSize: "clamp(16px, 4.5vw, 32px)",
                      }}
                    >
                      {fixText(current.back)}
                    </div>
                  </div>
                </button>
              ) : (
                <div className="grid place-items-center text-neutral-500 min-h-[200px]">
                  Add <code>public/cards.json</code> then reload, or choose a JSON file.
                </div>
              )}
            </div>
          </div>



          {/* footer — hint + count left • mark/random/filters right */}
          <div className="px-3 py-2 pb-[max(0px,env(safe-area-inset-bottom))] flex items-center justify-between gap-3 flex-wrap">
            <div className="flex flex-col">
              <div className="text-xs text-neutral-500">
                Swipe ←/→ • ↑ = Hard • ↓/Space = Know • Tap to flip • R = Random
              </div>
              <div className="text-xs text-neutral-700 mt-1">{countText}</div>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              {current && (
                <button
                  onClick={() => replaceCard({ ...current, marked: !current.marked })}
                  className={`px-3 py-1 rounded-md border text-xs ${current.marked ? "bg-purple-600 text-white" : "bg-white"}`}
                  title="Toggle mark (M)"
                >
                  ✳︎ Mark
                </button>
              )}
              <button
                onClick={jumpRandom}
                className="px-3 py-1 rounded-md border text-xs bg-white"
                title="Jump to a random card (R)"
              >
                🎲 Random
              </button>
              <span className="hidden sm:inline-block w-px h-5 bg-neutral-300 mx-1" />
              {["all", "marked", "hard"].map(f => (
                <button
                  key={f}
                  onClick={() => { setFilter(f); setI(0); }}
                  className={`px-2 py-1 rounded-full border text-xs ${filter === f ? "bg-neutral-900 text-white" : "bg-white"}`}
                  title={`Show ${f}`}
                >
                  {f[0].toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Deck controls */}
        <div className="mt-3 rounded-xl border bg-white p-3">
          <div className="text-xs font-medium mb-2">Deck Controls</div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="px-2 py-2 rounded-md border bg-white"
              value={serverName}
              onChange={e => setServerName(e.target.value)}
            >
              {serverDecks.map(f => (
                <option key={f} value={f.replace(/\.json$/,"")}>{f}</option>
              ))}
            </select>
            <button onClick={loadServerDeck} className="px-3 py-2 rounded-md border bg-white">Load Server Deck</button>
            <button onClick={saveServerDeck} className="px-3 py-2 rounded-md border bg-white">Save to Server</button>
            <span className="hidden sm:inline-block w-px h-5 bg-neutral-300 mx-1" />
            <label className="px-3 py-2 rounded-md border bg-white cursor-pointer">
              Choose JSON (local)
              <input type="file" accept="application/json" className="hidden" onChange={onChooseJson} />
            </label>
            <button onClick={saveDeck} className="px-3 py-2 rounded-md border bg-white">Save (default)</button>
            <div className="text-xs text-neutral-600">
              <span className="font-medium">Deck:</span> {deckName}
              <span className="mx-1 text-neutral-400">•</span> Total: {cards.length}
            </div>
          </div>
        </div>

        {/* Matrix */}
        <details className="mt-3 rounded-xl border bg-white" open>
          <summary className="cursor-pointer p-3 text-sm font-medium select-none">Card Matrix</summary>
          <div className="p-3 pt-0">
            <div className="grid grid-cols-6 gap-2">
              {visibleIds.map((id, idx) => {
                const c = byId(id);
                const currentHere = idx === i;
                const classes = [
                  "h-8 rounded-md text-xs font-medium",
                  c?.lastGrade === 5 ? "bg-emerald-600 text-white" : "bg-neutral-300",
                  currentHere ? "ring-2 ring-blue-500" : "",
                  c?.marked ? "ring-2 ring-purple-500" : "",
                  c?.lastGrade === 3 ? "ring-2 ring-amber-500" : "",
                ].join(" ");
                return (
                  <button
                    key={id}
                    onClick={() => setI(idx)}
                    className={classes}
                    title={`${c?.id} — ${c?.front}`}
                  >
                    {idx + 1}
                  </button>
                );
              })}
            </div>
          </div>
        </details>
      </section>
      <aside className="hidden md:block col-span-1" />
    </div>
  );
}

/** ===================== Minimal Test ===================== */
function TestMode() {
  const [deckRaw, setDeckRaw] = useState(load("test_deckRaw", SAMPLE));
  const [secondsPerCard, setSecondsPerCard] = useState(load("test_secondsPerCard", 12));
  const [stage, setStage] = useState("setup"); // setup | running | review
  const deck = useMemo(() => parseDeck(deckRaw, secondsPerCard), [deckRaw, secondsPerCard]);

  const [idx, setIdx] = useState(0);
  const [countdown, setCountdown] = useState(secondsPerCard);
  const [recordings, setRecordings] = useState({});
  const mediaRecRef = useRef(null);
  const streamRef = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => { save("test_deckRaw", deckRaw); }, [deckRaw]);
  useEffect(() => { save("test_secondsPerCard", secondsPerCard); }, [secondsPerCard]);

  const handlers = useSwipeable({
    onSwipedLeft: () => stage === "running" && nextCard(),
    onSwipedRight: () => stage === "running" && nextCard(),
    trackMouse: true, preventScrollOnSwipe: true
  });

  useEffect(() => {
    const h = () => setDeckRaw(load("test_deckRaw", deckRaw));
    window.addEventListener("cardsjson:loaded", h);
    return () => window.removeEventListener("cardsjson:loaded", h);
    // eslint-disable-next-line
  }, []);

  function stopTimers() { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } }
  function stopCardRecording() {
    try { if (mediaRecRef.current && mediaRecRef.current.state !== "inactive") mediaRecRef.current.stop(); } catch {}
    try { streamRef.current && streamRef.current.getTracks().forEach(t => t.stop()); } catch {}
  }
  async function startCardRecordingAt(index) {
    stopTimers(); stopCardRecording();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const rec = new MediaRecorder(stream);
      mediaRecRef.current = rec;
      const chunks = [];
      rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        const blob = new Blob(chunks, { type: "audio/webm" });
        const card = deck[index];
        if (card) setRecordings(prev => ({ ...prev, [card.id]: blob }));
        try { stream.getTracks().forEach(t => t.stop()); } catch {}
      };
      rec.start();
      const dur = deck[index]?.durationSec || secondsPerCard;
      setCountdown(dur);
      timerRef.current = window.setInterval(() => {
        setCountdown(c => {
          if (c <= 1) { clearInterval(timerRef.current); nextCard(); return 0; }
          return c - 1;
        });
      }, 1000);
    } catch (e) {
      alert("Microphone permission is required.");
      console.error(e);
    }
  }

  function startTest() { if (!deck.length) return; setIdx(0); setStage("running"); startCardRecordingAt(0); }
  function nextCard() {
    stopTimers(); stopCardRecording();
    if (idx + 1 < deck.length) { const n = idx + 1; setIdx(n); setTimeout(() => startCardRecordingAt(n), 150); }
    else setStage("review");
  }
  useEffect(() => () => { stopTimers(); stopCardRecording(); }, []);

  return (
    <div className="grid grid-cols-5 gap-3" style={{ minHeight: "82vh" }} {...handlers}>
      <aside className="hidden md:block col-span-1" />
      <section className="col-span-5 md:col-span-3">
        <div className="bg-white rounded-2xl border shadow flex flex-col" style={{ minHeight: "82vh" }}>
          <div className="flex items-center justify-between px-3 py-2">
            <div className="text-xs text-neutral-600">
              {stage === "running" ? <>Card {idx + 1}/{deck.length} • <b>{countdown}s</b></> : <>Cards: {deck.length}</>}
            </div>
            {stage !== "running" && <button onClick={startTest} className="px-3 py-1 rounded-md border text-xs bg-white">Start</button>}
          </div>
          <div className="flex-1 min-h-0 flex items-center justify-center p-3">
            {stage === "running" && deck[idx] && (
              <div className="w-full h-full rounded-xl border shadow flex items-center justify-center text-center bg-neutral-900">
                <div className="text-white font-bold" style={{ fontSize: 48 }}>{deck[idx].front}</div>
              </div>
            )}
            {stage !== "running" && <div className="text-neutral-600">Test not running.</div>}
          </div>
          <div className="px-3 py-2 text-center text-xs text-neutral-500">Swipe ←/→ or press Enter to advance</div>
        </div>
      </section>
      <aside className="hidden md:block col-span-1" />
    </div>
  );
}

/** ===================== Root ===================== */
export default function App() {
  const [mode, setMode] = useState(load("ui_mode", "study"));
  const [uiFilter, setUiFilter] = useState("all"); // all | marked | hard
  useEffect(() => { save("ui_mode", mode); }, [mode]);
  useEffect(() => { (async () => { await hydrateFromCardsJson(); })(); }, []);

  return (
    <div
      className="min-h-svh bg-neutral-100"
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <header className="px-3 py-1.5 flex items-center justify-between flex-wrap gap-2 border-b bg-white">
        <div className="text-sm">🃏 Flash Coach</div>
        <div className="flex items-center text-sm">
          <button
            onClick={() => setMode("study")}
            className={`px-3 py-1 rounded-full border ${mode==="study"?"bg-neutral-900 text-white":"bg-white"}`}
          >
            Study
          </button>
          <button
            onClick={() => setMode("test")}
            className={`px-3 py-1 rounded-full border ${mode==="test" ?"bg-neutral-900 text-white":"bg-white"}`}
          >
            Test
          </button>
        </div>
      </header>

      <main className="px-2 md:px-4 pt-2">
        {mode === "study"
          ? <StudyMode externalFilter={uiFilter} setExternalFilter={setUiFilter}/>
          : <TestMode/>}
      </main>
    </div>
  );
}
