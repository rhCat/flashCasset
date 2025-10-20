import React, { useEffect, useMemo, useRef, useState } from "react";
import { useSwipeable } from "react-swipeable";

/**
 * Flash Coach — Study & Test
 * - Layout: 20/60/20 (grid-cols-5)
 * - Center rows: 5vh header • 70vh card • 5vh actions • rest auto
 * - Study swipes:  Left/Right = navigate, Up = Hard, Down = Know
 * - Test swipes:   Left/Right = Next
 * - Flip: true 3D, only one side visible
 * - Matrix: shows Mark (purple) & Hard (amber) status + current/known
 * - Jump: text input to go to a specific card id
 * - Data: loads from /cards.json (public/)
 *
 * cards.json
 * {
 *   "cards":[{"id":"c0-abate","term":"abate","meaning":"减弱; 缓和"}, ...],
 *   "hard":["c3", ...],
 *   "know":["c0", ...],
 *   "mark":["c2", ...]
 * }
 */

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
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
      lastGrade: 0,     // 0=unseen, 3=hard, 5=know
      marked: false,
    }));
}
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const load = (k, f) => { try { return JSON.parse(localStorage.getItem(k)) ?? f; } catch { return f; } };

// Hydrate from /cards.json → localStorage so both modes read it
async function hydrateFromCardsJson() {
  try {
    const r = await fetch("/cards.json", { cache: "no-store" });
    if (!r.ok) return false;
    const j = await r.json();
    const hardSet = new Set(j.hard || []);
    const knowSet = new Set(j.know || []);
    const markSet = new Set(j.mark || []);
    const studyCards = (j.cards || []).map((c, i) => ({
      id: c.id ?? `r${i}`,
      front: c.term,
      back: c.meaning,
      durationSec: 12,
      ease: 2.5,
      interval: 0,
      reps: 0,
      due: Date.now(),
      lastGrade: knowSet.has(c.id) ? 5 : hardSet.has(c.id) ? 3 : 0,
      marked: markSet.has(c.id),
    }));
    save("study_cards", studyCards);
    save("study_queue", []); // rebuild
    const testCsv = ["front,back,durationSec", ...(j.cards || []).map(c => `${c.term},${c.meaning},12`)].join("\n");
    save("test_deckRaw", testCsv);
    return true;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Study Mode
// -----------------------------------------------------------------------------
function schedule(card, grade) {
  let { ease, interval, reps } = card;
  if (grade < 3) { reps = 0; interval = 0.02; } // still supported if ever needed
  else {
    if (reps === 0) interval = 1;
    else if (reps === 1) interval = 3;
    else interval = Math.max(1, Math.round(interval * ease));
    reps += 1;
    ease = Math.max(1.3, ease + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02)));
  }
  const due = Date.now() + interval * 86400000;
  return { ...card, ease, interval, reps, due, lastGrade: grade };
}

function useStudyDeckFromLocal() {
  const [cards, setCards] = useState(() => load("study_cards", parseDeck(SAMPLE)));
  const [queue, setQueue] = useState(() => load("study_queue", []));
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);

  useEffect(() => { save("study_cards", cards); }, [cards]);
  useEffect(() => { save("study_queue", queue); }, [queue]);

  useEffect(() => {
    if (queue.length === 0) {
      const now = Date.now();
      const due = cards.filter(c => c.due <= now);
      const fresh = cards.filter(c => c.reps === 0);
      const rest = cards.filter(c => c.reps > 0 && c.due > now).sort((a, b) => a.due - b.due);
      setQueue([...due, ...fresh, ...rest].map(c => c.id));
      setIndex(0); setFlipped(false);
    }
  }, [cards, queue.length]);

  const current = useMemo(() => cards.find(c => c.id === queue[index]), [cards, queue, index]);

  function replaceCard(updated) { setCards(cs => cs.map(c => c.id === updated.id ? updated : c)); }
  return { cards, queue, index, setIndex, flipped, setFlipped, current, replaceCard, setCards };
}

function StudyMode() {
  const { cards, queue, index, setIndex, flipped, setFlipped, current, replaceCard } = useStudyDeckFromLocal();
  const [gotoId, setGotoId] = useState("");

  // Swipes: L/R navigate, Up=Hard, Down=Know
  const handlers = useSwipeable({
    onSwipedLeft: () => setIndex(i => Math.min(queue.length - 1, i + 1)),
    onSwipedRight: () => setIndex(i => Math.max(0, i - 1)),
    onSwipedUp: () => handleGrade(3),
    onSwipedDown: () => handleGrade(5),
    trackMouse: true,
    preventScrollOnSwipe: true,
  });

  function handleGrade(g) {
    if (!current) return;
    replaceCard(schedule(current, g));
    // stay on same index (user can swipe to move) or auto-advance on Know:
    if (g === 5) setIndex(i => Math.min(queue.length - 1, i + 1));
    setFlipped(false);
  }

  // Keyboard: arrows & grading
  useEffect(() => {
    function onKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "arrowleft") setIndex(i => Math.max(0, i - 1));
      else if (k === "arrowright" || k === "enter") setIndex(i => Math.min(queue.length - 1, i + 1));
      else if (k === "arrowup") handleGrade(3);
      else if (k === "arrowdown" || k === " ") { e.preventDefault(); handleGrade(5); }
      else if (k === "f") setFlipped(f => !f);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, queue.length]);

  function statusClass(c) {
    // current card is blue; known is green; hard adds amber ring; marked adds purple ring
    let base = "bg-neutral-300";
    if (c?.lastGrade === 5) base = "bg-emerald-600 text-white";
    if (c && c.id === queue[index]) base = "bg-blue-600 text-white";
    const rings = [
      c?.marked ? "ring-2 ring-purple-500" : "",
      c?.lastGrade === 3 ? "ring-2 ring-amber-500" : "",
    ].filter(Boolean).join(" ");
    return `${base} ${rings}`;
  }

  function goToExactId() {
    if (!gotoId) return;
    const i = queue.findIndex(id => id === gotoId);
    if (i >= 0) setIndex(i);
  }

  return (
    <div className="grid grid-cols-5 gap-3" style={{ minHeight: "82vh" }} {...handlers}>
      {/* Left (20%) */}
      <aside className="hidden md:block col-span-1">
        <div className="sticky top-3 space-y-3">
          <div className="rounded-lg border bg-white p-3">
            <div className="text-xs text-neutral-600">Cards: {cards.length}</div>
          </div>
        </div>
      </aside>

      {/* Center (60%) */}
      <section className="col-span-5 md:col-span-3">
        <div className="flex flex-col" style={{ minHeight: "82vh" }}>
          {/* header 5vh */}
          <div className="flex items-center justify-between px-1" style={{ height: "5vh" }}>
            <div className="text-xs text-neutral-600">
              {current ? <>Card {index + 1}/{queue.length}</> : <>No cards loaded</>}
            </div>
            {current && (
              <button
                onClick={() => replaceCard({ ...current, marked: !current.marked })}
                className={`px-3 py-1 rounded-md border text-xs ${current.marked ? "bg-purple-600 text-white" : "bg-white"}`}
                title="Toggle mark"
              >
                ✳︎ Mark
              </button>
            )}
          </div>

          {/* card 70vh — true 3D flip; base 20px */}
          <div className="flex items-center justify-center" style={{ height: "70vh" }}>
            {current ? (
              <button
                onClick={() => setFlipped(f => !f)}
                className={`relative w-full sm:w-5/6 md:w-4/5 lg:w-2/3 h-full rounded-2xl shadow-lg border bg-white overflow-hidden transition-transform duration-300 ${flipped ? "rotate-y-180" : ""}`}
                style={{ transformStyle: "preserve-3d" }}
                aria-label="Flip card"
              >
                {/* Front */}
                <div
                  className="absolute inset-0 p-8 flex items-center justify-center text-center text-[20px] font-semibold"
                  style={{ backfaceVisibility: "hidden" }}
                >
                  {current.front}
                </div>
                {/* Back */}
                <div
                  className="absolute inset-0 p-8 flex items-center justify-center text-center text-[20px] text-neutral-700 bg-white"
                  style={{ transform: "rotateY(180deg)", backfaceVisibility: "hidden" }}
                >
                  {current.back}
                </div>
              </button>
            ) : (
              <div className="text-neutral-500">Add <code>public/cards.json</code> then reload.</div>
            )}
          </div>

          {/* actions 5vh — Prev / Hard / Know / Next */}
          <div className="flex items-center justify-center" style={{ height: "5vh" }}>
            <div className="grid grid-cols-4 gap-3 w-full sm:w-5/6 md:w-4/5 lg:w-2/3">
              <button onClick={() => setIndex(i => Math.max(0, i - 1))} className="w-full py-2 rounded-xl bg-white border text-sm font-medium">← Prev</button>
              <button onClick={() => handleGrade(3)} className="w-full py-2 rounded-xl bg-amber-500 text-white text-sm font-medium">△ Hard (↑)</button>
              <button onClick={() => handleGrade(5)} className="w-full py-2 rounded-xl bg-emerald-600 text-white text-sm font-medium">✓ Know (↓/Space)</button>
              <button onClick={() => setIndex(i => Math.min(queue.length - 1, i + 1))} className="w-full py-2 rounded-xl bg-white border text-sm font-medium">Next →</button>
            </div>
          </div>

          {/* rest */}
          <div className="mt-4 w-full sm:w-5/6 md:w-4/5 lg:w-2/3 mx-auto">
            <details className="p-4 border rounded-xl bg-white">
              <summary className="cursor-pointer text-sm text-neutral-700">Tips</summary>
              <ul className="text-xs text-neutral-600 mt-2 list-disc pl-5 space-y-1">
                <li>Swipe Left/Right to move; Up = Hard; Down = Know; tap card to flip.</li>
                <li>Use the Mark button to flag a card.</li>
                <li>Matrix badges: purple ring = Marked, amber ring = Hard, green = Known, blue = Current.</li>
              </ul>
            </details>
          </div>
        </div>
      </section>

      {/* Right (20%) — Matrix + Go to ID */}
      <aside className="hidden md:block col-span-1">
        <div className="sticky top-3 rounded-lg border bg-white p-3 space-y-3">
          <div>
            <label className="block text-xs text-neutral-600 mb-1">Go to ID</label>
            <div className="flex gap-2">
              <input value={gotoId} onChange={e=>setGotoId(e.target.value)} placeholder="e.g. c0-abate"
                     className="flex-1 border rounded-md px-2 py-1 text-sm" />
              <button onClick={goToExactId} className="px-3 py-1 rounded-md border bg-white text-sm">Go</button>
            </div>
          </div>
          <div>
            <div className="text-xs font-medium mb-2">Card Matrix</div>
            <div className="grid grid-cols-6 gap-2">
              {queue.map((id, i) => {
                const c = cards.find(x => x.id === id);
                return (
                  <button
                    key={id}
                    onClick={() => setIndex(i)}
                    className={`h-8 rounded-md text-xs font-medium ${statusClass(c)}`}
                    title={c?.front}
                  >
                    {i + 1}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </aside>

      <style>{`
        .rotate-y-180 { transform: rotateY(180deg); }
      `}</style>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Test Mode (minor: Left/Right also advance)
// -----------------------------------------------------------------------------
function TestMode() {
  const [deckRaw, setDeckRaw] = useState(load("test_deckRaw", SAMPLE));
  const [secondsPerCard, setSecondsPerCard] = useState(load("test_secondsPerCard", 12));
  const [rubric, setRubric] = useState(load("test_rubric", "Evaluate correctness vs. flashcards and give concise feedback JSON."));
  const [stage, setStage] = useState("setup"); // setup | running | review
  const deck = useMemo(() => parseDeck(deckRaw, secondsPerCard), [deckRaw, secondsPerCard]);

  const [idx, setIdx] = useState(0);
  const [countdown, setCountdown] = useState(secondsPerCard);
  const [recordings, setRecordings] = useState({});
  const mediaRecRef = useRef(null);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const [evalJson, setEvalJson] = useState(null);

  useEffect(() => { save("test_deckRaw", deckRaw); }, [deckRaw]);
  useEffect(() => { save("test_secondsPerCard", secondsPerCard); }, [secondsPerCard]);
  useEffect(() => { save("test_rubric", rubric); }, [rubric]);

  const handlers = useSwipeable({
    onSwipedLeft: () => stage === "running" && nextCard(),
    onSwipedRight: () => stage === "running" && nextCard(),
    trackMouse: true, preventScrollOnSwipe: true
  });

  useEffect(() => { if (stage === "running") startCardRecordingAt(idx); /* eslint-disable-next-line */ }, [stage, idx]);

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
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
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
      alert("Microphone permission is required. On iPhone use HTTPS.");
      console.error(e);
    }
  }

  function startTest() {
    if (!deck.length) { alert("No cards. Paste a deck first."); return; }
    setRecordings({}); setIdx(0); setStage("running");
  }
  function nextCard() {
    stopTimers(); stopCardRecording();
    if (idx + 1 < deck.length) setIdx(i => i + 1);
    else setStage("review");
  }
  useEffect(() => () => { stopTimers(); stopCardRecording(); }, []);
  useEffect(() => {
    function onKey(e) {
      if (stage !== "running") return;
      if (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "Enter" || e.key === " ") { e.preventDefault(); nextCard(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stage, idx]);

  async function processResults() {
    try {
      const meta = { rubric, deckRaw, items: deck.map(({ id, front, back, durationSec }) => ({ id, front, back, durationSec })) };
      const fd = new FormData(); fd.append("meta", JSON.stringify(meta));
      for (const it of deck) { const b = recordings[it.id]; if (b) fd.append(`audio_${it.id}`, b, `${it.id}.webm`); }
      const r = await fetch("/api/process_test", { method: "POST", body: fd });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json(); setEvalJson(j);
    } catch (e) { console.error(e); alert("Processing failed. Ensure backend /api/process_test exists."); }
  }

  function statusClass(i) {
    if (stage === "running") return i === idx ? "bg-blue-600 text-white" : "bg-neutral-300";
    const has = recordings[deck[i]?.id];
    return has ? "bg-emerald-600 text-white" : "bg-neutral-300";
  }

  return (
    <div className="grid grid-cols-5 gap-3" style={{ minHeight: "82vh" }} {...handlers}>
      {/* Left */}
      <aside className="hidden md:block col-span-1">
        <div className="sticky top-3 space-y-3">
          {stage !== "running" && (
            <button onClick={startTest} className="w-full px-3 py-2 rounded-lg bg-emerald-600 text-white text-sm">Start Test</button>
          )}
        </div>
      </aside>

      {/* Center */}
      <section className="col-span-5 md:col-span-3">
        <div className="flex flex-col" style={{ minHeight: "82vh" }}>
          <div className="flex items-center justify-between px-1" style={{ height: "5vh" }}>
            <div className="text-xs text-neutral-600">
              {stage === "running" ? <>Card {idx + 1}/{deck.length} • <b>{countdown}s</b></> : <>Cards: {deck.length}</>}
            </div>
          </div>

          <div className="flex items-center justify-center" style={{ height: "70vh" }}>
            {stage === "setup" && (
              <div className="w-full sm:w-5/6 md:w-4/5 lg:w-2/3 mx-auto">
                <div className="rounded-xl border bg-white p-4">
                  <label className="block text-sm mb-1">Deck (CSV: front,back[,durationSec])</label>
                  <textarea className="w-full h-44 border rounded-xl p-3" value={deckRaw} onChange={e => setDeckRaw(e.target.value)} placeholder={SAMPLE}></textarea>
                  <div className="text-xs text-neutral-500 mt-2">Optional 3rd column sets per-card seconds.</div>
                  <button onClick={startTest} className="mt-3 px-4 py-2 rounded-xl bg-emerald-600 text-white">Start Test</button>
                </div>
              </div>
            )}
            {stage === "running" && deck[idx] && (
              <div className="select-none w-full sm:w-5/6 md:w-4/5 lg:w-2/3 h-full rounded-2xl shadow-lg border bg-white flex items-center justify-center text-center">
                <div className="text-[20px] md:text-5xl lg:text-7xl font-semibold">{deck[idx].front}</div>
              </div>
            )}
            {stage === "review" && (
              <div className="text-neutral-600">Review your recordings on the right; then process results below.</div>
            )}
          </div>

          <div className="flex items-center justify-center" style={{ height: "5vh" }}>
            {stage === "running" ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full sm:w-5/6 md:w-4/5 lg:w-2/3">
                <button onClick={() => nextCard()} className="py-3 rounded-xl bg-blue-600 text-white font-medium">Next (←/→/Enter)</button>
              </div>
            ) : <div className="text-xs text-neutral-600">Ready.</div>}
          </div>

          {stage === "review" && (
            <div className="px-1">
              <div className="rounded-xl border bg-white p-4 sm:w-5/6 md:w-4/5 lg:w-2/3 mx-auto">
                <h4 className="font-medium mb-2">Process Results</h4>
                <button onClick={async () => {
                  try {
                    const meta = { rubric, deckRaw, items: deck.map(({ id, front, back, durationSec }) => ({ id, front, back, durationSec })) };
                    const fd = new FormData(); fd.append("meta", JSON.stringify(meta));
                    for (const it of deck) { const b = recordings[it.id]; if (b) fd.append(`audio_${it.id}`, b, `${it.id}.webm`); }
                    const r = await fetch("/api/process_test", { method: "POST", body: fd });
                    if (!r.ok) throw new Error(`HTTP ${r.status}`);
                    const j = await r.json(); setEvalJson(j);
                  } catch (e) { console.error(e); alert("Processing failed. Ensure backend /api/process_test exists."); }
                }} className="px-4 py-2 rounded-lg bg-emerald-600 text-white">Process with STT + LLM</button>
                {evalJson && (
                  <div className="mt-3 space-y-3">
                    {evalJson.results?.map(r => (
                      <div key={r.id} className="p-3 border rounded-xl">
                        <div className="font-medium">{r.front} — <span className="text-neutral-600">{r.back}</span></div>
                        <div className="text-sm mt-1">{r.feedback}</div>
                        <div className="text-xs mt-1">sim {r.similarity} • f1 {r.f1} • prec {r.precision} • rec {r.recall}</div>
                        {r.missing_keywords?.length > 0 && <div className="text-xs mt-1">Missing: {r.missing_keywords.join(", ")}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Right */}
      <aside className="hidden md:block col-span-1">
        <div className="sticky top-3 rounded-lg border bg-white p-3">
          <div className="text-xs font-medium mb-2">Card Matrix</div>
          <div className="grid grid-cols-6 gap-2">
            {deck.map((_, i) => (
              <button
                key={i}
                onClick={() => stage !== "running" && setIdx(i)}
                className={`h-8 rounded-md text-xs font-medium ${statusClass(i)} ${stage === "running" ? "cursor-not-allowed" : ""}`}
                disabled={stage === "running"}
              >
                {i + 1}
              </button>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Root shell (small 14px title; hydrate cards.json once)
// -----------------------------------------------------------------------------
export default function App() {
  const [mode, setMode] = useState(load("ui_mode", "study"));
  useEffect(() => { save("ui_mode", mode); }, [mode]);

  useEffect(() => { (async () => { await hydrateFromCardsJson(); })(); }, []);

  return (
    <div className="min-h-screen bg-neutral-100">
      <div className="p-3 flex items-center justify-between">
        <div className="text-sm">🃏 Flash Coach</div>
        <div className="flex items-center gap-2 text-sm">
          <button onClick={() => setMode("study")} className={`px-3 py-1 rounded-full border ${mode === "study" ? "bg-neutral-900 text-white" : "bg-white"}`}>Study</button>
          <button onClick={() => setMode("test")}  className={`px-3 py-1 rounded-full border ${mode === "test"  ? "bg-neutral-900 text-white" : "bg-white"}`}>Test</button>
        </div>
      </div>

      <main className="px-2 md:px-4">
        {mode === "study" ? <StudyMode /> : <TestMode />}
      </main>

      <style>{`.rotate-y-180{transform:rotateY(180deg);}`}</style>
    </div>
  );
}
