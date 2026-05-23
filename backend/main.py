import os
import re
import shutil
import json
import time
import base64
from collections import defaultdict
from datetime import datetime
from typing import List, Optional
import logging

import requests as http_requests
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
    handlers=[
        logging.FileHandler(log_file),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)
logger.info("Initializing Backend...")

# ── API key ────────────────────────────────────────────────────────────────
CONFIG_FILE = os.path.join(DATA_DIR, "config.json")

GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL   = "llama-3.2-11b-vision-preview"

def load_api_key() -> str:
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE) as f:
                cfg = json.load(f)
            key = cfg.get("groq_api_key", "").strip()
            if key:
                logger.info("Loaded Groq API key from config.json")
                return key
        except Exception as e:
            logger.warning(f"Could not read config.json: {e}")
    key = os.environ.get("GROQ_API_KEY", "").strip()
    if key:
        logger.info("Loaded Groq API key from environment variable")
        return key
    logger.error(
        "No Groq API key found. "
        'Create ~/receipt-dashboard/app_data/config.json with {"groq_api_key": "YOUR_KEY"}'
    )
    return ""

GROQ_API_KEY = load_api_key()

# ── Database init ──────────────────────────────────────────────────────────
try:
    models.Base.metadata.create_all(bind=engine)
    logger.info("Database initialized successfully")
except Exception as e:
    logger.error(f"Database initialization failed: {e}")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
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
    date: str          # YYYY-MM-DD
    total_amount: float
    items: List[ReceiptItem] = []

class EditReceiptIn(BaseModel):
    merchant: str
    location: str = ""
    date: str
    total_amount: float
    items: List[ReceiptItem] = []

# ── Groq vision helper ─────────────────────────────────────────────────────
PROMPT = """Analyze this image and determine if it is a receipt (retail, grocery, restaurant, pharmacy, transport, etc.).

If it is NOT a receipt (e.g. a selfie, landscape, screenshot, document, or unrelated photo):
Return ONLY valid JSON: {"is_receipt": false}

If it IS a receipt, extract all fields accurately.

Rules:
1. merchant: The COMPLETE store name as printed in the header, including branch or city suffix (e.g. "Kaufland Berlin-Heinersdorf", NOT just "Kaufland").
2. location: Full street address of the store.
3. date: Convert any date format to strict ISO 8601 — YYYY-MM-DD only (e.g. "18.05.2026" → "2026-05-18").
4. total_amount: The final amount paid (Summe / Gesamtbetrag / Total) as a decimal number. Do NOT include tax breakdown lines.
5. items: Only individual product line items with their listed price. Exclude payment info, TSE data, tax rows, and subtotals.

The receipt may be in German or English. Translate product names to English.
Each item's category must be exactly one of: Groceries, Bakery, Beverages, Electronics, Dining, Transport, Health, Deposit, Others.

Return ONLY a valid JSON object — no markdown, no explanation, no code fences:
{
  "is_receipt": true,
  "merchant": "string",
  "location": "string",
  "date": "YYYY-MM-DD",
  "total_amount": number,
  "items": [
    {"product_name": "string", "category": "string", "price": number}
  ]
}"""


def _extract_json(text: str) -> str:
    """Strip markdown code fences if the model added them anyway."""
    text = text.strip()
    # Remove ```json ... ``` or ``` ... ```
    m = re.search(r'```(?:json)?\s*([\s\S]*?)```', text)
    if m:
        return m.group(1).strip()
    return text


def call_groq_vision(image_data: bytes, mime_type: str) -> dict:
    """
    Call Groq's vision endpoint with the image encoded as base64.
    Returns parsed JSON dict from the model.
    Raises HTTPException on API errors.
    """
    b64 = base64.b64encode(image_data).decode("utf-8")
    data_url = f"data:{mime_type};base64,{b64}"

    payload = {
        "model": GROQ_MODEL,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": data_url}
                    },
                    {
                        "type": "text",
                        "text": PROMPT
                    }
                ]
            }
        ],
        "max_tokens": 2048,
        "temperature": 0
    }

    headers = {
        "Authorization": f"Bearer {GROQ_API_KEY}",
        "Content-Type": "application/json"
    }

    last_err = None
    for attempt in range(3):
        try:
            resp = http_requests.post(
                GROQ_API_URL, json=payload, headers=headers, timeout=60
            )

            if resp.status_code == 200:
                content = resp.json()["choices"][0]["message"]["content"]
                raw_text = _extract_json(content)
                return json.loads(raw_text)

            if resp.status_code == 429:
                # Parse Retry-After header or body
                retry_after = resp.headers.get("retry-after", "")
                try:
                    wait = float(retry_after) + 2 if retry_after else 65.0
                except ValueError:
                    wait = 65.0
                logger.warning(f"Groq rate limit — waiting {wait:.0f}s (attempt {attempt+1}/3)...")
                if wait > 300:
                    raise HTTPException(
                        status_code=429,
                        detail="Daily quota reached. The free tier allows 14,400 req/day. Try again later or enter receipt manually."
                    )
                if attempt < 2:
                    time.sleep(wait)
                    last_err = f"429: {resp.text}"
                    continue
                raise HTTPException(
                    status_code=429,
                    detail=f"Groq is busy — try again in {int(wait)}s, or enter receipt manually."
                )

            if resp.status_code in (400, 401, 403):
                logger.error(f"Groq auth/key error {resp.status_code}: {resp.text}")
                raise HTTPException(
                    status_code=401,
                    detail="Groq API key is invalid or revoked. Update app_data/config.json with a valid key."
                )

            # Any other non-200
            logger.error(f"Groq error {resp.status_code}: {resp.text}")
            raise HTTPException(
                status_code=500,
                detail=f"AI processing failed (HTTP {resp.status_code}): {resp.text[:200]}"
            )

        except HTTPException:
            raise
        except Exception as exc:
            last_err = exc
            logger.warning(f"Groq request failed (attempt {attempt+1}/3): {exc}")
            if attempt < 2:
                time.sleep(5)
                continue
            break

    raise HTTPException(
        status_code=500,
        detail=f"AI processing failed after 3 attempts: {last_err}"
    )


# ── Routes ─────────────────────────────────────────────────────────────────
@app.get("/api/health")
async def health_check():
    logger.info("Health check ping received")
    return {"status": "ok"}

@app.post("/api/upload")
async def upload_receipt(file: UploadFile = File(...), db: Session = Depends(get_db)):
    logger.info(f"Received upload request: {file.filename}")

    if not GROQ_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="No Groq API key configured. Add your key to app_data/config.json."
        )

    file_path = os.path.join(UPLOAD_DIR, f"{datetime.now().timestamp()}_{file.filename}")
    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    mime_type = file.content_type or "image/jpeg"
    logger.info(f"Processing with mime type: {mime_type}")

    try:
        with open(file_path, "rb") as f:
            image_data = f.read()

        logger.info("Sending request to Groq AI (llama-3.2-11b-vision)...")
        raw = call_groq_vision(image_data, mime_type)

        # Not a receipt
        if not raw.get("is_receipt", True):
            try:
                os.remove(file_path)
            except Exception:
                pass
            raise HTTPException(status_code=400, detail="not_a_receipt")

        extraction = ReceiptExtraction(**raw)

        db_receipt = models.Receipt(
            image_path=file_path,
            merchant=extraction.merchant,
            location=extraction.location,
            date=extraction.date,
            total_amount=extraction.total_amount
        )
        db.add(db_receipt)
        db.commit()
        db.refresh(db_receipt)

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
        logger.error(f"Error processing receipt: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/receipts/manual")
async def add_manual_receipt(data: ManualReceiptIn, db: Session = Depends(get_db)):
    """Add a receipt manually without an image."""
    db_receipt = models.Receipt(
        image_path="",
        merchant=data.merchant,
        location=data.location,
        date=data.date,
        total_amount=data.total_amount
    )
    db.add(db_receipt)
    db.commit()
    db.refresh(db_receipt)
    for item in data.items:
        db.add(models.Item(
            receipt_id=db_receipt.id,
            product_name=item.product_name,
            category=item.category,
            price=item.price
        ))
    db.commit()
    logger.info(f"Manual receipt added: {data.merchant}")
    return {"status": "success", "id": db_receipt.id}


@app.put("/api/receipts/{receipt_id}")
async def edit_receipt(receipt_id: int, data: EditReceiptIn, db: Session = Depends(get_db)):
    """Edit an existing receipt's details and items."""
    receipt = db.query(models.Receipt).filter(models.Receipt.id == receipt_id).first()
    if not receipt:
        raise HTTPException(status_code=404, detail="Receipt not found")
    receipt.merchant     = data.merchant
    receipt.location     = data.location
    receipt.date         = data.date
    receipt.total_amount = data.total_amount
    db.query(models.Item).filter(models.Item.receipt_id == receipt_id).delete()
    for item in data.items:
        db.add(models.Item(
            receipt_id=receipt_id,
            product_name=item.product_name,
            category=item.category,
            price=item.price
        ))
    db.commit()
    logger.info(f"Receipt {receipt_id} updated: {data.merchant}")
    return {"status": "success"}


@app.get("/api/dashboard")
async def get_dashboard_data(db: Session = Depends(get_db)):
    logger.info("Fetching dashboard data")
    receipts = db.query(models.Receipt).order_by(models.Receipt.upload_date.desc()).all()
    items    = db.query(models.Item).all()

    total_spent   = sum(r.total_amount for r in receipts)
    receipt_count = len(receipts)

    category_data: dict      = {}
    receipt_categories: dict = {}
    monthly: dict            = defaultdict(float)

    for item in items:
        if item.category not in category_data:
            category_data[item.category] = {"amount": 0.0, "count": 0}
        category_data[item.category]["amount"] += item.price
        category_data[item.category]["count"]  += 1
        if item.receipt_id not in receipt_categories:
            receipt_categories[item.receipt_id] = {}
        rc = receipt_categories[item.receipt_id]
        rc[item.category] = rc.get(item.category, 0.0) + item.price

    for r in receipts:
        if r.date and len(r.date) >= 7:
            monthly[r.date[:7]] += r.total_amount

    top_category = (
        max(category_data, key=lambda c: category_data[c]["amount"])
        if category_data else "N/A"
    )

    chart_data = sorted(
        [{"name": cat, "value": round(d["amount"], 2), "count": d["count"]}
         for cat, d in category_data.items()],
        key=lambda x: x["value"], reverse=True
    )

    monthly_trend = sorted(
        [{"month": k, "total": round(v, 2)} for k, v in monthly.items()],
        key=lambda x: x["month"]
    )

    def receipt_top_cat(rid: int) -> str:
        cats = receipt_categories.get(rid, {})
        return max(cats, key=cats.get) if cats else "Others"

    return {
        "total_spent":    round(total_spent, 2),
        "receipt_count":  receipt_count,
        "top_category":   top_category,
        "category_spend": chart_data,
        "monthly_trend":  monthly_trend,
        "recent_receipts": [
            {
                "id":           r.id,
                "merchant":     r.merchant,
                "date":         r.date,
                "total_amount": r.total_amount,
                "category":     receipt_top_cat(r.id),
            } for r in receipts
        ]
    }


@app.get("/api/receipts")
async def get_receipts(db: Session = Depends(get_db)):
    receipts = db.query(models.Receipt).order_by(models.Receipt.upload_date.desc()).all()
    result = []
    for r in receipts:
        items = db.query(models.Item).filter(models.Item.receipt_id == r.id).all()
        result.append({
            "id":           r.id,
            "merchant":     r.merchant,
            "location":     r.location,
            "date":         r.date,
            "total_amount": r.total_amount,
            "items": [
                {"product_name": i.product_name, "category": i.category, "price": i.price}
                for i in items
            ]
        })
    return result


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
    db.delete(receipt)
    db.commit()
    return {"status": "success"}


@app.post("/api/reset")
async def reset_data(db: Session = Depends(get_db)):
    for filename in os.listdir(UPLOAD_DIR):
        fp = os.path.join(UPLOAD_DIR, filename)
        try:
            if os.path.isfile(fp):
                os.unlink(fp)
        except Exception as e:
            logger.warning(f"Error deleting file {fp}: {e}")
    db.query(models.Item).delete()
    db.query(models.Receipt).delete()
    db.commit()
    return {"status": "success"}


if __name__ == "__main__":
    import uvicorn
    import subprocess

    try:
        current_pid = str(os.getpid())
        pids = subprocess.check_output("lsof -ti :8888", shell=True).decode().split()
        killed = False
        for p in pids:
            if p != current_pid:
                subprocess.run(f"kill -9 {p}", shell=True)
                killed = True
        if killed:
            time.sleep(0.5)
    except Exception:
        pass

    uvicorn.run(app, host="127.0.0.1", port=8888)
