# UPL 语义对齐 SSOT

- Source of Truth: `docs/ssot/upl-alignment/`
- Remote reference: https://github.com/mengyp2022-droid/upl.git (local mirror: `.ref_upl/`)
- Current product: `openai-plus-vxt` browser extension
- Goal: align *semantic logic* with UPL, not clone the Python console UI

## Scope Decision

| Layer | Status |
|---|---|
| P0 three-stage checkout/update/require-zero | DONE |
| P0 stage proxy routing | DONE |
| P1 payment-method final URL extract | DONE |
| P1 method-specific proxy pools | DONE |
| P2 payment_method_types detector | DONE |
| P2 seed fail cooldown/remove scoring | DONE |

## Task DAG

### P0/P1 done
### P2 (this batch)
- T-P2-01 payment_method_types detector (Stripe init after checkout)
- T-P2-02 seed fail cooldown / remove-after-fails scoring for method pools
- T-P2-03 Probe/UI wiring
- T-P2-04 Verify + package

## Acceptance (P2)
1. After checkout (optional), detector reads payment_method_types via Stripe payment_pages init.
2. Ignores card/paypal/link; stores methods on hit + dashboard tags.
3. Method-pool seeds track success/fail; cooldown skips; remove-after-N drops from active pool.
4. UI can enable detect + seed health params.
5. VERIFY.md P2 all PASS + xpi packaged.

## UX enhancements (0.0.15)
- Method detection dashboard (country-supported payment methods only)
- Seed health CSV/JSON export
- Auto recommend payment method from detected supported methods
