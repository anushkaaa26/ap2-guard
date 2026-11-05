from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from ap2_guard.schemas import IntentSpec, CartMandate
from ap2_guard.verifier import AP2GuardVerifier

app = FastAPI(
    title="AP2-Guard Authorizer",
    description="Secure Delegated Payment Authorizer & Semantic Firewall for Agentic Commerce",
    version="1.0.0"
)

MANDATE_STORE = {}

@app.get("/")
def read_root():
    return {
        "system": "AP2-Guard Semantic Payment Firewall",
        "status": "active",
        "endpoints": {
            "docs": "/docs",
            "register_mandate": "POST /v1/mandates/register",
            "stripe_webhook": "POST /v1/stripe/issuing-webhook"
        }
    }

@app.post("/v1/mandates/register")
def register_mandate(intent: IntentSpec):
    MANDATE_STORE[intent.mandate_id] = intent
    return {"status": "registered", "mandate_id": intent.mandate_id}

@app.post("/v1/stripe/issuing-webhook")
async def stripe_issuing_webhook(request: Request):
    payload = await request.json()
    if payload.get("type") == "issuing_authorization.request":
        auth_obj = payload.get("data", {}).object
        metadata = auth_obj.get("metadata", {})
        intent = MANDATE_STORE.get(metadata.get("mandate_id"))
        
        if not intent:
            return {"approved": False, "reason": "no_bound_mandate"}
            
        cart_data = metadata.get("cart_mandate_json")
        if not cart_data:
            return {"approved": False, "reason": "missing_cart_mandate"}
            
        cart = CartMandate(**cart_data)
        approved, reason, _ = AP2GuardVerifier.verify_transaction(intent, cart)
        return {"approved": approved, "reason": reason}
            
    return {"status": "ignored"}
