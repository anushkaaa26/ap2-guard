from pydantic import BaseModel, Field
from typing import List, Optional

class IntentSpec(BaseModel):
    mandate_id: str
    modality: str = Field(..., description="human_present or human_not_present")
    max_amount_cents: int = Field(..., gt=0)
    currency: str = "USD"
    allowed_mccs: List[str]
    allow_ancillary_line_items: bool = False
    
    origin_iata: List[str]
    dest_iata: List[str]
    departure_date_window: List[str]
    passenger_id_hash: str
    min_refundability: str = Field(..., description="refundable_only or any")

class LineItem(BaseModel):
    sku_id: str
    item_title: str
    category: str
    price_cents: int
    is_ancillary: bool = False

class CartMandate(BaseModel):
    cart_id: str
    merchant_id: str
    merchant_mcc: str
    merchant_signature: str
    total_cents: int
    currency: str = "USD"
    
    origin_iata: str
    dest_iata: str
    departure_date: str
    passenger_id_hash: str
    refundability: str
    line_items: List[LineItem]
