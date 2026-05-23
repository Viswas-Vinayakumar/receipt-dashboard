from sqlalchemy import Column, Integer, String, Float, ForeignKey, DateTime
from sqlalchemy.orm import relationship
from database import Base
import datetime

class Receipt(Base):
    __tablename__ = "receipts"

    id = Column(Integer, primary_key=True, index=True)
    upload_date = Column(DateTime, default=datetime.datetime.utcnow)
    image_path = Column(String)
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
