import os
import re
import shutil
import json
import time
from collections import defaultdict
from datetime import datetime
from typing import List
import logging

from fastapi import FastAPI, UploadFile, File, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
import google.generativeai as genai
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
logger.info("Initializing Backend...")

# ── API key ────────────────────────────────────────────────────────────────
CONFIG_FILE = os.path.join(DATA_DIR, "config.json")

def load_api_key() -> str:
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE) as f:
                cfg = json.load(f)
            key = cfg.get("gemini_api_key", "").strip()
            if key:
                logger.info("Loaded Gemini API key from config.json")
                return key
        except Exception as e:
            logger.warning(f"Could not read config.json: {e}")
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if key:
        logger.info("Loaded Gemini API key from environment variable")
        return key
    logger.error("No Gemini API key found.")
    return ""

GEMINI_API_KEY = load_api_key()
genai.configure(api_key=GEMINI_API_KEY)
gemini_model = genai.GenerativeModel("gemini-2.0-flash")

# ── Database ───────────────────────────────────────────────────────────────
try:
    models.Base.metadata.create_all(bind=engine)
    logger.info("Database initialized successfully")
except Exception as e:
    logger.error(f"Database initialization failed: {e}")

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

# ── Helpers ────────────────────────────────────────────────────────────────
PROMPT = """Analyze this image and determine if it is a receipt (retail, grocery, restaurant, pharmacy, transport, etc.).

If it is NOT a receipt (e.g. a selfie, landscape, screenshot, document, or unrelated photo):
Return ONLY valid JSON: {"is_receipt": false}

If it IS a receipt, extract all fields accurately.

Rules:
1. merchant: The COMPLETE store name as printed in the header (e.g. "Kaufland Berlin-Heinersdorf", NOT just "Kaufland").
2. location: Full street address of the store.
3. date: Convert any date format to strict ISO 8601 — YYYY-MM-DD only (e.g. "18.05.2026" → "2026-05-18").
4. total_amount: The final amount paid as a decimal number. Do NOT include tax breakdown lines.
5. items: Only individual product line items with their listed price. Exclude payment info, tax rows, and subtotals.

The receipt may be in German or English. Translate product names to English.
Each item's category must be exactly one of: Groceries, Bakery, Beverages, Electronics, Dining, Transport, Health, Deposit, Others.

Return ONLY a valid JSON object — no markdown, no explanation, no code fences:
{
  "is_receipt": true,
  "merchant": "string",
  "location": "string",
  "date": "YYYY-MM-DD",
  "total_amount": number,
  "items": [{"product_name": "string", "category": "string", "price": number}]
}"""


def _parse_retry_after(err_str: str) -> int:
    """Extract retry-after seconds from a Gemini rate-limit error string."""
    m = re.search(r'retry[_ ]in[_ ](\d+(?:\.\d+)?)', err_str, re.IGNORECASE)
    return int(float(m.group(1))) + 2 if m else 62


def _is_rate_limit(exc: Exception) -> bool:
    s = str(exc)
    return "429" in s or "quota" in s.lower() or "ResourceExhausted" in type(exc).__name__


def _is_invalid_key(exc: Exception) -> bool:
    s = str(exc)
    return any(c in s for c in ("400", "401", "403", "API_KEY_INVALID"))


# ── Routes ─────────────────────────────────────────────────────────────────
@app.get("/api/health")
async def health_check():
    return {"status": "ok"}


@app.post("/api/upload")
async def upload_receipt(file: UploadFile = File(...), db: Session = Depends(get_db)):
    logger.info(f"Upload request: {file.filename}")

    if not GEMINI_API_KEY:
        raise HTTPException(status_code=503,
            detail="No Gemini API key configured. Add your key to app_data/config.json.")

    file_path = os.path.join(UPLOAD_DIR, f"{datetime.now().timestamp()}_{file.filename}")
    with open(file_path, "wb") as buf:
        shutil.copyfileobj(file.file, buf)

    mime_type = file.content_type or "image/jpeg"

    try:
        with open(file_path, "rb") as f:
            image_data = f.read()

        logger.info("Calling Gemini AI...")
        try:
            response = gemini_model.generate_content(
                [PROMPT, {"mime_type": mime_type, "data": image_data}],
                generation_config={"response_mime_type": "application/json"}
            )
        except Exception as exc:
            if _is_rate_limit(exc):
                wait = _parse_retry_after(str(exc))
                logger.warning(f"Gemini rate limit — retry in {wait}s")
                # Return immediately so the frontend can show the countdown.
                # Detail format: "rate_limit:<seconds>" — parsed by the frontend.
                raise HTTPException(status_code=429, detail=f"rate_limit:{wait}")
            if _is_invalid_key(exc):
                raise HTTPException(status_code=401,
                    detail="Gemini API key is invalid. Update app_data/config.json.")
            logger.error(f"Gemini error: {exc}")
            raise HTTPException(status_code=500, detail=f"AI processing failed: {exc}")

        raw = json.loads(response.text)

        if not raw.get("is_receipt", True):
            try: os.remove(file_path)
            except Exception: pass
            raise HTTPException(status_code=400, detail="not_a_receipt")

        extraction = ReceiptExtraction(**raw)

        db_receipt = models.Receipt(
            image_path=file_path,
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
        logger.info(f"Saved receipt: {extraction.merchant}")
        return {"status": "success", "data": extraction}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error: {e}")
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
    logger.info(f"Manual receipt added: {data.merchant}")
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
    logger.info(f"Receipt {receipt_id} updated: {data.merchant}")
    return {"status": "success"}


@app.get("/api/dashboard")
async def get_dashboard_data(db: Session = Depends(get_db)):
    receipts = db.query(models.Receipt).order_by(models.Receipt.upload_date.desc()).all()
    items    = db.query(models.Item).all()

    total_spent  = sum(r.total_amount for r in receipts)
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

    for r in receipts:
        if r.date and len(r.date) >= 7:
            monthly[r.date[:7]] += r.total_amount

    top_category = max(category_data, key=lambda c: category_data[c]["amount"]) if category_data else "N/A"

    def receipt_top_cat(rid: int) -> str:
        cats = receipt_categories.get(rid, {})
        return max(cats, key=cats.get) if cats else "Others"

    return {
        "total_spent":    round(total_spent, 2),
        "receipt_count":  len(receipts),
        "top_category":   top_category,
        "category_spend": sorted(
            [{"name": c, "value": round(d["amount"], 2), "count": d["count"]}
             for c, d in category_data.items()],
            key=lambda x: x["value"], reverse=True
        ),
        "monthly_trend": sorted(
            [{"month": k, "total": round(v, 2)} for k, v in monthly.items()],
            key=lambda x: x["month"]
        ),
        "recent_receipts": [
            {"id": r.id, "merchant": r.merchant, "date": r.date,
             "total_amount": r.total_amount, "category": receipt_top_cat(r.id)}
            for r in receipts
        ]
    }


@app.get("/api/receipts")
async def get_receipts(db: Session = Depends(get_db)):
    receipts = db.query(models.Receipt).order_by(models.Receipt.upload_date.desc()).all()
    return [
        {"id": r.id, "merchant": r.merchant, "location": r.location,
         "date": r.date, "total_amount": r.total_amount,
         "items": [{"product_name": i.product_name, "category": i.category, "price": i.price}
                   for i in db.query(models.Item).filter(models.Item.receipt_id == r.id).all()]}
        for r in receipts
    ]


@app.delete("/api/receipts/{receipt_id}")
async def delete_receipt(receipt_id: int, db: Session = Depends(get_db)):
    receipt = db.query(models.Receipt).filter(models.Receipt.id == receipt_id).first()
    if not receipt:
        raise HTTPException(status_code=404, detail="Receipt not found")
    try:
        if receipt.image_path and os.path.exists(receipt.image_path):
            os.remove(receipt.image_path)
    except Exception as e:
        logger.warning(f"Error deleting image: {e}")
    db.query(models.Item).filter(models.Item.receipt_id == receipt_id).delete()
    db.delete(receipt); db.commit()
    return {"status": "success"}


@app.post("/api/reset")
async def reset_data(db: Session = Depends(get_db)):
    for fn in os.listdir(UPLOAD_DIR):
        fp = os.path.join(UPLOAD_DIR, fn)
        try:
            if os.path.isfile(fp): os.unlink(fp)
        except Exception as e:
            logger.warning(f"Error deleting {fp}: {e}")
    db.query(models.Item).delete()
    db.query(models.Receipt).delete()
    db.commit()
    return {"status": "success"}


if __name__ == "__main__":
    import uvicorn, subprocess

    try:
        current_pid = str(os.getpid())
        pids = subprocess.check_output("lsof -ti :8888", shell=True).decode().split()
        for p in pids:
            if p != current_pid:
                subprocess.run(f"kill -9 {p}", shell=True)
        time.sleep(0.3)
    except Exception:
        pass

    uvicorn.run(app, host="127.0.0.1", port=8888)
