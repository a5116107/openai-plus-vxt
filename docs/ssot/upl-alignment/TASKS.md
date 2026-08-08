# UPL Alignment Task Board (SSOT)

| ID | Title | Status | Owner files | Acceptance |
|---|---|---|---|---|
| T-P0-01 | Three-stage country config | done | probe types/state | normalize + defaults |
| T-P0-02 | Stage proxy resolver | done | proxy, probe/service | stage resolve |
| T-P0-03 | Staged checkout pipeline | done | checkout, probe/service | create→update→provider |
| T-P0-04 | requireZero gate | done | probe/service, checkout | non-zero rejected |
| T-P0-05 | UI/service wiring P0 | done | automation-settings | form + run path |
| T-P0-06 | Verify + package P0 | done | docs/ssot, dist | PASS |
| T-P1-01 | Payment method routers | done | payment/* | profiles |
| T-P1-02 | Final URL extractors | done | payment/final-url | patterns + confirm |
| T-P1-03 | Method/stage proxy pools | done | proxy/* | 3 pools |
| T-P1-04 | Probe/UI wiring P1 | done | probe, UI | extract + pools |
| T-P1-05 | Verify + package P1 | done | docs/ssot, dist | PASS |
| T-P2-01 | payment_method_types detector | done | payment/detect-methods | stripe init methods |
| T-P2-02 | seed fail cooldown/remove | done | proxy seed-health | cooldown + remove |
| T-P2-03 | Probe/UI wiring P2 | done | probe, automation-settings | toggles + board |
| T-P2-04 | Verify + package P2 | done | docs/ssot, dist xpi | PASS |

Status vocabulary: pending | in_progress | done | blocked | waived

| T-UX-01 | Method detection dashboard | done | probe state/service, automation-settings | country supported methods board |
| T-UX-02 | Seed health export | done | proxy/seed-health, UI | csv/json export |
| T-UX-03 | Auto recommend by detected methods | done | probe service/UI | only detected supported methods |
| T-UX-04 | Verify + package UX | done | dist xpi 0.0.15 | PASS |
