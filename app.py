from __future__ import annotations
import os
import json
import uuid
import time
import re
import difflib
from typing import Dict, Any

from fastapi import FastAPI, Request, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# ---------------- helpers: tokenization & normalization ----------------
EN_STOP = set("""
a about above after again against all am an and any are as at be because been before being below between both but by can did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with you your yours yourself yourselves
""".split())


def normalize(txt: str) -> str:
    # lower, remove punctuation but keep CJK chars
    return re.sub(r"\s+", " ", re.sub(r"[^\w\u4e00-\u9fff]+", " ", txt.lower())).strip()


def tokens(txt: str):
    # keep CJK characters as single-token “words”, split latin words
    norm = normalize(txt)
    cjk = re.findall(r"[\u4e00-\u9fff]", norm)
    latin = [w for w in re.findall(
        r"[a-zA-Z]+", norm) if w not in EN_STOP and len(w) > 1]
    return cjk + latin


# ---------------- optional Whisper STT ----------------
USE_WHISPER = os.getenv("USE_WHISPER", "0") == "1"
try:
    import whisper  # type: ignore
    _whisper_model = whisper.load_model(
        os.getenv("WHISPER_MODEL", "base")) if USE_WHISPER else None
except Exception:
    _whisper_model = None
    USE_WHISPER = False

# ---------------- FastAPI app ----------------
app = FastAPI(title="Flash Coach Backend", version="0.1.0")

# CORS for Vite dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://0.0.0.0:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_ROOT = os.environ.get("UPLOAD_ROOT", "./uploads")
os.makedirs(UPLOAD_ROOT, exist_ok=True)


@app.get("/api/health")
async def health():
    return {"ok": True, "ts": time.time()}


@app.post("/api/transcribe")
async def transcribe(file: UploadFile = File(...)):
    """Optional helper used by Study mode. Returns {text}."""
    if USE_WHISPER and _whisper_model is not None:
        tmp_path = os.path.join(UPLOAD_ROOT, f"tmp_{uuid.uuid4().hex}.webm")
        with open(tmp_path, "wb") as f:
            f.write(await file.read())
        try:
            result = _whisper_model.transcribe(tmp_path)
            text = (result.get("text") or "").strip()
        finally:
            try:
                os.remove(tmp_path)
            except OSError:
                pass
        return {"text": text}
    else:
        data = await file.read()
        size_kb = round(len(data)/1024, 1)
        return {"text": f"[stub transcript] {file.filename} ({size_kb} KB)"}


@app.post("/api/process_test")
async def process_test(request: Request):
    """
    Accepts multipart form-data with fields:
      - meta: JSON string containing rubric, flashcards, deckRaw, and items[]
      - audio_<card.id>: UploadFile blobs for each card
    Returns: JSON summary with per-card scoring & feedback.
    """
    form = await request.form()

    # --- Parse meta ---
    meta_raw = form.get("meta")
    if not meta_raw:
        return JSONResponse({"ok": False, "error": "Missing 'meta' field"}, status_code=400)
    try:
        meta: Dict[str, Any] = json.loads(meta_raw)  # type: ignore
    except json.JSONDecodeError as e:
        return JSONResponse({"ok": False, "error": f"Invalid meta JSON: {e}"}, status_code=400)

    # --- Persist a session folder ---
    session_id = uuid.uuid4().hex[:8]
    session_dir = os.path.join(UPLOAD_ROOT, f"session_{session_id}")
    os.makedirs(session_dir, exist_ok=True)

    # --- Collect audio files ---
    saved = []
    for key, value in form.multi_items():
        if not str(key).startswith("audio_"):
            continue
        upload: UploadFile = value  # type: ignore
        card_id = str(key).replace("audio_", "", 1)
        filename = f"{card_id}.webm"
        path = os.path.join(session_dir, filename)
        with open(path, "wb") as f:
            f.write(await upload.read())
        saved.append({
            "field": key,
            "card_id": card_id,
            "filename": filename,
            "path": os.path.abspath(path),
            "size_bytes": os.path.getsize(path),
        })

    # --- STT pass (Whisper or stub) ---
    transcripts: Dict[str, str] = {}
    if USE_WHISPER and _whisper_model is not None:
        for it in saved:
            try:
                result = _whisper_model.transcribe(it["path"])  # type: ignore
                transcripts[it["card_id"]] = (result.get("text") or "").strip()
            except Exception as e:
                transcripts[it["card_id"]] = f"[whisper error] {e}"
    else:
        for it in saved:
            transcripts[it["card_id"]
                        ] = f"[stub transcript for {it['filename']}]"

    # --- Rule-based scoring: keyword coverage + similarity ---
    items = meta.get("items", [])
    results = []

    for it in items:
        cid = it.get("id")
        gold = it.get("back") or ""
        gold_norm = normalize(gold)
        gold_kw = set(tokens(gold))

        transcript = transcripts.get(cid, "")
        got_audio = any(s["card_id"] == cid for s in saved)
        tr_norm = normalize(transcript)
        tr_kw = set(tokens(tr_norm))

        inter = gold_kw & tr_kw
        prec = (len(inter) / max(1, len(tr_kw))) if tr_kw else 0.0
        rec = (len(inter) / max(1, len(gold_kw))) if gold_kw else 0.0
        f1 = 2 * prec * rec / (prec + rec) if (prec + rec) else 0.0
        sim = difflib.SequenceMatcher(
            None, gold_norm, tr_norm).ratio() if tr_norm else 0.0

        if not got_audio:
            feedback = "No audio captured — re-record this card."
        elif not tr_norm:
            feedback = "Audio present but empty transcript (check mic or speak louder)."
        elif f1 >= 0.75 or sim >= 0.8:
            feedback = "Great! You covered the key ideas."
        elif f1 >= 0.45 or sim >= 0.6:
            feedback = "Partial: include the missing keywords shown."
        else:
            feedback = "Low coverage: try to state the core meaning more directly."

        missing = sorted(list(gold_kw - tr_kw))[:6]
        extra = sorted(list(tr_kw - gold_kw))[:6]

        # weighted score (tweak as you like)
        score = round(0.6 * f1 + 0.4 * sim, 3)

        results.append({
            "id": cid,
            "front": it.get("front"),
            "back": gold,
            "durationSec": it.get("durationSec"),
            "has_audio": got_audio,
            "transcript": transcript,
            "similarity": round(sim, 3),
            "precision": round(prec, 3),
            "recall": round(rec, 3),
            "f1": round(f1, 3),
            "missing_keywords": missing,
            "extra_terms": extra,
            "feedback": feedback,
            "score": score,
        })

    payload = {
        "ok": True,
        "session_id": session_id,
        # hide absolute paths
        "saved": [{k: v for k, v in s.items() if k != "path"} for s in saved],
        "meta": {
            "rubric": meta.get("rubric"),
            "flashcards": meta.get("flashcards"),
            "num_items": len(items),
        },
        "results": results,
    }
    return JSONResponse(payload)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", 7861)))
