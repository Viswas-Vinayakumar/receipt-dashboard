import os
import re
import base64
import shutil
import json
import io
import time
import hashlib
import math
import calendar
from collections import defaultdict
from datetime import datetime, date as date_type, timedelta
from statistics import mean, stdev, median
from typing import List
import logging

import httpx
from fastapi import FastAPI, UploadFile, File, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from pydantic import BaseModel

import models
from database import engine, get_db, DATA_DIR

# ── Logging ────────────────────────────────────────────────────────────────
log_file = os.path.join(DATA_DIR, "backend.log")
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[logging.FileHandler(log_file), logging.StreamHandler()]
)
logger = logging.getLogger(__name__)
logger.info("Initializing Backend (Ollama local AI)...")

# ── AI engine config ───────────────────────────────────────────────────────
OLLAMA_URL   = "http://localhost:11434"
OLLAMA_MODEL = "gemma4:e4b"

# NVIDIA NIM (OpenAI-compatible) free cloud vision API
NVIDIA_BASE_URL  = "https://integrate.api.nvidia.com/v1"
# Default → best for German/European receipts (great multilingual OCR)
NVIDIA_MODEL     = "qwen/qwen2.5-vl-72b-instruct"
NVIDIA_MODEL_ALT = "meta/llama-3.2-90b-vision-instruct"   # strong general vision
NVIDIA_MODEL_FAST = "microsoft/phi-3.5-vision-instruct"   # faster, lighter

# Settings file — persists user's chosen engine + NVIDIA API key
SETTINGS_PATH = os.path.expanduser("~/receipt-dashboard/app_data/settings.json")

def _load_settings() -> dict:
    try:
        with open(SETTINGS_PATH, "r") as f:
            return json.load(f)
    except Exception:
        return {}

def _save_settings(s: dict):
    os.makedirs(os.path.dirname(SETTINGS_PATH), exist_ok=True)
    with open(SETTINGS_PATH, "w") as f:
        json.dump(s, f, indent=2)

def _get_engine() -> str:
    """'nvidia' or 'ollama'. Defaults to ollama for backward compat."""
    return _load_settings().get("engine", "ollama")

def _get_nvidia_key() -> str:
    return _load_settings().get("nvidia_api_key", "") or os.environ.get("NVIDIA_API_KEY", "")

# ── Database ───────────────────────────────────────────────────────────────
try:
    models.Base.metadata.create_all(bind=engine)
    logger.info("Database initialized successfully")
except Exception as e:
    logger.error(f"Database initialization failed: {e}")

# ── Schema migration: add image_hash column if missing ─────────────────────
try:
    with engine.connect() as conn:
        cols = [row[1] for row in conn.execute(
            __import__('sqlalchemy').text("PRAGMA table_info(receipts)")
        )]
        if "image_hash" not in cols:
            conn.execute(__import__('sqlalchemy').text(
                "ALTER TABLE receipts ADD COLUMN image_hash VARCHAR"
            ))
            conn.commit()
            logger.info("Migration: added image_hash column")
        # Partial unique index: NULLs don't conflict, so old rows are safe
        conn.execute(__import__('sqlalchemy').text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uix_receipts_image_hash "
            "ON receipts (image_hash) WHERE image_hash IS NOT NULL"
        ))
        conn.commit()
except Exception as e:
    logger.warning(f"Migration warning: {e}")

# ── Backfill image_hash for existing receipts ──────────────────────────────
try:
    from database import SessionLocal
    _db = SessionLocal()
    _missing = _db.query(models.Receipt).filter(models.Receipt.image_hash == None).all()
    _updated = 0
    for _r in _missing:
        if _r.image_path and os.path.exists(_r.image_path):
            try:
                with open(_r.image_path, "rb") as _f:
                    _r.image_hash = hashlib.sha256(_f.read()).hexdigest()
                _updated += 1
            except Exception:
                pass
    if _updated:
        _db.commit()
        logger.info(f"Backfilled image_hash for {_updated} existing receipts")
    _db.close()
except Exception as _e:
    logger.warning(f"Hash backfill warning: {_e}")

# ── Self-learning: category corrections loaded into memory ─────────────────
_CATEGORY_CORRECTIONS: dict = {}   # {product_name_lower: correct_category}

def _load_corrections():
    global _CATEGORY_CORRECTIONS
    try:
        from database import SessionLocal
        _db = SessionLocal()
        rows = _db.query(models.CategoryCorrection).all()
        _CATEGORY_CORRECTIONS = {r.product_name_lower: r.correct_category for r in rows}
        _db.close()
        if _CATEGORY_CORRECTIONS:
            logger.info(f"Loaded {len(_CATEGORY_CORRECTIONS)} learned category corrections")
    except Exception as e:
        logger.warning(f"Could not load category corrections: {e}")

_load_corrections()

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)

UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

# ── Pydantic models ────────────────────────────────────────────────────────
class ReceiptItem(BaseModel):
    product_name: str
    category: str
    price: float

class ReceiptExtraction(BaseModel):
    is_receipt: bool = True
    merchant: str
    location: str
    date: str
    total_amount: float
    items: List[ReceiptItem]

class ManualReceiptIn(BaseModel):
    merchant: str
    location: str = ""
    date: str
    total_amount: float
    items: List[ReceiptItem] = []

class EditReceiptIn(BaseModel):
    merchant: str
    location: str = ""
    date: str
    total_amount: float
    items: List[ReceiptItem] = []

# ── Prompt ─────────────────────────────────────────────────────────────────
VALID_CATEGORIES = {
    "Groceries", "Bakery", "Beverages", "Electronics", "Dining",
    "Transport", "Health", "Accommodation", "Deposit", "Others"
}

# ── Item name blacklist ─────────────────────────────────────────────────────
# AI sometimes extracts total/tax/sum lines as product items — filter them out.
_ITEM_BLACKLIST = {
    "summe","gesamtsumme","gesamtbetrag","gesamt","total","endbetrag",
    "zwischensumme","subtotal","sub-total","grand total","betrag",
    "zu zahlen","zahlbetrag","rechnungsbetrag","endsumme","nettobetrag",
    "bruttobetrag","nettosumme","bruttosumme","mwst","ust","mehrwertsteuer",
    "umsatzsteuer","steuer","tax","vat","rabatt gesamt","gesamtrabatt",
    "summe eur","summe €","total eur","total €",
}
_TOTAL_PREFIXES = ("summe","gesamt","total","endbetrag","zwischensumme","subtotal")

def _is_total_line(name: str) -> bool:
    """Return True if this looks like a total/tax/sum line rather than a real product."""
    lower = name.lower().strip()
    return lower in _ITEM_BLACKLIST or lower.startswith(_TOTAL_PREFIXES)

PROMPT = """You are a receipt parser. Output ONLY a single JSON object, no markdown, no explanation.

NOT a receipt (selfie, landscape, food photo, screenshot): {"is_receipt":false}

For a receipt/bill/invoice extract these fields:

merchant: Exact business name as printed, including branch (e.g. "Kaufland Berlin-Heinersdorf"). Never shorten.
location: Street address or "" if absent.
date: YYYY-MM-DD format. Examples: "18.05.2026"→"2026-05-18", "21.05.26"→"2026-05-21", "16 . 05 . 2026"→"2026-05-16". Two-digit year = 21st century. Use payment/checkout date. If unknown: "2026-05-25".
total_amount: FINAL amount paid as a number (no symbols). Use the LAST/LARGEST "Total"/"Summe"/"Gesamtbetrag"/"Zu zahlen"/"Grand Total" line. European decimals: "12,50"→12.5, "1.234,50"→1234.5. Do NOT use subtotals, tax lines, or deposit amounts.
items: Individual purchased items ONLY. EXCLUDE: any line containing Summe/Total/Gesamt/MwSt/USt/Tax/VAT/Pfand/Deposit/Rabatt/Discount/Subtotal/Zwischensumme or that is clearly a payment/change/rounding line.
  product_name: Translate German/French to English. Expand abbreviations.
  price: Line item price as number.
  category: One of exactly: Groceries, Bakery, Beverages, Electronics, Dining, Transport, Health, Accommodation, Deposit, Others

Output format (no deviations):
{"is_receipt":true,"merchant":"...","location":"...","date":"YYYY-MM-DD","total_amount":0.0,"items":[{"product_name":"...","category":"...","price":0.0}]}"""


# ── Helpers ────────────────────────────────────────────────────────────────
def _extract_json(text: str) -> dict:
    """Strip markdown fences and parse the first complete JSON object found."""
    text = re.sub(r'```(?:json)?\s*', '', text).strip().rstrip('`').strip()
    # Find outermost { }
    depth, start_idx = 0, -1
    for i, ch in enumerate(text):
        if ch == '{':
            if depth == 0:
                start_idx = i
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0 and start_idx >= 0:
                return json.loads(text[start_idx:i + 1])
    raise ValueError(f"No JSON object found in response: {text[:300]}")


def _fix_number(val) -> float:
    """Coerce a value that may be a string like '€12,50' or '1.234,50' to float."""
    if isinstance(val, (int, float)):
        return float(val)
    s = str(val).strip()
    s = re.sub(r'[€£$¥₹\s]', '', s)      # strip currency symbols
    # European format: 1.234,50 → 1234.50
    if re.search(r'\d{1,3}(\.\d{3})+(,\d+)?$', s):
        s = s.replace('.', '').replace(',', '.')
    else:
        s = s.replace(',', '.')
    try:
        return float(re.sub(r'[^\d.]', '', s))
    except Exception:
        return 0.0


def _validate_and_fix(data: dict) -> dict:
    """Post-process AI output: fix types, normalize categories, sanitise fields."""
    if not data.get("is_receipt", True):
        return data

    # total_amount
    data["total_amount"] = _fix_number(data.get("total_amount", 0))

    # date — ensure YYYY-MM-DD
    raw_date = str(data.get("date", "")).strip()
    if not re.match(r'^\d{4}-\d{2}-\d{2}$', raw_date):
        # Try common transforms before giving up
        m = re.search(r'(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})', raw_date)
        if m:
            d, mo, y = m.group(1), m.group(2), m.group(3)
            y = f"20{y}" if len(y) == 2 else y
            data["date"] = f"{y}-{mo.zfill(2)}-{d.zfill(2)}"
        else:
            data["date"] = datetime.today().strftime("%Y-%m-%d")
            logger.warning(f"Could not parse date '{raw_date}', defaulting to today")

    # items
    clean_items = []
    for item in data.get("items", []):
        if not isinstance(item, dict):
            continue
        item["price"] = _fix_number(item.get("price", 0))
        if item.get("category") not in VALID_CATEGORIES:
            item["category"] = "Others"
        pname = item.get("product_name", "").strip()
        if pname and not _is_total_line(pname):
            # Apply any learned category correction from user edits
            correction = _CATEGORY_CORRECTIONS.get(pname.lower())
            if correction:
                item["category"] = correction
                logger.info(f"Applied learned correction: '{pname}' → {correction}")
            clean_items.append(item)
    data["items"] = clean_items

    return data


def preprocess_image(image_data: bytes) -> bytes:
    """Auto-rotate via EXIF, resize to max 1920px, convert to JPEG for speed + accuracy."""
    try:
        from PIL import Image, ExifTags
        img = Image.open(io.BytesIO(image_data))

        # Auto-rotate based on EXIF orientation (phone photos)
        try:
            exif_raw = img.getexif()
            orientation_tag = next(
                (k for k, v in ExifTags.TAGS.items() if v == "Orientation"), None
            )
            if orientation_tag and exif_raw:
                orientation = exif_raw.get(orientation_tag, 1)
                rotations = {3: 180, 6: 270, 8: 90}
                if orientation in rotations:
                    img = img.rotate(rotations[orientation], expand=True)
                    logger.info(f"Auto-rotated image ({orientation} → {rotations[orientation]}°)")
        except Exception as e:
            logger.debug(f"EXIF rotation skipped: {e}")

        # Resize: cap longest edge at 1024px — enough for OCR, ~36% less data than 1280
        MAX_DIM = 1024
        w, h = img.size
        if max(w, h) > MAX_DIM:
            scale = MAX_DIM / max(w, h)
            img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
            logger.info(f"Resized {w}×{h} → {img.size[0]}×{img.size[1]}")

        # Sharpen slightly to improve OCR on resized images
        try:
            from PIL import ImageFilter
            img = img.filter(ImageFilter.UnsharpMask(radius=0.6, percent=120, threshold=2))
        except Exception:
            pass

        # Normalise to RGB JPEG
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=82, optimize=True)
        return buf.getvalue()

    except Exception as e:
        logger.warning(f"Image preprocessing failed ({e}), using original")
        return image_data


def call_nvidia(image_data: bytes) -> dict:
    """Call NVIDIA NIM vision API (OpenAI-compatible). Much faster than local Ollama."""
    api_key = _get_nvidia_key()
    if not api_key:
        raise HTTPException(status_code=400,
            detail="NVIDIA API key not set. Open Settings and paste your key from build.nvidia.com.")

    image_data = preprocess_image(image_data)
    image_b64  = base64.b64encode(image_data).decode()

    settings = _load_settings()
    model = settings.get("nvidia_model", NVIDIA_MODEL)

    # OpenAI-compatible payload with vision content
    payload = {
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": PROMPT},
                {"type": "image_url",
                 "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
            ],
        }],
        "temperature": 0,
        "max_tokens": 1200,
        "response_format": {"type": "json_object"},
    }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }

    for attempt in range(2):
        try:
            with httpx.Client(timeout=60.0) as client:
                resp = client.post(f"{NVIDIA_BASE_URL}/chat/completions",
                                   json=payload, headers=headers)
        except httpx.ConnectError:
            raise HTTPException(status_code=503,
                detail="Can't reach NVIDIA API. Check your internet connection.")
        except httpx.TimeoutException:
            raise HTTPException(status_code=504,
                detail="NVIDIA API timed out — try again or switch to a faster model.")

        if resp.status_code == 401:
            raise HTTPException(status_code=401,
                detail="NVIDIA API key rejected. Check it in Settings.")
        if resp.status_code == 429:
            raise HTTPException(status_code=429,
                detail="NVIDIA rate limit hit. Wait a moment and retry.")
        if resp.status_code != 200:
            raise HTTPException(status_code=500,
                detail=f"NVIDIA error {resp.status_code}: {resp.text[:400]}")

        body = resp.json()
        response_text = (body.get("choices") or [{}])[0].get("message", {}).get("content", "") or ""
        logger.info(f"NVIDIA raw (attempt {attempt+1}, model={model}): {response_text[:500]}")

        try:
            raw = _extract_json(response_text)
            return _validate_and_fix(raw)
        except Exception as e:
            logger.warning(f"NVIDIA parse failed attempt {attempt+1}: {e}")
            if attempt == 1:
                raise ValueError(f"Could not parse NVIDIA response after 2 attempts: {e}")

    raise ValueError("Unexpected exit from call_nvidia")


def call_ai(image_data: bytes) -> dict:
    """Dispatch to whichever AI engine the user has selected."""
    engine = _get_engine()
    if engine == "nvidia":
        return call_nvidia(image_data)
    return call_ollama(image_data)


def call_ollama(image_data: bytes) -> dict:
    """Pre-process image, call Ollama, validate result. Retries once on parse error."""
    image_data = preprocess_image(image_data)
    image_b64  = base64.b64encode(image_data).decode()

    payload = {
        "model":  OLLAMA_MODEL,
        "prompt": PROMPT,
        "images": [image_b64],
        "stream": False,
        "format": "json",
        "options": {"temperature": 0, "num_predict": 800, "num_ctx": 4096},
    }

    for attempt in range(2):
        try:
            with httpx.Client(timeout=200.0) as client:
                resp = client.post(f"{OLLAMA_URL}/api/generate", json=payload)
        except httpx.ConnectError:
            raise HTTPException(status_code=503,
                detail="Ollama is not running. Start it with: ollama serve")
        except httpx.TimeoutException:
            raise HTTPException(status_code=504,
                detail="Ollama timed out — image may be too large or model is loading")

        if resp.status_code != 200:
            raise HTTPException(status_code=500,
                detail=f"Ollama error {resp.status_code}: {resp.text[:300]}")

        response_text = resp.json().get("response", "")
        logger.info(f"Ollama raw (attempt {attempt+1}): {response_text[:500]}")

        try:
            raw = _extract_json(response_text)
            return _validate_and_fix(raw)
        except Exception as e:
            logger.warning(f"Parse failed attempt {attempt+1}: {e}")
            if attempt == 1:
                raise ValueError(f"Could not parse Ollama response after 2 attempts: {e}")

    raise ValueError("Unexpected exit from call_ollama")


# ── Routes ─────────────────────────────────────────────────────────────────
@app.get("/api/health")
async def health_check():
    return {"status": "ok"}


# ── AI engine settings ─────────────────────────────────────────────────────
class EngineSettings(BaseModel):
    engine: str | None = None              # "ollama" | "nvidia"
    nvidia_api_key: str | None = None
    nvidia_model: str | None = None

@app.get("/api/settings")
async def get_settings():
    s = _load_settings()
    key = s.get("nvidia_api_key", "")
    return {
        "engine": s.get("engine", "ollama"),
        "nvidia_model": s.get("nvidia_model", NVIDIA_MODEL),
        # Never return the full key — just a masked preview so UI can show "set / not set"
        "nvidia_key_set":     bool(key),
        "nvidia_key_preview": (key[:6] + "…" + key[-4:]) if key else "",
        "available_engines": [
            {"id": "ollama", "label": "Ollama (local Mac)", "needs_key": False},
            {"id": "nvidia", "label": "NVIDIA Cloud (fast)", "needs_key": True},
        ],
        "available_nvidia_models": [
            {"id": NVIDIA_MODEL,      "label": "Qwen 2.5-VL 72B  ·  best for German receipts"},
            {"id": NVIDIA_MODEL_ALT,  "label": "Llama 3.2 90B Vision  ·  strong all-rounder"},
            {"id": NVIDIA_MODEL_FAST, "label": "Phi 3.5 Vision  ·  fastest"},
        ],
    }

@app.post("/api/settings")
async def update_settings(body: EngineSettings):
    s = _load_settings()
    if body.engine is not None:
        if body.engine not in ("ollama", "nvidia"):
            raise HTTPException(400, "engine must be 'ollama' or 'nvidia'")
        s["engine"] = body.engine
    if body.nvidia_api_key is not None:
        s["nvidia_api_key"] = body.nvidia_api_key.strip()
    if body.nvidia_model is not None:
        s["nvidia_model"] = body.nvidia_model
    _save_settings(s)
    logger.info(f"Settings updated: engine={s.get('engine')}, has_key={bool(s.get('nvidia_api_key'))}")
    return {"status": "ok", "engine": s.get("engine", "ollama")}


@app.post("/api/upload")
async def upload_receipt(file: UploadFile = File(...), db: Session = Depends(get_db)):
    logger.info(f"Upload: {file.filename}")

    file_path = os.path.join(UPLOAD_DIR, f"{datetime.now().timestamp()}_{file.filename}")
    with open(file_path, "wb") as buf:
        shutil.copyfileobj(file.file, buf)

    try:
        with open(file_path, "rb") as f:
            image_data = f.read()

        # ── Duplicate check: exact image hash ──────────────────────────────
        image_hash = hashlib.sha256(image_data).hexdigest()
        existing = db.query(models.Receipt).filter(
            models.Receipt.image_hash == image_hash
        ).first()
        if existing:
            try: os.remove(file_path)
            except Exception: pass
            logger.info(f"Duplicate detected (hash): receipt #{existing.id}")
            raise HTTPException(status_code=409, detail=json.dumps({
                "reason": "exact_duplicate",
                "existing_id": existing.id,
                "merchant": existing.merchant or "",
                "date": existing.date or "",
                "amount": existing.total_amount or 0,
            }))

        engine = _get_engine()
        logger.info(f"Calling AI engine: {engine}")
        raw = call_ai(image_data)
        logger.info(f"Parsed: {raw}")

        if not raw.get("is_receipt", True):
            try: os.remove(file_path)
            except Exception: pass
            raise HTTPException(status_code=400, detail="not_a_receipt")

        extraction = ReceiptExtraction(**raw)

        # ── Duplicate check: same merchant + date + amount ─────────────────
        semantic_dup = None
        if extraction.merchant and extraction.date and extraction.total_amount:
            semantic_dup = db.query(models.Receipt).filter(
                models.Receipt.merchant == extraction.merchant,
                models.Receipt.date == extraction.date,
                models.Receipt.total_amount == extraction.total_amount,
            ).first()

        db_receipt = models.Receipt(
            image_path=file_path,
            image_hash=image_hash,
            merchant=extraction.merchant,
            location=extraction.location,
            date=extraction.date,
            total_amount=extraction.total_amount
        )
        db.add(db_receipt); db.commit(); db.refresh(db_receipt)

        for item in extraction.items:
            db.add(models.Item(
                receipt_id=db_receipt.id,
                product_name=item.product_name,
                category=item.category,
                price=item.price
            ))
        db.commit()
        logger.info(f"Saved: {extraction.merchant} €{extraction.total_amount}")

        resp: dict = {"status": "success", "data": extraction.dict()}
        if semantic_dup:
            logger.info(f"Possible semantic duplicate of receipt #{semantic_dup.id}")
            resp["warning"] = "possible_duplicate"
            resp["existing"] = {
                "id": semantic_dup.id,
                "merchant": semantic_dup.merchant or "",
                "date": semantic_dup.date or "",
                "amount": semantic_dup.total_amount or 0,
            }
        return resp

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/receipts/manual")
async def add_manual_receipt(data: ManualReceiptIn, db: Session = Depends(get_db)):
    db_receipt = models.Receipt(
        image_path="", merchant=data.merchant, location=data.location,
        date=data.date, total_amount=data.total_amount
    )
    db.add(db_receipt); db.commit(); db.refresh(db_receipt)
    for item in data.items:
        db.add(models.Item(receipt_id=db_receipt.id,
            product_name=item.product_name, category=item.category, price=item.price))
    db.commit()
    logger.info(f"Manual receipt: {data.merchant}")
    return {"status": "success", "id": db_receipt.id}


@app.put("/api/receipts/{receipt_id}")
async def edit_receipt(receipt_id: int, data: EditReceiptIn, db: Session = Depends(get_db)):
    receipt = db.query(models.Receipt).filter(models.Receipt.id == receipt_id).first()
    if not receipt:
        raise HTTPException(status_code=404, detail="Receipt not found")

    # ── Self-learning: capture category corrections before overwriting items ──
    old_items = {
        i.product_name.lower().strip(): i.category
        for i in db.query(models.Item).filter(models.Item.receipt_id == receipt_id).all()
    }

    receipt.merchant = data.merchant; receipt.location = data.location
    receipt.date = data.date; receipt.total_amount = data.total_amount
    db.query(models.Item).filter(models.Item.receipt_id == receipt_id).delete()

    learned = 0
    for item in data.items:
        db.add(models.Item(receipt_id=receipt_id,
            product_name=item.product_name, category=item.category, price=item.price))

        # Compare with old category — if user changed it, learn the correction
        name_lower = item.product_name.lower().strip()
        old_cat = old_items.get(name_lower)
        if old_cat and old_cat != item.category:
            existing = db.query(models.CategoryCorrection).filter(
                models.CategoryCorrection.product_name_lower == name_lower
            ).first()
            if existing:
                existing.correct_category = item.category
                existing.correction_count += 1
                existing.last_updated = datetime.utcnow()
            else:
                db.add(models.CategoryCorrection(
                    product_name_lower=name_lower,
                    correct_category=item.category
                ))
            _CATEGORY_CORRECTIONS[name_lower] = item.category   # update in-memory
            logger.info(f"Learned correction: '{item.product_name}' → {item.category}")
            learned += 1

    db.commit()
    logger.info(f"Updated receipt {receipt_id}" + (f", learned {learned} corrections" if learned else ""))
    return {"status": "success", "corrections_learned": learned}


@app.get("/api/dashboard")
async def get_dashboard_data(db: Session = Depends(get_db)):
    receipts = db.query(models.Receipt).order_by(models.Receipt.upload_date.desc()).all()
    items    = db.query(models.Item).all()

    total_spent    = sum(r.total_amount for r in receipts)
    category_data: dict = {}
    receipt_categories: dict = {}
    monthly: dict = defaultdict(float)

    for item in items:
        if item.category not in category_data:
            category_data[item.category] = {"amount": 0.0, "count": 0}
        category_data[item.category]["amount"] += item.price
        category_data[item.category]["count"]  += 1
        rc = receipt_categories.setdefault(item.receipt_id, {})
        rc[item.category] = rc.get(item.category, 0.0) + item.price

    # Rolling 12-month window — receipts older than 12 months ago are excluded
    # from the trend chart so stale/test data doesn't distort the timeline.
    _now_dt        = datetime.now()
    _current_month = _now_dt.strftime("%Y-%m")
    # First day of the month 12 months ago, expressed as "YYYY-MM"
    _cutoff_year   = _now_dt.year - 1 if _now_dt.month > 1 else _now_dt.year - 2
    _cutoff_month  = _now_dt.month - 1 if _now_dt.month > 1 else 12
    _cutoff        = f"{_cutoff_year}-{str(_cutoff_month).zfill(2)}"

    daily: dict = defaultdict(float)
    for r in receipts:
        if r.date and len(r.date) >= 7:
            # Only include months within the rolling 12-month window
            if r.date[:7] >= _cutoff:
                monthly[r.date[:7]] += r.total_amount
        if r.date and len(r.date) == 10:
            # Daily trend shows current month only (granular "this month" view)
            if r.date[:7] == _current_month:
                daily[r.date] += r.total_amount

    top_cat = max(category_data, key=lambda c: category_data[c]["amount"]) if category_data else "N/A"

    def top_cat_for(rid):
        cats = receipt_categories.get(rid, {})
        return max(cats, key=cats.get) if cats else "Others"

    # ── Month-over-month ───────────────────────────────────────────────────
    _now = datetime.now()
    current_month_str = _now.strftime("%Y-%m")
    prev_month_str = f"{_now.year - 1}-12" if _now.month == 1 else f"{_now.year}-{str(_now.month - 1).zfill(2)}"
    current_month_receipts = [r for r in receipts if r.date and r.date[:7] == current_month_str]
    current_month_total    = sum(r.total_amount for r in current_month_receipts)
    current_receipt_count  = len(current_month_receipts)
    prev_month_total       = sum(r.total_amount for r in receipts if r.date and r.date[:7] == prev_month_str)
    mom_delta_pct = round(((current_month_total - prev_month_total) / prev_month_total) * 100, 1) \
                    if prev_month_total > 0 else None

    return {
        "total_spent":    round(total_spent, 2),
        "receipt_count":  len(receipts),
        "top_category":   top_cat,
        "category_spend": sorted([
            {"name": c, "value": round(d["amount"], 2), "count": d["count"]}
            for c, d in category_data.items()], key=lambda x: x["value"], reverse=True),
        "monthly_trend": sorted([
            {"month": k, "total": round(v, 2)} for k, v in monthly.items()],
            key=lambda x: x["month"]),
        "daily_trend": sorted([
            {"date": k, "total": round(v, 2)} for k, v in daily.items()],
            key=lambda x: x["date"]),
        "recent_receipts": [
            {
                "id": r.id, "merchant": r.merchant, "date": r.date,
                "total_amount": r.total_amount, "category": top_cat_for(r.id),
                "has_image": bool(r.image_path and os.path.exists(r.image_path))
            }
            for r in receipts],
        "mom": {
            "current_month":         current_month_str,
            "current_total":         round(current_month_total, 2),
            "current_receipt_count": current_receipt_count,
            "prev_month":            prev_month_str,
            "prev_total":            round(prev_month_total, 2),
            "delta_pct":             mom_delta_pct
        }
    }


@app.get("/api/receipts")
async def get_receipts(db: Session = Depends(get_db)):
    receipts = db.query(models.Receipt).order_by(models.Receipt.upload_date.desc()).all()
    return [
        {"id": r.id, "merchant": r.merchant, "location": r.location,
         "date": r.date, "total_amount": r.total_amount,
         "has_image": bool(r.image_path and os.path.exists(r.image_path)),
         "items": [{"product_name": i.product_name, "category": i.category, "price": i.price}
                   for i in db.query(models.Item).filter(models.Item.receipt_id == r.id).all()]}
        for r in receipts]


@app.get("/api/receipts/{receipt_id}/image")
async def get_receipt_image(receipt_id: int, db: Session = Depends(get_db)):
    """Return the original receipt image as base64-encoded JSON (JPEG/PNG)."""
    receipt = db.query(models.Receipt).filter(models.Receipt.id == receipt_id).first()
    if not receipt:
        raise HTTPException(status_code=404, detail="Receipt not found")
    if not receipt.image_path or not os.path.exists(receipt.image_path):
        raise HTTPException(status_code=404, detail="Image not found")
    with open(receipt.image_path, "rb") as f:
        img_data = f.read()
    ext  = os.path.splitext(receipt.image_path)[1].lower()
    mime = "image/png" if ext == ".png" else "image/jpeg"
    return {"data": base64.b64encode(img_data).decode(), "mime": mime}


@app.get("/api/receipts/{receipt_id}")
async def get_receipt(receipt_id: int, db: Session = Depends(get_db)):
    """Single receipt detail — faster than loading the full list."""
    receipt = db.query(models.Receipt).filter(models.Receipt.id == receipt_id).first()
    if not receipt:
        raise HTTPException(status_code=404, detail="Receipt not found")
    items = db.query(models.Item).filter(models.Item.receipt_id == receipt_id).all()
    return {
        "id":           receipt.id,
        "merchant":     receipt.merchant or "",
        "location":     receipt.location or "",
        "date":         receipt.date or "",
        "total_amount": receipt.total_amount or 0,
        "has_image":    bool(receipt.image_path and os.path.exists(receipt.image_path)),
        "items": [
            {"product_name": i.product_name, "category": i.category, "price": i.price}
            for i in items
        ]
    }


@app.delete("/api/receipts/{receipt_id}")
async def delete_receipt(receipt_id: int, db: Session = Depends(get_db)):
    receipt = db.query(models.Receipt).filter(models.Receipt.id == receipt_id).first()
    if not receipt:
        raise HTTPException(status_code=404, detail="Receipt not found")
    try:
        if receipt.image_path and os.path.exists(receipt.image_path):
            os.remove(receipt.image_path)
    except Exception as e:
        logger.warning(f"Image delete error: {e}")
    db.query(models.Item).filter(models.Item.receipt_id == receipt_id).delete()
    db.delete(receipt); db.commit()
    return {"status": "success"}


@app.get("/api/insights")
async def get_insights(db: Session = Depends(get_db)):
    receipts = db.query(models.Receipt).all()
    items    = db.query(models.Item).all()

    # ── By store ──────────────────────────────────────────────────────────────
    store_data: dict = {}
    for r in receipts:
        if r.merchant not in store_data:
            store_data[r.merchant] = {"total": 0.0, "count": 0}
        store_data[r.merchant]["total"] += r.total_amount
        store_data[r.merchant]["count"] += 1

    by_store = sorted(
        [{"merchant": k, "total": round(v["total"], 2), "visits": v["count"]}
         for k, v in store_data.items()],
        key=lambda x: x["total"], reverse=True
    )

    # ── By product ────────────────────────────────────────────────────────────
    product_data: dict = {}
    for item in items:
        name = item.product_name
        if not name or _is_total_line(name):
            continue
        if name not in product_data:
            product_data[name] = {"total": 0.0, "count": 0}
        product_data[name]["total"] += item.price
        product_data[name]["count"] += 1

    by_product = sorted(
        [{"name": k, "total": round(v["total"], 2), "count": v["count"]}
         for k, v in product_data.items()],
        key=lambda x: x["total"], reverse=True
    )[:30]

    # ── By month (rolling 12 months — matches the trend chart window) ────────
    _ins_now      = datetime.now()
    _ins_cy       = _ins_now.year - 1 if _ins_now.month > 1 else _ins_now.year - 2
    _ins_cm       = _ins_now.month - 1 if _ins_now.month > 1 else 12
    _ins_cutoff   = f"{_ins_cy}-{str(_ins_cm).zfill(2)}"

    month_product: dict = defaultdict(lambda: defaultdict(float))
    receipt_month: dict = {
        r.id: r.date[:7] for r in receipts
        if r.date and len(r.date) >= 7 and r.date[:7] >= _ins_cutoff
    }

    for item in items:
        if not item.product_name or _is_total_line(item.product_name):
            continue
        month = receipt_month.get(item.receipt_id)
        if month:
            month_product[month][item.product_name] += item.price

    # Also include months that have receipts but no items
    receipt_month_totals: dict = defaultdict(float)
    for r in receipts:
        if r.date and len(r.date) >= 7 and r.date[:7] >= _ins_cutoff:
            receipt_month_totals[r.date[:7]] += r.total_amount

    by_month = sorted([
        {
            "month": m,
            "month_total": round(receipt_month_totals.get(m, 0), 2),
            "products": sorted(
                [{"name": p, "total": round(t, 2)} for p, t in prods.items()],
                key=lambda x: x["total"], reverse=True
            )[:15]
        }
        for m, prods in month_product.items()
    ], key=lambda x: x["month"], reverse=True)

    return {"by_store": by_store, "by_product": by_product, "by_month": by_month}


@app.get("/api/analytics")
async def get_analytics(db: Session = Depends(get_db)):
    receipts = db.query(models.Receipt).order_by(models.Receipt.date).all()
    items    = db.query(models.Item).all()

    if not receipts:
        return {"status": "no_data", "corrections_learned": len(_CATEGORY_CORRECTIONS)}

    receipt_date_map = {r.id: r.date for r in receipts}

    # ── 1. SPENDING FORECAST ─────────────────────────────────────────────────
    forecast = None
    try:
        now = datetime.now()
        cur_month = now.strftime("%Y-%m")
        daily: dict = defaultdict(float)
        for r in receipts:
            if r.date and len(r.date) == 10:
                daily[r.date] += r.total_amount

        month_days = sorted(
            [(d, v) for d, v in daily.items() if d[:7] == cur_month],
            key=lambda x: x[0]
        )
        if len(month_days) >= 2:
            # Build cumulative series by calendar day number
            xs, ys = [], []
            running = 0.0
            for d_str, amt in month_days:
                running += amt
                xs.append(int(d_str[8:10]))
                ys.append(running)
            # Ordinary Least Squares linear regression
            n = len(xs)
            sx, sy = sum(xs), sum(ys)
            sxy = sum(x * y for x, y in zip(xs, ys))
            sx2 = sum(x * x for x in xs)
            denom = n * sx2 - sx * sx
            if denom:
                slope = (n * sxy - sx * sy) / denom
                intercept = (sy - slope * sx) / n
                days_in_month = calendar.monthrange(now.year, now.month)[1]
                predicted = slope * days_in_month + intercept
                current_total = ys[-1]
                forecast = {
                    "current_total":    round(current_total, 2),
                    "predicted_total":  round(max(predicted, current_total), 2),
                    "current_day":      now.day,
                    "days_in_month":    days_in_month,
                    "daily_avg":        round(current_total / now.day, 2),
                    "remaining_days":   days_in_month - now.day,
                }
    except Exception as e:
        logger.warning(f"Forecast error: {e}")

    # ── 2. ANOMALY DETECTION (Z-score per merchant) ───────────────────────────
    anomalies = []
    try:
        merchant_amounts: dict = defaultdict(list)
        for r in receipts:
            merchant_amounts[r.merchant].append((r.id, r.total_amount, r.date))

        for merchant, records in merchant_amounts.items():
            if len(records) < 3:
                continue
            amounts = [x[1] for x in records]
            m = mean(amounts)
            s = stdev(amounts)
            if s == 0:
                continue
            for rid, amt, dt in records:
                z = (amt - m) / s
                if z > 1.9:
                    anomalies.append({
                        "receipt_id": rid,
                        "merchant":   merchant,
                        "date":       dt,
                        "amount":     round(amt, 2),
                        "typical":    round(m, 2),
                        "z_score":    round(z, 1),
                        "severity":   "high" if z > 3.0 else "medium",
                        "pct_above":  round((amt - m) / m * 100, 0),
                    })
        anomalies.sort(key=lambda x: x["z_score"], reverse=True)
    except Exception as e:
        logger.warning(f"Anomaly error: {e}")

    # ── 3. PRICE INTELLIGENCE ────────────────────────────────────────────────
    price_trends = []
    try:
        price_history: dict = defaultdict(list)
        for item in items:
            if not item.product_name or _is_total_line(item.product_name):
                continue
            dt = receipt_date_map.get(item.receipt_id)
            if dt and item.price > 0:
                price_history[item.product_name].append((dt, item.price))

        for product, history in price_history.items():
            if len(history) < 2:
                continue
            history.sort(key=lambda x: x[0])
            first_price  = history[0][1]
            latest_price = history[-1][1]
            if first_price == 0:
                continue
            pct = (latest_price - first_price) / first_price * 100
            if abs(pct) < 5:   # ignore tiny fluctuations
                continue
            price_trends.append({
                "product":      product,
                "first_price":  round(first_price, 2),
                "latest_price": round(latest_price, 2),
                "pct_change":   round(pct, 1),
                "first_date":   history[0][0],
                "latest_date":  history[-1][0],
                "occurrences":  len(history),
                "direction":    "up" if pct > 0 else "down",
            })
        price_trends.sort(key=lambda x: abs(x["pct_change"]), reverse=True)
        price_trends = price_trends[:15]
    except Exception as e:
        logger.warning(f"Price trend error: {e}")

    # ── 4. RECURRING PATTERN DETECTION ──────────────────────────────────────
    recurring = []
    try:
        merchant_visits: dict = defaultdict(list)
        for r in receipts:
            if r.date and r.merchant:
                merchant_visits[r.merchant].append(r.date)

        today = date_type.today()
        for merchant, dates in merchant_visits.items():
            if len(dates) < 3:
                continue
            sorted_dates = sorted(dates)
            gaps = []
            for i in range(1, len(sorted_dates)):
                d1 = date_type.fromisoformat(sorted_dates[i - 1])
                d2 = date_type.fromisoformat(sorted_dates[i])
                gaps.append((d2 - d1).days)
            if not gaps:
                continue
            avg_gap = mean(gaps)
            if avg_gap < 2:
                continue
            gap_std = stdev(gaps) if len(gaps) >= 2 else 0
            consistency = 1.0 - min(gap_std / avg_gap, 1.0) if avg_gap > 0 else 0

            if consistency < 0.4 or avg_gap > 120:
                continue

            last_date  = date_type.fromisoformat(sorted_dates[-1])
            next_visit = last_date + timedelta(days=round(avg_gap))
            days_until = (next_visit - today).days

            if   avg_gap <= 9:  pattern = "weekly"
            elif avg_gap <= 18: pattern = "bi-weekly"
            elif avg_gap <= 45: pattern = "monthly"
            else:               pattern = "quarterly"

            recurring.append({
                "merchant":         merchant,
                "visit_count":      len(dates),
                "avg_gap_days":     round(avg_gap, 1),
                "pattern":          pattern,
                "last_visit":       sorted_dates[-1],
                "next_expected":    str(next_visit),
                "days_until_next":  days_until,
                "consistency":      round(consistency, 2),
            })
        recurring.sort(key=lambda x: x["consistency"], reverse=True)
    except Exception as e:
        logger.warning(f"Recurring error: {e}")

    # ── 5. RECEIPT QUALITY CHECK ─────────────────────────────────────────────
    quality_issues = []
    try:
        item_sums: dict = defaultdict(float)
        for item in items:
            if not _is_total_line(item.product_name or ""):
                item_sums[item.receipt_id] += item.price

        for r in receipts:
            if r.id not in item_sums or not r.total_amount:
                continue
            s = item_sums[r.id]
            diff = abs(s - r.total_amount)
            pct  = diff / r.total_amount * 100
            if pct > 10 and diff > 0.5:
                quality_issues.append({
                    "receipt_id":  r.id,
                    "merchant":    r.merchant,
                    "date":        r.date,
                    "total":       round(r.total_amount, 2),
                    "items_sum":   round(s, 2),
                    "gap":         round(diff, 2),
                    "pct_off":     round(pct, 1),
                })
        quality_issues.sort(key=lambda x: x["pct_off"], reverse=True)
    except Exception as e:
        logger.warning(f"Quality check error: {e}")

    # ── 6. CATEGORY MOMENTUM ─────────────────────────────────────────────────
    category_momentum = []
    try:
        now = datetime.now()
        cur_m = now.strftime("%Y-%m")
        prev_months = []
        y, mo = now.year, now.month
        for _ in range(3):
            mo -= 1
            if mo == 0: mo = 12; y -= 1
            prev_months.append(f"{y}-{str(mo).zfill(2)}")

        receipt_month = {r.id: r.date[:7] for r in receipts if r.date and len(r.date) >= 7}
        cat_monthly: dict = defaultdict(lambda: defaultdict(float))
        for item in items:
            month = receipt_month.get(item.receipt_id)
            if month:
                cat_monthly[item.category][month] += item.price

        for cat, monthly in cat_monthly.items():
            cur_val  = monthly.get(cur_m, 0)
            prev_vals = [monthly.get(m, 0) for m in prev_months]
            prev_avg = mean(prev_vals) if any(v > 0 for v in prev_vals) else 0
            if cur_val == 0 and prev_avg == 0:
                continue
            momentum = ((cur_val - prev_avg) / prev_avg * 100) if prev_avg > 0 else (100 if cur_val > 0 else 0)
            category_momentum.append({
                "category":  cat,
                "current":   round(cur_val, 2),
                "prev_avg":  round(prev_avg, 2),
                "momentum":  round(momentum, 1),
                "trend":     "rising" if momentum > 15 else "falling" if momentum < -15 else "stable",
            })
        category_momentum.sort(key=lambda x: abs(x["momentum"]), reverse=True)
    except Exception as e:
        logger.warning(f"Momentum error: {e}")

    # ── 7. MERCHANT CHAINS (simple prefix grouping) ──────────────────────────
    chains = []
    try:
        merchant_totals: dict = defaultdict(lambda: {"total": 0.0, "visits": 0, "merchants": set()})
        for r in receipts:
            if not r.merchant:
                continue
            # Extract first word as chain key (e.g. "Kaufland Berlin" → "Kaufland")
            chain_key = r.merchant.split()[0].rstrip(',:;')
            merchant_totals[chain_key]["total"]    += r.total_amount
            merchant_totals[chain_key]["visits"]   += 1
            merchant_totals[chain_key]["merchants"].add(r.merchant)

        for chain, d in merchant_totals.items():
            if len(d["merchants"]) > 1:   # only show if multiple branches detected
                chains.append({
                    "chain":     chain,
                    "branches":  list(d["merchants"]),
                    "total":     round(d["total"], 2),
                    "visits":    d["visits"],
                })
        chains.sort(key=lambda x: x["total"], reverse=True)
    except Exception as e:
        logger.warning(f"Chain error: {e}")

    return {
        "status":               "ok",
        "forecast":             forecast,
        "anomalies":            anomalies,
        "price_trends":         price_trends,
        "recurring":            recurring,
        "quality_issues":       quality_issues,
        "category_momentum":    category_momentum,
        "chains":               chains,
        "corrections_learned":  len(_CATEGORY_CORRECTIONS),
        "corrections":          [
            {"product": k, "category": v}
            for k, v in sorted(_CATEGORY_CORRECTIONS.items())
        ],
    }


@app.post("/api/reset")
async def reset_data(db: Session = Depends(get_db)):
    for fn in os.listdir(UPLOAD_DIR):
        fp = os.path.join(UPLOAD_DIR, fn)
        try:
            if os.path.isfile(fp): os.unlink(fp)
        except Exception as e:
            logger.warning(f"File delete error: {e}")
    db.query(models.Item).delete()
    db.query(models.Receipt).delete()
    db.commit()
    return {"status": "success"}


if __name__ == "__main__":
    import uvicorn, subprocess

    try:
        cur = str(os.getpid())
        pids = subprocess.check_output("lsof -ti :8888", shell=True).decode().split()
        for p in pids:
            if p != cur:
                subprocess.run(f"kill -9 {p}", shell=True)
        time.sleep(0.3)
    except Exception:
        pass

    # Bind to 0.0.0.0 so the phone can reach the backend over WiFi.
    # On the desktop app, localhost still works fine because 0.0.0.0 listens on all interfaces.
    uvicorn.run(app, host="0.0.0.0", port=8888)
