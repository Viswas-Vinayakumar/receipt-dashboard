from sqlalchemy import Column, Integer, String, Float, ForeignKey, DateTime
from sqlalchemy.orm import relationship
from database import Base
import datetime

class Receipt(Base):
    __tablename__ = "receipts"

    id = Column(Integer, primary_key=True, index=True)
    upload_date = Column(DateTime, default=datetime.datetime.utcnow)
    image_path = Column(String)
    image_hash = Column(String, nullable=True)  # SHA-256 of original image bytes
    merchant = Column(String)
    location = Column(String)
    date = Column(String) # Date on receipt
    total_amount = Column(Float)

    items = relationship("Item", back_populates="receipt")

class Item(Base):
    __tablename__ = "items"

    id = Column(Integer, primary_key=True, index=True)
    receipt_id = Column(Integer, ForeignKey("receipts.id"))
    product_name = Column(String)
    category = Column(String)
    price = Column(Float)

    receipt = relationship("Receipt", back_populates="items")

class CategoryCorrection(Base):
    """Stores learned category corrections from user edits — the self-improvement loop."""
    __tablename__ = "category_corrections"

    id                 = Column(Integer, primary_key=True, index=True)
    product_name_lower = Column(String, unique=True, index=True)  # normalised lookup key
    correct_category   = Column(String)
    correction_count   = Column(Integer, default=1)              # how many times confirmed
    last_updated       = Column(DateTime, default=datetime.datetime.utcnow)
