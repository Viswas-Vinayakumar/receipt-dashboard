import os
import re
import shutil
import json
import time
from datetime import datetime
from typing import List, Optional
import logging

from fastapi import FastAPI, UploadFile, File, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
import google.generativeai as genai
from pydantic import BaseModel

import models
from database import engine, get_db, DATA_DIR

# Set up logging to file
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

# ── API key: read from config.json (gitignored), then env var ─────────────
CONFIG_FILE = os.path.join(DATA_DIR, "config.json")

def load_api_key() -> str:
    # 1. Try config.json in app_data (preferred — never committed to git)
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
    # 2. Fall back to environment variable
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if key:
        logger.info("Loaded Gemini API key from environment variable")
        return key
    logger.error("No Gemini API key found. Create ~/receipt-dashboard/app_data/config.json with {\"gemini_api_key\": \"YOUR_KEY\"}")
    return ""

GEMINI_API_KEY = load_api_key()

# Initialize Database
try:
    models.Base.metadata.create_all(bind=engine)
    logger.info("Database initialized successfully")
except Exception as e:
    logger.error(f"Database initialization failed: {e}")

# Initialize Gemini
genai.configure(api_key=GEMINI_API_KEY)
# gemini-2.5-flash — current stable model
model = genai.GenerativeModel("gemini-2.5-flash")

app = FastAPI()

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

class ReceiptItem(BaseModel):
    product_name: str
    category: str
    price: float

class ReceiptExtraction(BaseModel):
    merchant: str
    location: str
    date: str
    total_amount: float
    items: List[ReceiptItem]

@app.get("/api/health")
async def health_check():
    logger.info("Health check ping received")
    return {"status": "ok"}

@app.post("/api/upload")
async def upload_receipt(file: UploadFile = File(...), db: Session = Depends(get_db)):
    logger.info(f"Received upload request: {file.filename}")
    # Save file
    file_path = os.path.join(UPLOAD_DIR, f"{datetime.now().timestamp()}_{file.filename}")
    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    # Detect mime type
    mime_type = file.content_type or "image/jpeg"
    logger.info(f"Processing with mime type: {mime_type}")

    # Process with Gemini
    try:
        # Load image
        with open(file_path, "rb") as f:
            image_data = f.read()

        prompt = """
        Analyze this receipt image accurately and extract structured data.

        Rules:
        1. merchant: The COMPLETE store name as printed in the header, including branch or city suffix (e.g. "Kaufland Berlin-Heinersdorf", NOT just "Kaufland").
        2. location: Full street address of the store.
        3. date: Convert any date format to strict ISO 8601 — YYYY-MM-DD only (e.g. "18.05.2026" → "2026-05-18", "22.05.26" → "2026-05-22").
        4. total_amount: The final amount paid (Summe / Gesamtbetrag / Total) as a decimal number. Do NOT include tax breakdown lines.
        5. items: Only individual product line items with their listed price. Exclude payment info, TSE data, tax rows, and subtotals.

        The receipt may be in German or English. Translate product names to English.
        Each item's category must be exactly one of: Groceries, Bakery, Beverages, Electronics, Dining, Transport, Health, Deposit, Others.

        Return ONLY a valid JSON object — no markdown, no explanation:
        {
          "merchant": "string",
          "location": "string",
          "date": "YYYY-MM-DD",
          "total_amount": number,
          "items": [
            {"product_name": "string", "category": "string", "price": number}
          ]
        }
        """

        logger.info("Sending request to Gemini AI...")
        response = None
        last_err = None
        for attempt in range(3):  # up to 3 attempts
            try:
                response = model.generate_content(
                    [prompt, {"mime_type": mime_type, "data": image_data}],
                    generation_config={"response_mime_type": "application/json"}
                )
                last_err = None
                break  # success
            except Exception as exc:
                last_err = exc
                err_str = str(exc)
                is_rate_limit = (
                    "429" in err_str
                    or "quota" in err_str.lower()
                    or "ResourceExhausted" in type(exc).__name__
                )
                if is_rate_limit and attempt < 2:
                    # Parse the suggested retry delay from the error message
                    m = re.search(r'retry[_ ]in[_ ](\d+(?:\.\d+)?)', err_str, re.IGNORECASE)
                    wait = float(m.group(1)) + 2 if m else 65.0
                    # Don't retry if it's a daily quota (wait > 5 min means daily limit hit)
                    if wait > 300:
                        logger.warning(f"Gemini daily quota exceeded — not retrying. Wait: {wait:.0f}s")
                        break
                    logger.info(f"Rate limit hit (attempt {attempt+1}/3) — waiting {wait:.0f}s before retry...")
                    time.sleep(wait)
                    continue
                break  # non-rate-limit error or final attempt

        if last_err is not None:
            err_str = str(last_err)
            is_rate_limit = (
                "429" in err_str
                or "quota" in err_str.lower()
                or "ResourceExhausted" in type(last_err).__name__
            )
            if is_rate_limit:
                m = re.search(r'retry[_ ]in[_ ](\d+(?:\.\d+)?)', err_str, re.IGNORECASE)
                wait_sec = int(float(m.group(1))) + 1 if m else 60
                friendly = (
                    f"Gemini rate limit reached. "
                    f"The free tier allows 20 uploads/day. "
                    f"Try again in {wait_sec}s."
                    if wait_sec > 300
                    else f"Gemini is busy — try again in {wait_sec}s."
                )
                raise HTTPException(status_code=429, detail=friendly)
            raise HTTPException(status_code=500, detail=err_str)

        extracted_data = json.loads(response.text)
        logger.info(f"Gemini AI extracted data: {extracted_data['merchant']}")
        extraction = ReceiptExtraction(**extracted_data)

        # Save to Database
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
            db_item = models.Item(
                receipt_id=db_receipt.id,
                product_name=item.product_name,
                category=item.category,
                price=item.price
            )
            db.add(db_item)
        
        db.commit()
        logger.info("Data saved to database successfully")

        return {"status": "success", "data": extraction}

    except HTTPException:
        raise  # pass through our own HTTP errors unchanged
    except Exception as e:
        logger.error(f"Error processing receipt: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/dashboard")
async def get_dashboard_data(db: Session = Depends(get_db)):
    logger.info("Fetching dashboard data")
    receipts = db.query(models.Receipt).order_by(models.Receipt.upload_date.desc()).all()
    items = db.query(models.Item).all()

    total_spent = sum(r.total_amount for r in receipts)
    receipt_count = len(receipts)

    # Build category spend + item count, and top category per receipt
    category_data: dict = {}
    receipt_categories: dict = {}
    for item in items:
        # Global category totals
        if item.category not in category_data:
            category_data[item.category] = {"amount": 0.0, "count": 0}
        category_data[item.category]["amount"] += item.price
        category_data[item.category]["count"] += 1
        # Per-receipt top category
        if item.receipt_id not in receipt_categories:
            receipt_categories[item.receipt_id] = {}
        rc = receipt_categories[item.receipt_id]
        rc[item.category] = rc.get(item.category, 0.0) + item.price

    top_category = max(category_data, key=lambda c: category_data[c]["amount"]) if category_data else "N/A"

    chart_data = sorted(
        [{"name": cat, "value": round(d["amount"], 2), "count": d["count"]}
         for cat, d in category_data.items()],
        key=lambda x: x["value"], reverse=True
    )

    def receipt_top_cat(rid: int) -> str:
        cats = receipt_categories.get(rid, {})
        return max(cats, key=cats.get) if cats else "Others"

    return {
        "total_spent": round(total_spent, 2),
        "receipt_count": receipt_count,
        "top_category": top_category,
        "category_spend": chart_data,
        "recent_receipts": [
            {
                "id": r.id,
                "merchant": r.merchant,
                "date": r.date,
                "total_amount": r.total_amount,
                "category": receipt_top_cat(r.id),
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
            "id": r.id,
            "merchant": r.merchant,
            "location": r.location,
            "date": r.date,
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
    
    # Delete image file
    try:
        if os.path.exists(receipt.image_path):
            os.remove(receipt.image_path)
    except Exception as e:
        print(f"Error deleting image: {e}")

    # Delete items and receipt
    db.query(models.Item).filter(models.Item.receipt_id == receipt_id).delete()
    db.delete(receipt)
    db.commit()
    return {"status": "success"}

@app.post("/api/reset")
async def reset_data(db: Session = Depends(get_db)):
    # Clear uploads directory
    for filename in os.listdir(UPLOAD_DIR):
        file_path = os.path.join(UPLOAD_DIR, filename)
        try:
            if os.path.isfile(file_path):
                os.unlink(file_path)
        except Exception as e:
            print(f"Error deleting file {file_path}: {e}")

    # Clear database
    db.query(models.Item).delete()
    db.query(models.Receipt).delete()
    db.commit()
    return {"status": "success"}

if __name__ == "__main__":
    import uvicorn
    import subprocess
    import time

    # Try to clear port 8888 safely
    try:
        current_pid = str(os.getpid())
        pids = subprocess.check_output("lsof -ti :8888", shell=True).decode().split()
        killed = False
        for p in pids:
            if p != current_pid:
                subprocess.run(f"kill -9 {p}", shell=True)
                killed = True
        if killed:
            time.sleep(0.5)  # Allow kernel to fully release the port before binding
    except:
        pass

    uvicorn.run(app, host="127.0.0.1", port=8888)
