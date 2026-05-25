import os
import re
import base64
import shutil
import json
import io
import time
import hashlib
from collections import defaultdict
from datetime import datetime
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

# ── Ollama config ──────────────────────────────────────────────────────────
OLLAMA_URL   = "http://localhost:11434"
OLLAMA_MODEL = "gemma4:e4b"

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

        logger.info(f"Calling Ollama ({OLLAMA_MODEL})...")
        raw = call_ollama(image_data)
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
    receipt.merchant = data.merchant; receipt.location = data.location
    receipt.date = data.date; receipt.total_amount = data.total_amount
    db.query(models.Item).filter(models.Item.receipt_id == receipt_id).delete()
    for item in data.items:
        db.add(models.Item(receipt_id=receipt_id,
            product_name=item.product_name, category=item.category, price=item.price))
    db.commit()
    logger.info(f"Updated receipt {receipt_id}")
    return {"status": "success"}


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

    daily: dict = defaultdict(float)
    for r in receipts:
        if r.date and len(r.date) >= 7:
            monthly[r.date[:7]] += r.total_amount
        if r.date and len(r.date) == 10:
            daily[r.date] += r.total_amount

    top_cat = max(category_data, key=lambda c: category_data[c]["amount"]) if category_data else "N/A"

    def top_cat_for(rid):
        cats = receipt_categories.get(rid, {})
        return max(cats, key=cats.get) if cats else "Others"

    # ── Month-over-month ───────────────────────────────────────────────────
    _now = datetime.now()
    current_month_str = _now.strftime("%Y-%m")
    prev_month_str = f"{_now.year - 1}-12" if _now.month == 1 else f"{_now.year}-{str(_now.month - 1).zfill(2)}"
    current_month_total = sum(r.total_amount for r in receipts if r.date and r.date[:7] == current_month_str)
    prev_month_total    = sum(r.total_amount for r in receipts if r.date and r.date[:7] == prev_month_str)
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
            "current_month": current_month_str,
            "current_total": round(current_month_total, 2),
            "prev_month":    prev_month_str,
            "prev_total":    round(prev_month_total, 2),
            "delta_pct":     mom_delta_pct
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

    # ── By month ──────────────────────────────────────────────────────────────
    month_product: dict = defaultdict(lambda: defaultdict(float))
    receipt_month: dict = {r.id: r.date[:7] for r in receipts if r.date and len(r.date) >= 7}

    for item in items:
        if not item.product_name or _is_total_line(item.product_name):
            continue
        month = receipt_month.get(item.receipt_id)
        if month:
            month_product[month][item.product_name] += item.price

    # Also include months that have receipts but no items
    receipt_month_totals: dict = defaultdict(float)
    for r in receipts:
        if r.date and len(r.date) >= 7:
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

    uvicorn.run(app, host="127.0.0.1", port=8888)
