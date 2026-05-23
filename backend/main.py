import os
import shutil
import json
from datetime import datetime
from typing import List, Optional

from fastapi import FastAPI, UploadFile, File, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from dotenv import load_dotenv
import google.generativeai as genai
from pydantic import BaseModel

import models
from database import engine, get_db

load_dotenv()

# Initialize Database
models.Base.metadata.create_all(bind=engine)

# Initialize Gemini
genai.configure(api_key=os.getenv("GEMINI_API_KEY"))
model = genai.GenerativeModel("gemini-1.5-pro")

app = FastAPI()

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = os.path.expanduser("~/receipt-dashboard/uploads")
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

@app.post("/api/upload")
async def upload_receipt(file: UploadFile = File(...), db: Session = Depends(get_db)):
    # Save file
    file_path = os.path.join(UPLOAD_DIR, f"{datetime.now().timestamp()}_{file.filename}")
    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    # Process with Gemini
    try:
        # Load image
        with open(file_path, "rb") as f:
            image_data = f.read()

        prompt = """
        Analyze this receipt image accurately. 
        Extract the following details:
        - Merchant name
        - Location/Address
        - Date of purchase
        - Total amount
        - List of items (product name, category, price)
        
        The receipt may be in German or English. Translate categories and product names to English if they are in German.
        Categories should be general (e.g., Groceries, Electronics, Dining, Transport, Health, Others).
        
        Return the result as a strict JSON object following this schema:
        {
          "merchant": "string",
          "location": "string",
          "date": "string",
          "total_amount": number,
          "items": [
            {"product_name": "string", "category": "string", "price": number}
          ]
        }
        """

        response = model.generate_content(
            [prompt, {"mime_type": "image/jpeg", "data": image_data}],
            generation_config={"response_mime_type": "application/json"}
        )
        
        extracted_data = json.loads(response.text)
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

        return {"status": "success", "data": extraction}

    except Exception as e:
        print(f"Error processing receipt: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/dashboard")
async def get_dashboard_data(db: Session = Depends(get_db)):
    receipts = db.query(models.Receipt).all()
    items = db.query(models.Item).all()

    total_spent = sum(r.total_amount for r in receipts)
    
    category_spend = {}
    for item in items:
        category_spend[item.category] = category_spend.get(item.category, 0) + item.price

    # Top spending category
    top_category = max(category_spend, key=category_spend.get) if category_spend else "N/A"

    recent_receipts = db.query(models.Receipt).order_by(models.Receipt.upload_date.desc()).limit(5).all()
    
    # Format for chart
    chart_data = [{"name": cat, "value": amt} for cat, amt in category_spend.items()]

    return {
        "total_spent": round(total_spent, 2),
        "top_category": top_category,
        "category_spend": chart_data,
        "recent_receipts": [
            {
                "id": r.id,
                "merchant": r.merchant,
                "date": r.date,
                "total_amount": r.total_amount
            } for r in recent_receipts
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
    uvicorn.run(app, host="0.0.0.0", port=8000)
