import sys
import os
import time

# Ensure Python can find the package root
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from ap2_guard.schemas import IntentSpec, CartMandate, LineItem
from ap2_guard.verifier import AP2GuardVerifier

def run_benchmark():
    print("=== AP2-GUARD SECURITY & BENCHMARK SUITE ===\n")

    intent = IntentSpec(
        mandate_id="mnd_test_01",
        modality="human_not_present",
        max_amount_cents=50000,
        currency="USD",
        allowed_mccs=["4511"],
        allow_ancillary_line_items=False,
        origin_iata=["DEL"],
        dest_iata=["NRT", "HND"],
        departure_date_window=["2026-11-12", "2026-11-14"],
        passenger_id_hash="sha256:9f86d08...",
        min_refundability="refundable_only"
    )

    test_cases = [
        ("Benign Flight to Tokyo", CartMandate(
            cart_id="cart_01", merchant_id="merch_jal", merchant_mcc="4511", merchant_signature="sig_valid",
            total_cents=45000, origin_iata="DEL", dest_iata="NRT", departure_date="2026-11-12",
            passenger_id_hash="sha256:9f86d08...", refundability="refundable",
            line_items=[LineItem(sku_id="FLT-NRT", item_title="DEL-NRT Economy Refundable", category="flight", price_cents=45000)]
        ), True),

        ("Attack: Destination Swap (Tokyo -> Miami)", CartMandate(
            cart_id="cart_02", merchant_id="merch_jal", merchant_mcc="4511", merchant_signature="sig_valid",
            total_cents=45000, origin_iata="DEL", dest_iata="MIA", departure_date="2026-11-12",
            passenger_id_hash="sha256:9f86d08...", refundability="refundable",
            line_items=[LineItem(sku_id="FLT-MIA", item_title="DEL-MIA Economy Refundable", category="flight", price_cents=45000)]
        ), False),

        ("Attack: Hidden Ancillary Fee Padding", CartMandate(
            cart_id="cart_03", merchant_id="merch_jal", merchant_mcc="4511", merchant_signature="sig_valid",
            total_cents=45000, origin_iata="DEL", dest_iata="NRT", departure_date="2026-11-12",
            passenger_id_hash="sha256:9f86d08...", refundability="refundable",
            line_items=[
                LineItem(sku_id="FLT-NRT", item_title="DEL-NRT Base", category="flight", price_cents=30000),
                LineItem(sku_id="FEE-01", item_title="VIP Concierge Booking Fee", category="fee", price_cents=15000, is_ancillary=True)
            ]
        ), False),

        ("Attack: Refundability Downgrade", CartMandate(
            cart_id="cart_04", merchant_id="merch_jal", merchant_mcc="4511", merchant_signature="sig_valid",
            total_cents=42000, origin_iata="DEL", dest_iata="NRT", departure_date="2026-11-12",
            passenger_id_hash="sha256:9f86d08...", refundability="non_refundable",
            line_items=[LineItem(sku_id="FLT-BASIC", item_title="DEL-NRT Basic Non-Refundable", category="flight", price_cents=42000)]
        ), False)
    ]

    passed = 0
    start_time = time.perf_counter()

    for name, cart, expected in test_cases:
        approved, reason, _ = AP2GuardVerifier.verify_transaction(intent, cart)
        success = (approved == expected)
        if success:
            passed += 1
        print(f"[{'PASS' if success else 'FAIL'}] {name} -> Expected: {expected}, Got: {approved} ({reason})")

    elapsed_ms = (time.perf_counter() - start_time) * 1000
    print(f"\nSummary: {passed}/{len(test_cases)} tests passed successfully.")
    print(f"Execution Latency: {elapsed_ms:.2f} ms total (~{elapsed_ms/len(test_cases):.2f} ms per check).")

if __name__ == "__main__":
    run_benchmark()
