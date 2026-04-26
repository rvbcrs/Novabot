# Open robot_decision — Drop-in Status

**Status as of 2026-04-26:** Drop-in pariteit bereikt op branch `feat/open-decision-finish`. **NIET geactiveerd op productie.**

## What

`mower/{robot_decision,decision_assistant,service_handlers,state_machine}.py` is een Python herimplementatie van de closed C++ `robot_decision` binary die op de Novabot maaier draait. Doel: 100% drop-in vervanger zodat de codebase open en aanpasbaar wordt zonder C++ binary reverse-engineering per wijziging.

## Where the work happened

- **Branch:** `feat/open-decision-finish`
- **Plan:** `docs/superpowers/plans/2026-04-26-finish-open-decision.md` (43-task plan, alle 9 phases compleet)
- **Gap analysis:** `research/documents/robot-decision-gap-analysis.md` (§9 backlog markeert alle resolved items met ✅ + commit SHA; §11 bevat post-implementation parity notes; "Remaining gaps after 2026-04-26 implementation" lijst de open items)
- **Live snapshot closed binary:** `research/documents/closed-decision-graph-snapshot-2026-04-26.txt` (ROS-graph baseline van LFIN1231000211 met stock C++ binary)
- **Acceptance checklist:** `mower/tests/runtime/acceptance_checklist.md` (vereist user-OK vóór elke beweging-stap)

## Activation

⚠️ **Productie-maaier (192.168.0.100) draait nog steeds de stock C++ `robot_decision` binary.** Activatie van de Python drop-in vereist:

1. Expliciete user-toestemming.
2. Doorlopen van alle stappen in `mower/tests/runtime/acceptance_checklist.md`.
3. Eerst stoppen van de C++ binary: `pkill -f /root/novabot/install/.*/robot_decision`.
4. Starten Python implementatie met `ROS_LOCALHOST_ONLY=1`.
5. Bij failure: rollback via `bash deploy.sh --rollback`.

## Remaining gaps

Zie `research/documents/robot-decision-gap-analysis.md` §"Remaining gaps after 2026-04-26 implementation". De grote categorieën:

- Boundary-offset wiring naar `BoundaryFollow.Goal` — wacht op message-type extensie.
- `lora_ok` host-attribuut + LoRa-state tracking voor `_lora_recover_loop` (architectuur staat klaar, host moet `self.lora_ok = bool` exposen).
- Diverse closed-binary clients/parameters geannoteerd met `# TODO(open_decision):` voor latere wiring (camera save, LED brightness control, image collection caps).
- Heading-discovery richting (open: forward 1.5 m + spin; closed: reverse ~1 m via `free_move_around`) — vereist hardware-test toestemming voor wijziging.
- `start_assistant_mapping` async goal-handle refactor (synchronous response-then-thread is functioneel maar caller weet niet of het lukte).

## Tests

50+ pytest tests in `mower/tests/` valideren source-structuur (publishers, subscribers, action clients, callbacks, service handlers). Pure structurele tests zonder rclpy runtime — werken op Mac dev machine. Volledige ROS-runtime validatie gebeurt via de acceptance checklist op echte hardware.

```bash
cd mower && python -m pytest tests/ -v
```
