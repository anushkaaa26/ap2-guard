from typing import Tuple, Dict, Any
from ap2_guard.schemas import IntentSpec, CartMandate

class AP2GuardVerifier:
    @staticmethod
    def verify_transaction(intent: IntentSpec, cart: CartMandate) -> Tuple[bool, str, Dict[str, Any]]:
        diff_report = {}

        # TIER 1: Rail & Basic Policy Checks
        if cart.total_cents > intent.max_amount_cents:
            return False, "DECLINED_EXCEEDS_BUDGET", {"total_cents": cart.total_cents, "max": intent.max_amount_cents}
        
        if cart.merchant_mcc not in intent.allowed_mccs:
            return False, "DECLINED_INVALID_MCC", {"mcc": cart.merchant_mcc, "allowed": intent.allowed_mccs}
            
        if cart.currency != intent.currency:
            return False, "DECLINED_CURRENCY_MISMATCH", {}

        # TIER 2A: Deterministic Schema & Line-Item Diff
        computed_sum = sum(item.price_cents for item in cart.line_items)
        if computed_sum != cart.total_cents:
            return False, "DECLINED_CART_SUM_MISMATCH", {"computed": computed_sum, "stated": cart.total_cents}

        if not intent.allow_ancillary_line_items:
            ancillary_items = [item for item in cart.line_items if item.is_ancillary or len(cart.line_items) > 1]
            if ancillary_items:
                return False, "DECLINED_UNAUTHORIZED_ANCILLARY_FEES", {"items": [i.sku_id for i in ancillary_items]}

        dest_match = cart.dest_iata in intent.dest_iata
        diff_report["dest_match"] = dest_match
        if not dest_match:
            return False, "DECLINED_DESTINATION_MISMATCH", {"expected": intent.dest_iata, "actual": cart.dest_iata}

        pax_match = (cart.passenger_id_hash == intent.passenger_id_hash)
        diff_report["passenger_match"] = pax_match
        if not pax_match:
            return False, "DECLINED_PASSENGER_MISMATCH", {}

        if intent.min_refundability == "refundable_only" and cart.refundability != "refundable":
            return False, "DECLINED_REFUNDABILITY_VIOLATION", {"required": "refundable", "actual": cart.refundability}

        return True, "APPROVED_MATCHED", diff_report
