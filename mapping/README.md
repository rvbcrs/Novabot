# Open Mapping Node

[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/rvbcrs) [![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-%E2%98%95-ffdd00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/rvbcrs) [![PayPal](https://img.shields.io/badge/PayPal-donate-00457C?logo=paypal&logoColor=white)](https://paypal.me/rvbcrs)

Open-source drop-in replacement for the stock `novabot_mapping` ROS2 node.
Python (rclpy), byte-identical fidelity. See the spec:
`docs/superpowers/specs/2026-06-22-open-mapping-node-design.md`.

## Layout
- `open_mapping/` — rclpy node (`node.py`, thin) + pure ROS-free `core/`.
- `harness/` — golden-fixture capture (`capture.py`) + byte-diff oracle (`diff_runner.py`) + `fixtures/`.
- `tests/` — pytest. Run: `cd mapping && python -m pytest -v`.

## Status: Phase 0 (scaffold + diff-oracle)
`core/` is stubbed; the node acknowledges services without doing work. The
harness proves the byte-diff oracle end-to-end on `fixtures/save_map_complex_map0`.
**Not deployed** — `deploy.sh` is prepared but activating the stub would break
mapping. Activation waits until Phase 1 is byte-verified.

## Deploy (later)
`./deploy.sh --status | --hot | --rollback | deploy` (wrapper-replace strategy,
mirrors `mower/deploy.sh`; backs up the stock binary to `.orig`).
