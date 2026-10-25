# PinScope

PinScope is a self-contained, full-stack layout intelligence workspace for power-electronics engineers. It demonstrates three workflows:

- **Classify** — image-assisted package / pinout recognition with reviewable evidence.
- **Select** — weighted nearest-neighbor reuse recommendations across layout projects.
- **Size** — family-specific current-to-die-area curve fitting for first-pass estimates.

## Run locally

This project has no third-party runtime dependencies. Install Node.js 18+ and run:

```bash
npm start
```

Then open [http://localhost:4173](http://localhost:4173).

If port 4173 is already occupied, PinScope automatically selects an available local port and prints its URL in the terminal. To choose a port explicitly in PowerShell, run `$env:PORT=4174; npm start` (or in bash/zsh: `PORT=4174 npm start`).

## Engineering model

The API filters recommendations by topology and interconnect method where possible, then scores candidate layouts using log-normalized geometry, current, and pin-count distances. The weights intentionally prioritize current and pinout (54% combined). The estimator implements a per-family power curve `I = a × area^b` from example project data.

This is a prototype decision-support tool. Pin labels and sizing outputs should always be verified against the authoritative datasheet and signoff flow.
