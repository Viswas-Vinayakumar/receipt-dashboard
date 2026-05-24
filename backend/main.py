import os
import re
import base64
import shutil
import json
import time
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
PROMPT = """Analyze this image and determine if it is a receipt (retail, grocery, restaurant, pharmacy, transport, etc.).

If it is NOT a receipt (e.g. a selfie, landscape, screenshot, document, or unrelated photo):
Return ONLY valid JSON: {"is_receipt": false}

If it IS a receipt, extract all fields accurately.

Rules:
1. merchant: The COMPLETE store name as printed in the header, including branch or city suffix (e.g. "Rewe Hauptbahnhof" or "Kaufland Berlin-Heinersdorf").
2. location: Full street address of the store.
3. date: Convert any date format to strict ISO 8601 — YYYY-MM-DD only (e.g. "18.05.2026" → "2026-05-18").
4. total_amount: The final amount paid (Summe / Gesamtbetrag / Total / Betrag) as a decimal number. Do NOT include tax breakdown lines.
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
  "items": [{"product_name": "string", "category": "string", "price": number}]
}"""


# ── Helpers ────────────────────────────────────────────────────────────────
def _extract_json(text: str) -> dict:
    """Strip markdown fences and parse JSON from model response."""
    text = re.sub(r'```(?:json)?\s*', '', text).strip().rstrip('`').strip()
    start = text.find('{')
    end   = text.rfind('}') + 1
    if start >= 0 and end > start:
        return json.loads(text[start:end])
    raise ValueError(f"No JSON object found in response: {text[:300]}")


def call_ollama(image_data: bytes) -> dict:
    """Send image to local Ollama gemma4:e4b and return parsed JSON dict."""
    image_b64 = base64.b64encode(image_data).decode()
    payload = {
        "model":  OLLAMA_MODEL,
        "prompt": PROMPT,
        "images": [image_b64],
        "stream": False,
        "format": "json",
        "options": {"temperature": 0.1, "num_predict": 1024},
    }
    try:
        with httpx.Client(timeout=180.0) as client:
            resp = client.post(f"{OLLAMA_URL}/api/generate", json=payload)
    except httpx.ConnectError:
        raise HTTPException(status_code=503,
            detail="Ollama is not running. Start it with: ollama serve")
    except httpx.TimeoutException:
        raise HTTPException(status_code=504,
            detail="Ollama timed out — image may be too large")

    if resp.status_code != 200:
        raise HTTPException(status_code=500,
            detail=f"Ollama error {resp.status_code}: {resp.text[:300]}")

    response_text = resp.json().get("response", "")
    logger.info(f"Ollama raw: {response_text[:400]}")
    return _extract_json(response_text)


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

        logger.info(f"Calling Ollama ({OLLAMA_MODEL})...")
        raw = call_ollama(image_data)
        logger.info(f"Parsed: {raw}")

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
        logger.info(f"Saved: {extraction.merchant} €{extraction.total_amount}")
        return {"status": "success", "data": extraction}

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

    for r in receipts:
        if r.date and len(r.date) >= 7:
            monthly[r.date[:7]] += r.total_amount

    top_cat = max(category_data, key=lambda c: category_data[c]["amount"]) if category_data else "N/A"

    def top_cat_for(rid):
        cats = receipt_categories.get(rid, {})
        return max(cats, key=cats.get) if cats else "Others"

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
        "recent_receipts": [
            {"id": r.id, "merchant": r.merchant, "date": r.date,
             "total_amount": r.total_amount, "category": top_cat_for(r.id)}
            for r in receipts]
    }


@app.get("/api/receipts")
async def get_receipts(db: Session = Depends(get_db)):
    receipts = db.query(models.Receipt).order_by(models.Receipt.upload_date.desc()).all()
    return [
        {"id": r.id, "merchant": r.merchant, "location": r.location,
         "date": r.date, "total_amount": r.total_amount,
         "items": [{"product_name": i.product_name, "category": i.category, "price": i.price}
                   for i in db.query(models.Item).filter(models.Item.receipt_id == r.id).all()]}
        for r in receipts]


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
