import React, { useEffect, useMemo, useRef, useState } from "react";
import { useSwipeable } from "react-swipeable";

/**
 * Flash Coach — Study (refined) + Test (minimal)
 * - Study: Left/Right navigate; Up=Hard; Down=Know; tap to flip (3D)
 * - Review filters: All | Marked | Hard
 * - Card counts use the *visible* queue only (no double counting)
 * - Card background: deep gray (text white)
 * - Loads /public/cards.json into localStorage on boot
 */

const SAMPLE = `front,back,durationSec
abate,减弱; 缓和; to lessen in intensity,10
banal,陈腐的; 平庸的; common or overused,10
capricious,反复无常的; given to sudden changes,10`;

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
      lastGrade: 0,    // 0=unseen, 3=hard, 5=know
      marked: false,
    }));
}
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const load = (k, f) => { try { return JSON.parse(localStorage.getItem(k)) ?? f; } catch { return f; } };

// ---- hydrate /public/cards.json on boot
async function hydrateFromCardsJson() {
  try {
    const r = await fetch("/cards.json", { cache: "no-store" });
    if (!r.ok) return false;
    const j = await r.json();
    const hard = new Set(j.hard || []);
    const know = new Set(j.know || []);
    const mark = new Set(j.mark || []);
    const cards = (j.cards || []).map((c, i) => ({
      id: c.id ?? `r${i}`,
      front: c.term,
      back: c.meaning,
      durationSec: 12,
      ease: 2.5,
      interval: 0,
      reps: 0,
      due: Date.now(),
      lastGrade: know.has(c.id) ? 5 : hard.has(c.id) ? 3 : 0,
      marked: mark.has(c.id),
    }));
    save("study_cards", cards);
    // seed queue with *unique* ids exactly once
    save("study_queue", cards.map(c => c.id));
    // seed test deck too
    const testCsv = ["front,back,durationSec", ...(j.cards || []).map(c => `${c.term},${c.meaning},12`)].join("\n");
    save("test_deckRaw", testCsv);
    window.dispatchEvent(new CustomEvent("cardsjson:loaded"));
    return true;
  } catch { return false; }
}

// -------------------- Study --------------------
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

function useStudyDeck() {
  const [cards, setCards] = useState(() => load("study_cards", parseDeck(SAMPLE)));
  const [queue, setQueue] = useState(() => {
    // ensure uniqueness (no dupes from due+fresh)
    const ids = load("study_queue", cards.map(c => c.id));
    return [...new Set(ids)];
  });

  // persist
  useEffect(() => { save("study_cards", cards); }, [cards]);
  useEffect(() => { save("study_queue", queue); }, [queue]);

  // handle cards.json hydration
  useEffect(() => {
    const h = () => { setCards(load("study_cards", [])); setQueue(load("study_queue", [])); };
    window.addEventListener("cardsjson:loaded", h);
    return () => window.removeEventListener("cardsjson:loaded", h);
  }, []);

  const replaceCard = (u) => setCards(cs => cs.map(c => c.id === u.id ? u : c));
  const byId = (id) => cards.find(c => c.id === id);

  return { cards, queue, setQueue, replaceCard, byId };
}

function StudyMode() {
  const { cards, queue, setQueue, replaceCard, byId } = useStudyDeck();

  // --- review filter ---
  const [filter, setFilter] = useState("all"); // all | marked | hard
  const visibleIds = useMemo(() => {
    if (filter === "all") return queue;
    if (filter === "marked") return queue.filter(id => byId(id)?.marked);
    if (filter === "hard") return queue.filter(id => byId(id)?.lastGrade === 3);
    return queue;
  }, [queue, filter, cards]);

  // index inside visible list
  const [i, setI] = useState(0);
  useEffect(() => { if (i >= visibleIds.length) setI(Math.max(0, visibleIds.length - 1)); }, [visibleIds.length, i]);

  const current = byId(visibleIds[i]);

  // --- interactions: swipe/keys ---
  const handlers = useSwipeable({
    onSwipedLeft: () => setI(v => Math.min(visibleIds.length - 1, v + 1)),  // next
    onSwipedRight: () => setI(v => Math.max(0, v - 1)),                     // prev
    onSwipedUp: () => grade(3),   // Hard
    onSwipedDown: () => grade(5), // Know
    trackMouse: true,
    preventScrollOnSwipe: true,
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
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visibleIds.length, current]);

  // flip
  const [flipped, setFlipped] = useState(false);

  function grade(g) {
    if (!current) return;
    const updated = schedule(current, g);
    replaceCard(updated);
    if (g === 5) setI(v => Math.min(visibleIds.length - 1, v + 1));
    setFlipped(false);
  }
  function toggleMark() {
    if (!current) return;
    replaceCard({ ...current, marked: !current.marked });
  }

  // header counts only *visible* ids (so “60/60” when you have 60 cards)
  const countText = current ? `Card ${Math.min(i + 1, visibleIds.length)}/${visibleIds.length}` : "No cards";

  return (
    <div className="grid grid-cols-5 gap-3" style={{ minHeight: "82vh" }} {...handlers}>
      {/* Left 20% */}
      <aside className="hidden md:block col-span-1">
        <div className="sticky top-3 space-y-3">
          <div className="rounded-lg border bg-white p-3">
            <div className="text-xs text-neutral-600">Total: {cards.length}</div>
          </div>
        </div>
      </aside>

      {/* Center 60% */}
      <section className="col-span-5 md:col-span-3">
        {/* White panel */}
        <div className="bg-white rounded-2xl border shadow flex flex-col" style={{ minHeight: "82vh" }}>
          {/* header (filter + count + mark) */}
          <div className="flex items-center justify-between px-3 py-2 gap-3">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-neutral-600">{countText}</span>
              <span className="text-neutral-400">•</span>
              <div className="flex gap-1">
                {["all","marked","hard"].map(f => (
                  <button key={f}
                    onClick={()=>{ setFilter(f); setI(0); }}
                    className={`px-2 py-1 rounded-full border text-xs ${filter===f?"bg-neutral-900 text-white":"bg-white"}`}>
                    {f[0].toUpperCase()+f.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            {current && (
              <button onClick={toggleMark}
                className={`px-3 py-1 rounded-md border text-xs ${current.marked ? "bg-purple-600 text-white":"bg-white"}`}>
                ✳︎ Mark
              </button>
            )}
          </div>

          {/* CARD — deep gray background, white text; fills available space */}
          <div className="flex-1 min-h-0 flex items-center justify-center p-3">
            {current ? (
              <button
                onClick={() => setFlipped(f => !f)}
                className={`relative w-full h-full rounded-xl shadow-lg border overflow-hidden transition-transform duration-300 bg-neutral-900 ${flipped ? "rotate-y-180" : ""}`}
                style={{ transformStyle: "preserve-3d" }}
                aria-label="Flip card"
              >
                {/* Front */}
                <div
                  className="absolute inset-0 p-8 flex items-center text-center text-white text-4xl font-bold"
                  style={{ backfaceVisibility: "hidden", fontSize: 32, padding: "clamp(16px,4vw,48px)" }}
                >
                  {current.front}
                </div>
                {/* Back */}
                <div
                  className="absolute inset-0 p-8 flex items-center text-center text-white text-4xl font-bold"
                  style={{ transform: "rotateY(180deg)", backfaceVisibility: "hidden", fontSize: 32, padding: "clamp(16px,4vw,48px)" }}
                >
                  {current.back}
                </div>
              </button>
            ) : (
              <div className="text-neutral-500">Add <code>public/cards.json</code> then reload.</div>
            )}
          </div>

          {/* footer (no action bar; tiny hint only) */}
          <div className="px-3 py-2">
            <div className="text-xs text-neutral-500 text-center">
              Swipe ←/→ to move • ↑ = Hard • ↓/Space = Know • Tap card to flip
            </div>
          </div>
        </div>

        {/* Matrix (filtered view) */}
        <div className="mt-3">
          <div className="rounded-xl border bg-white p-3">
            <div className="text-xs font-medium mb-2">Card Matrix — {filter === "all" ? "All" : filter === "marked" ? "Marked" : "Hard"}</div>
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
                  <button key={id} onClick={() => setI(idx)} className={classes} title={c?.front}>
                    {idx + 1}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* Right 20% */}
      <aside className="hidden md:block col-span-1" />
      <style>{`.rotate-y-180{transform:rotateY(180deg);}`}</style>
    </div>
  );
}

// -------------------- Minimal Test (unchanged behavior) --------------------
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
          <div className="flex-1 flex items-center justify-center p-3">
            {stage === "running" && deck[idx] && (
              <div className="w-full h-full rounded-xl border shadow flex items-center justify-center text-center bg-neutral-900">
                <div className="text-white text-[20px] md:text-5xl lg:text-7xl font-semibold">{deck[idx].front}</div>
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

// -------------------- Root --------------------
export default function App() {
  const [mode, setMode] = useState(load("ui_mode", "study"));
  useEffect(() => { save("ui_mode", mode); }, [mode]);
  useEffect(() => { (async () => { await hydrateFromCardsJson(); })(); }, []);

  return (
    <div className="min-h-screen bg-neutral-100">
      <div className="p-3 flex items-center justify-between">
        <div className="text-sm">🃏 Flash Coach</div>
        <div className="flex items-center gap-2 text-sm">
          <button onClick={() => setMode("study")} className={`px-3 py-1 rounded-full border ${mode==="study"?"bg-neutral-900 text-white":"bg-white"}`}>Study</button>
          <button onClick={() => setMode("test")}  className={`px-3 py-1 rounded-full border ${mode==="test" ?"bg-neutral-900 text-white":"bg-white"}`}>Test</button>
        </div>
      </div>
      <main className="px-2 md:px-4">{mode === "study" ? <StudyMode/> : <TestMode/>}</main>
    </div>
  );
}
