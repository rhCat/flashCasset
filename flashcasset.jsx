import React, { useEffect, useMemo, useRef, useState } from "react";
import { useSwipeable } from "react-swipeable";

/**
 * FlashSwipeCoach.jsx — Test Mode Edition
 *
 * - Start Test -> per-card TIMER begins and mic recording starts.
 * - Swipe Left or press “Next” -> stop recording for current card and advance (no back).
 * - Auto-advance when timer hits 0.
 * - After last card -> Review screen shows players + “Process Results”.
 * - “Process Results” posts all audio + meta to /api/process_test (you provide backend).
 *
 * HTTPS is required on iPhone for mic access.
 */

// -------------------- Helpers --------------------
const SAMPLE = `front,back,durationSec
abate,减弱; 缓和; to lessen in intensity,10
banal,陈腐的; 平庸的; common or overused,10
capricious,反复无常的; given to sudden changes,10`;

function parseDeck(raw, defaultSeconds) {
  const lines = raw.trim().split(/\r?\n/);
  let rows = [];
  if (lines[0].includes(",")) {
    rows = lines.map((l) => l.split(",").map((s) => s.trim()));
  } else if (lines[0].includes("|")) {
    rows = lines.map((l) => l.split("|").map((s) => s.trim()));
  } else {
    rows = lines.map((l) => {
      const [first, ...rest] = l.split(/\s+/);
      return [first, rest.join(" ")];
    });
  }
  if (rows.length && rows[0][0].toLowerCase() === "front") rows.shift();
  return rows
    .filter((r) => r[0] && r[1])
    .map((r, i) => ({
      id: `c${i}-${r[0]}`,
      front: r[0],
      back: r[1],
      durationSec: Number(r[2]) > 0 ? Number(r[2]) : defaultSeconds,
    }));
}

function save(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {}
}
function load(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

// -------------------- Main Component --------------------
export default function FlashSwipeCoach() {
  // Setup
  const [deckRaw, setDeckRawRaw] = useState(load("deckRaw", SAMPLE));
  const [secondsPerCard, setSecondsPerCard] = useState(load("secondsPerCard", 12));
  const [rubric, setRubric] = useState(
    load("rubric", "Evaluate correctness vs. flashcards and give concise feedback JSON.")
  );
  const [flashcards, setFlashcards] = useState(
    load("flashcards", "abate: 减弱; to lessen\nbanal: 陈腐的; common")
  );
  const [stage, setStage] = useState("setup"); // setup | running | review

  // Derived deck for test run
  const deck = useMemo(() => parseDeck(deckRaw, secondsPerCard), [deckRaw, secondsPerCard]);

  // Test state
  const [idx, setIdx] = useState(0);
  const [countdown, setCountdown] = useState(secondsPerCard);
  const [recordings, setRecordings] = useState({}); // { id: Blob }
  const mediaRecRef = useRef(null);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const [flipped, setFlipped] = useState(false);

  useEffect(() => { save("deckRaw", deckRaw); }, [deckRaw]);
  useEffect(() => { save("secondsPerCard", secondsPerCard); }, [secondsPerCard]);
  useEffect(() => { save("rubric", rubric); }, [rubric]);
  useEffect(() => { save("flashcards", flashcards); }, [flashcards]);

  // Swipe: only "next" (left) is allowed during test
  const handlers = useSwipeable({
    onSwipedLeft: () => stage === "running" && nextCard("swipe"),
    trackMouse: true,
    preventScrollOnSwipe: true,
  });

  // --- Recording control per card ---
  async function startCardRecording() {
    stopTimers();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const rec = new MediaRecorder(stream);
      mediaRecRef.current = rec;
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        const blob = new Blob(chunks, { type: "audio/webm" });
        const card = deck[idx];
        if (card) {
          setRecordings((prev) => ({ ...prev, [card.id]: blob }));
        }
        try { stream.getTracks().forEach((t) => t.stop()); } catch {}
      };
      rec.start();
      // Timer for this card
      const dur = deck[idx]?.durationSec || secondsPerCard;
      setCountdown(dur);
      timerRef.current = window.setInterval(() => {
        setCountdown((c) => {
          if (c <= 1) {
            clearInterval(timerRef.current);
            nextCard("timeout");
            return 0;
          }
          return c - 1;
        });
      }, 1000);
    } catch (e) {
      alert("Microphone permission is required. On iPhone use HTTPS.");
      console.error(e);
    }
  }

  function stopCardRecording() {
    try { mediaRecRef.current && mediaRecRef.current.state !== "inactive" && mediaRecRef.current.stop(); } catch {}
    try { streamRef.current && streamRef.current.getTracks().forEach((t) => t.stop()); } catch {}
  }

  function stopTimers() {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  }

  // --- Test flow ---
  async function startTest() {
    if (!deck.length) { alert("No cards. Paste a deck first."); return; }
    setStage("running");
    setIdx(0);
    setRecordings({});
    setFlipped(false);
    await startCardRecording();
  }

  function nextCard(_reason) {
    // terminate recording for current card
    stopTimers();
    stopCardRecording();
    // advance
    if (idx + 1 < deck.length) {
      setIdx((i) => i + 1);
      setFlipped(false);
      // slight delay to ensure the previous recorder fully stops
      setTimeout(() => startCardRecording(), 150);
    } else {
      // finished
      setStage("review");
    }
  }

  function flip() { if (stage === "running") setFlipped((f) => !f); }

  // Cleanup on unmount
  useEffect(() => () => { stopTimers(); stopCardRecording(); }, []);

  // --- Submit all for processing ---
  const [evalJson, setEvalJson] = useState(null);
  async function processResults() {
    try {
      const meta = {
        rubric, flashcards, deckRaw,
        items: deck.map(({ id, front, back, durationSec }) => ({ id, front, back, durationSec })),
      };
      const fd = new FormData();
      fd.append("meta", JSON.stringify(meta));
      // attach audio blobs
      for (const it of deck) {
        const blob = recordings[it.id];
        if (blob) fd.append(`audio_${it.id}`, blob, `${it.id}.webm`);
      }
      const r = await fetch("/api/process_test", { method: "POST", body: fd });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setEvalJson(j);
    } catch (e) {
      console.error(e);
      alert("Processing failed. Ensure backend /api/process_test exists.");
    }
  }

  // -------------------- UI --------------------
  return (
    <div className="min-h-screen bg-neutral-50 flex flex-col" {...handlers}>
      <header className="p-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">🃏 Flash Coach — Test Mode</h1>
        <div className="text-sm text-neutral-600">
          {stage === "running" ? <>Card {idx + 1}/{deck.length} • <b>{countdown}s</b></> : <>Cards: {deck.length}</>}
        </div>
      </header>

      {stage === "setup" && (
        <main className="p-4 grid gap-4">
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm mb-1">Deck (CSV: front,back[,durationSec])</label>
              <textarea className="w-full h-48 border rounded-xl p-3" value={deckRaw} onChange={(e)=>setDeckRawRaw(e.target.value)} placeholder={SAMPLE}></textarea>
              <div className="text-xs text-neutral-500 mt-1">Optional 3rd column sets per-card seconds.</div>
            </div>
            <div className="grid gap-3">
              <div>
                <label className="block text-sm mb-1">Seconds per card (default)</label>
                <input type="number" className="border rounded-xl p-2 w-40" min={5} max={300} value={secondsPerCard} onChange={(e)=>setSecondsPerCard(Number(e.target.value)||12)} />
              </div>
              <div>
                <label className="block text-sm mb-1">Flashcards (EN/CN; one per line)</label>
                <textarea className="w-full h-28 border rounded-xl p-3" value={flashcards} onChange={(e)=>setFlashcards(e.target.value)} placeholder={"abate: 减弱; to lessen\nbanal: 陈腐的; common"} />
              </div>
              <div>
                <label className="block text-sm mb-1">Rubric</label>
                <textarea className="w-full h-28 border rounded-xl p-3" value={rubric} onChange={(e)=>setRubric(e.target.value)} />
              </div>
            </div>
          </div>
          <button onClick={startTest} className="px-5 py-3 rounded-xl bg-emerald-600 text-white font-medium w-full md:w-auto">Start Test</button>
          <div className="text-xs text-neutral-500">Tip: Use HTTPS on iPhone for microphone access.</div>
        </main>
      )}

      {stage === "running" && (
        <main className="flex-1 flex flex-col items-center justify-center p-4 select-none">
          {deck[idx] ? (
            <button onClick={flip} className={`w-full max-w-sm aspect-[3/4] rounded-2xl shadow-lg border bg-white overflow-hidden transition-transform duration-300 ${flipped ? "rotate-y-180" : ""}`} style={{ transformStyle: "preserve-3d" }}>
              <div className="w-full h-full p-6 flex items-center justify-center text-center text-3xl font-semibold" style={{ backfaceVisibility: "hidden" }}>
                {deck[idx].front}
              </div>
              <div className="w-full h-full p-6 flex items-center justify-center text-center text-xl text-neutral-700 absolute inset-0 bg-white" style={{ transform: "rotateY(180deg)", backfaceVisibility: "hidden" }}>
                {deck[idx].back}
              </div>
            </button>
          ) : (
            <div className="text-neutral-500">Loading card…</div>
          )}

          <div className="mt-6 grid grid-cols-2 gap-3 w-full max-w-sm">
            <button onClick={() => nextCard("next")} className="py-3 rounded-xl bg-blue-600 text-white font-medium">Next (stop & advance)</button>
            <button onClick={() => setFlipped((f) => !f)} className="py-3 rounded-xl bg-white border font-medium">Flip</button>
          </div>

          <div className="mt-3 text-sm text-neutral-600">Swipe left to advance. No backtracking during test.</div>
        </main>
      )}

      {stage === "review" && (
        <main className="p-4 grid gap-4">
          <div className="rounded-xl border bg-white p-4">
            <h2 className="font-semibold mb-2">Test Complete</h2>
            <p className="text-sm text-neutral-600">Audio recorded for {Object.keys(recordings).length}/{deck.length} cards.</p>
          </div>

          <div className="grid lg:grid-cols-2 gap-4">
            <div className="rounded-xl border bg-white p-4">
              <h3 className="font-medium mb-2">Recordings</h3>
              <ul className="space-y-2 text-sm">
                {deck.map((it) => (
                  <li key={it.id} className="flex items-center justify-between gap-2">
                    <span className="truncate">{it.front} — {it.back}</span>
                    {recordings[it.id] ? <audio controls src={URL.createObjectURL(recordings[it.id])} /> : <span className="text-neutral-400">(no audio)</span>}
                  </li>
                ))}
              </ul>
            </div>

            <div className="rounded-xl border bg-white p-4">
              <h3 className="font-medium mb-2">Process Results</h3>
              <button onClick={processResults} className="px-4 py-2 rounded-lg bg-emerald-600 text-white">Process with STT + LLM</button>
              {evalJson && <pre className="mt-3 text-xs whitespace-pre-wrap break-words">{JSON.stringify(evalJson, null, 2)}</pre>}
            </div>
          </div>

          <button onClick={() => { setStage("setup"); setIdx(0); setEvalJson(null); }} className="px-4 py-2 rounded-lg border bg-white w-full md:w-auto">New Test</button>
        </main>
      )}

      <style>{`
        .rotate-y-180 { transform: rotateY(180deg); }
      `}</style>
    </div>
  );
}
