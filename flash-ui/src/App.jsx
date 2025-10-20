import React, { useEffect, useMemo, useRef, useState } from "react";
import { useSwipeable } from "react-swipeable";

/**
 * Flash Coach — Study & Test
 * Layout: page grid [20% | 60% | 20%], center rows [5vh | 60vh | 5vh | 1fr]
 * Shortcuts: A/1=Again • H/3=Hard • K/5/Space=Know • ←/→/Enter nav • ⌘/Ctrl+K Jump
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
  return rows.filter(r => r[0] && r[1]).map((r, i) => ({
    id: `c${i}-${r[0]}`,
    front: r[0],
    back: r[1],
    durationSec: Number(r[2]) > 0 ? Number(r[2]) : defaultSeconds,
    ease: 2.5, interval: 0, reps: 0, due: Date.now(),
    lastGrade: 0, // 0=unseen, 1=again, 3=hard, 5=know
  }));
}

const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const load = (k, f) => { try { return JSON.parse(localStorage.getItem(k)) ?? f; } catch { return f; } };

// -----------------------------------------------------------------------------
// Jump palette
// -----------------------------------------------------------------------------
function JumpPalette({ open, onClose, items, onSelect, placeholder = "Type to jump…" }) {
  const [q, setQ] = useState("");
  useEffect(() => { if (!open) setQ(""); }, [open]);
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);

  if (!open) return null;
  const res = items.filter(c => c.front.toLowerCase().includes(q.toLowerCase())).slice(0, 30);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-6">
      <div className="w-full max-w-xl bg-white rounded-2xl shadow border">
        <input
          autoFocus value={q} onChange={e => setQ(e.target.value)}
          placeholder={`${placeholder}  (Enter selects, Esc closes)`}
          className="w-full p-3 border-b rounded-t-2xl outline-none"
        />
        <ul className="max-h-72 overflow-auto p-2">
          {res.map(c => (
            <li key={c.id}>
              <button
                onClick={() => { onSelect(c); onClose(); }}
                className="w-full text-left px-3 py-2 rounded-lg hover:bg-neutral-100"
              >
                <span className="font-medium">{c.front}</span>
                <span className="text-neutral-500"> — {c.back}</span>
              </button>
            </li>
          ))}
          {res.length === 0 && <li className="px-3 py-4 text-sm text-neutral-500">No matches.</li>}
        </ul>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Study Mode
// -----------------------------------------------------------------------------
function schedule(card, grade) {
  let { ease, interval, reps } = card;
  if (grade < 3) { reps = 0; interval = 0.02; }
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

function useStudyDeck(initialRaw) {
  const [deckRaw, setDeckRawState] = useState(load("study_deckRaw", initialRaw));
  const [cards, setCards] = useState(() => load("study_cards", parseDeck(initialRaw)));
  const [queue, setQueue] = useState(() => load("study_queue", []));
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);

  useEffect(() => { save("study_deckRaw", deckRaw); }, [deckRaw]);
  useEffect(() => { save("study_cards", cards); }, [cards]);
  useEffect(() => { save("study_queue", queue); }, [queue]);

  // Build queue on load / when cards change
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
  function resetFromRaw(raw) {
    const parsed = parseDeck(raw);
    setDeckRawState(raw); setCards(parsed);
    setQueue([]); setIndex(0); setFlipped(false);
  }

  return { deckRaw, setDeckRaw: resetFromRaw, cards, queue, index, setIndex, flipped, setFlipped, current, replaceCard };
}

function StudyMode() {
  const { deckRaw, setDeckRaw, cards, queue, index, setIndex, flipped, setFlipped, current, replaceCard } = useStudyDeck(SAMPLE);
  const [jumpOpen, setJumpOpen] = useState(false);

  const handlers = useSwipeable({
    onSwipedLeft: () => handleGrade(1),
    onSwipedRight: () => handleGrade(5),
    onSwipedUp: () => handleGrade(3),
    trackMouse: true, preventScrollOnSwipe: true,
  });

  function handleGrade(g) {
    if (!current) return;
    replaceCard(schedule(current, g));
    setIndex(i => Math.min(i + 1, Math.max(0, queue.length - 1)));
    setFlipped(false);
  }

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setJumpOpen(true); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "a" || k === "1") handleGrade(1);
      else if (k === "h" || k === "3") handleGrade(3);
      else if (k === "k" || k === "5" || k === " ") { e.preventDefault(); handleGrade(5); }
      else if (k === "arrowright" || k === "enter") setIndex(i => Math.min(queue.length - 1, i + 1));
      else if (k === "arrowleft") setIndex(i => Math.max(0, i - 1));
      else if (k === "f") setFlipped(f => !f);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, queue.length]);

  function jumpToCard(card) {
    const i = queue.findIndex(id => cards.find(x => x.id === id)?.front === card.front);
    if (i >= 0) setIndex(i);
  }

  // Right matrix color
  function statusClass(c) {
    if (!c) return "bg-neutral-200";
    if (c.id === queue[index]) return "bg-blue-600 text-white";
    if (c.lastGrade === 5) return "bg-emerald-600 text-white";
    if (c.lastGrade === 3) return "bg-amber-500 text-white";
    if (c.lastGrade === 1) return "bg-red-600 text-white";
    return "bg-neutral-300";
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-[20%_60%_20%] min-h-[82vh] gap-3" {...handlers}>
      {/* Left tools */}
      <aside className="hidden md:block">
        <div className="sticky top-3 space-y-3">
          <button onClick={() => setJumpOpen(true)} className="w-full px-3 py-2 rounded-lg border bg-white text-sm">🔎 Jump (⌘/Ctrl+K)</button>
          <div className="rounded-lg border bg-white p-3">
            <div className="text-xs text-neutral-600">Cards: {cards.length}</div>
          </div>
        </div>
      </aside>

      {/* Center column */}
      <section className="grid grid-rows-[5vh_60vh_5vh_1fr]">
        {/* header 5% */}
        <div className="flex items-center justify-between px-1">
          <div className="text-xs text-neutral-600">
            {current ? <>Card {index + 1}/{queue.length}</> : <>No cards queued</>}
          </div>
        </div>

        {/* card 60% */}
        <div className="flex items-center justify-center">
          {current ? (
            <div
              role="button"
              tabIndex={0}
              onClick={() => setFlipped(f => !f)}
              className={`relative block w-full md:w-2/3 lg:w-1/2 max-w-4xl h-[60vh] rounded-2xl shadow-lg border bg-white overflow-hidden transition-transform duration-300 ${flipped ? 'rotate-y-180' : ''}`}
              style={{ transformStyle: 'preserve-3d' }}
            >
              {/* Front */}
              <div className="absolute inset-0 p-8 flex items-center justify-center text-center text-3xl md:text-5xl font-semibold"
                   style={{ backfaceVisibility: 'hidden' }}>
                {current.front}
              </div>
              {/* Back */}
              <div className="absolute inset-0 p-8 flex items-center justify-center text-center text-xl md:text-3xl text-neutral-700 bg-white"
                   style={{ transform: 'rotateY(180deg)', backfaceVisibility: 'hidden' }}>
                {current.back}
              </div>
            </div>
          ) : (
            <div className="text-neutral-500">Paste or import a deck to begin.</div>
          )}
        </div>

        {/* choices 5% */}
        <div className="grid grid-cols-3 gap-3 items-center justify-items-center w-full md:w-2/3 lg:w-1/2 mx-auto">
          <button onClick={() => handleGrade(1)} className="w-full py-2 rounded-xl bg-red-600 text-white text-sm font-medium">✗ Again (A/1)</button>
          <button onClick={() => handleGrade(3)} className="w-full py-2 rounded-xl bg-amber-500 text-white text-sm font-medium">△ Hard (H/3)</button>
          <button onClick={() => handleGrade(5)} className="w-full py-2 rounded-xl bg-emerald-600 text-white text-sm font-medium">✓ Know (K/5/Space)</button>
        </div>

        {/* rest */}
        <div className="mt-4 w-full max-w-3xl mx-auto">
          <details className="p-4 border rounded-xl bg-white">
            <summary className="cursor-pointer text-sm text-neutral-700">Deck & Settings</summary>
            <div className="mt-3 grid gap-3">
              <textarea className="w-full h-40 border rounded-xl p-3" value={deckRaw} onChange={(e)=>setDeckRaw(e.target.value)} placeholder={SAMPLE}></textarea>
              <div className="text-xs text-neutral-500">CSV (front,back[,durationSec]) or <code>front|back</code> per line.</div>
            </div>
          </details>
        </div>
      </section>

      {/* Right matrix */}
      <aside className="hidden md:block">
        <div className="sticky top-3 rounded-lg border bg-white p-3">
          <div className="text-xs font-medium mb-2">Card Matrix</div>
          <div className="grid grid-cols-6 gap-2">
            {queue.map((id, i) => {
              const c = cards.find(x => x.id === id);
              return (
                <button key={id} onClick={() => setIndex(i)}
                        className={`h-8 rounded-md text-xs font-medium ${statusClass(c)}`}>
                  {i + 1}
                </button>
              );
            })}
          </div>
        </div>
      </aside>

      {/* Jump */}
      <JumpPalette open={jumpOpen} onClose={() => setJumpOpen(false)} items={cards} onSelect={jumpToCard} />
    </div>
  );
}

// -----------------------------------------------------------------------------
// Test Mode (timed English-only, no backtracking)
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

  const handlers = useSwipeable({ onSwipedLeft: () => stage === "running" && nextCard("swipe"), trackMouse: true, preventScrollOnSwipe: true });

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
          if (c <= 1) { clearInterval(timerRef.current); nextCard("timeout"); return 0; }
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
      if (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ") { e.preventDefault(); nextCard(); }
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
    if (stage === "running") {
      if (i === idx) return "bg-blue-600 text-white";
      return "bg-neutral-300";
    }
    const has = recordings[deck[i]?.id];
    return has ? "bg-emerald-600 text-white" : "bg-neutral-300";
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-[20%_60%_20%] min-h-[82vh] gap-3" {...handlers}>
      {/* Left tools */}
      <aside className="hidden md:block">
        <div className="sticky top-3 space-y-3">
          {stage !== "running" && (
            <button onClick={startTest} className="w-full px-3 py-2 rounded-lg bg-emerald-600 text-white text-sm">Start Test</button>
          )}
          <div className="rounded-lg border bg-white p-3">
            <div className="text-xs font-medium mb-2">Seconds per card</div>
            <input type="number" className="w-full border rounded-lg p-2" min={5} max={300}
                   value={secondsPerCard} onChange={e => setSecondsPerCard(Number(e.target.value) || 12)} />
          </div>
        </div>
      </aside>

      {/* Center column rows */}
      <section className="grid grid-rows-[5vh_60vh_5vh_1fr]">
        {/* header */}
        <div className="flex items-center justify-between px-1">
          <div className="text-xs text-neutral-600">
            {stage === "running" ? <>Card {idx + 1}/{deck.length} • <b>{countdown}s</b></> : <>Cards: {deck.length}</>}
          </div>
        </div>

        {/* card */}
        <div className="flex items-center justify-center">
          {stage === "setup" && (
            <div className="w-full max-w-3xl mx-auto">
              <div className="rounded-xl border bg-white p-4">
                <label className="block text-sm mb-1">Deck (CSV: front,back[,durationSec])</label>
                <textarea className="w-full h-44 border rounded-xl p-3" value={deckRaw} onChange={e => setDeckRaw(e.target.value)} placeholder={SAMPLE}></textarea>
                <div className="text-xs text-neutral-500 mt-2">Optional 3rd column sets per-card seconds.</div>
                <button onClick={startTest} className="mt-3 px-4 py-2 rounded-xl bg-emerald-600 text-white">Start Test</button>
              </div>
            </div>
          )}
          {stage === "running" && deck[idx] && (
            <div className="block w-full md:w-2/3 lg:w-1/2 max-w-4xl h-[60vh] rounded-2xl shadow-lg border bg-white overflow-hidden flex items-center justify-center">
              <div className="p-8 text-center text-4xl md:text-6xl font-semibold">{deck[idx].front}</div>
            </div>
          )}
          {stage === "review" && <div className="text-neutral-600">Review your recordings on the right; then process results below.</div>}
        </div>

        {/* choices */}
        <div className="flex items-center justify-center">
          {stage === "running" ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full md:w-2/3 lg:w-1/2 max-w-4xl">
              <button onClick={() => nextCard()} className="py-3 rounded-xl bg-blue-600 text-white font-medium">Next (→ / Enter)</button>
            </div>
          ) : <div className="text-xs text-neutral-600">Ready.</div>}
        </div>

        {/* rest (review actions) */}
        {stage === "review" && (
          <div className="px-1">
            <div className="rounded-xl border bg-white p-4 max-w-5xl mx-auto">
              <h4 className="font-medium mb-2">Process Results</h4>
              <button onClick={processResults} className="px-4 py-2 rounded-lg bg-emerald-600 text-white">Process with STT + LLM</button>
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
      </section>

      {/* Right matrix */}
      <aside className="hidden md:block">
        <div className="sticky top-3 rounded-lg border bg-white p-3">
          <div className="text-xs font-medium mb-2">Card Matrix</div>
          <div className="grid grid-cols-6 gap-2">
            {deck.map((_, i) => (
              <button key={i}
                      onClick={() => stage !== "running" && setIdx(i)}
                      className={`h-8 rounded-md text-xs font-medium ${statusClass(i)} ${stage === "running" ? "cursor-not-allowed" : ""}`}
                      disabled={stage === "running"}>
                {i + 1}
              </button>
            ))}
          </div>
          {stage === "running" && <div className="mt-2 text-[11px] text-neutral-500">Matrix disabled during test.</div>}
        </div>
      </aside>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Root Shell (centered, 14px title)
// -----------------------------------------------------------------------------
export default function App() {
  const [mode, setMode] = useState(load("ui_mode", "study"));
  useEffect(() => { save("ui_mode", mode); }, [mode]);

  return (
    <div className="min-h-screen bg-neutral-100 grid grid-cols-1 md:grid-cols-[20%_60%_20%]">
      <div className="hidden md:block" />
      <div className="min-h-screen grid grid-rows-[auto_1fr]">
        <header className="p-3 flex items-center justify-between">
          <h1 className="text-sm font-normal">🃏 Flash Coach</h1>
          <div className="flex items-center gap-2 text-sm">
            <button onClick={() => setMode("study")} className={`px-3 py-1 rounded-full border ${mode === "study" ? "bg-neutral-900 text-white" : "bg-white"}`}>Study</button>
            <button onClick={() => setMode("test")}  className={`px-3 py-1 rounded-full border ${mode === "test"  ? "bg-neutral-900 text-white" : "bg-white"}`}>Test</button>
          </div>
        </header>
        <main className="px-2 md:px-0">
          {mode === "study" ? <StudyMode /> : <TestMode />}
        </main>
      </div>
      <div className="hidden md:block" />
      <style>{`.rotate-y-180{transform:rotateY(180deg);}`}</style>
    </div>
  );
}
