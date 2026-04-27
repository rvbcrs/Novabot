# Runtime tests for mqtt_node

These scripts run on a real mower (192.168.0.100 by default). They are
NOT part of the pytest suite. They exist to:

1. Capture a baseline of stock-binary behaviour (`parity_capture.sh`)
2. Run our binary side-by-side and diff the output (`parity_smoke.sh`)
3. Walk the user through activation manually (`acceptance_checklist.md`)

Set `MOWER_IP` to override the default.

⚠️ Hardware tests can disrupt mowing operations. Always coordinate with
the user before running anything that kills processes on the mower.
