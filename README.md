# Datadog Adoption Scorecard — HKJC

A certification-grid dashboard for tracking Datadog adoption across HKJC champions.
Live data is pulled from the Datadog Audit Trail and Usage Metrics APIs and auto-refreshed every 30 minutes.

## Features

- **Certification Grid** — users × milestones table; green = done, locked = not yet
- **Awards Panel** — live cert-tier counts, prize descriptions, special prize winners
- **Evidence Modal** — click any cell to see the Audit Trail query or metric that drove the result, with a direct link to verify in Datadog
- **Admin PIN lock** — manual milestones (training sessions, learning paths, certs) can be toggled in the UI once unlocked; changes persist to `overrides.json`
- **Auto-refresh** — server re-queries Datadog every 30 min; all open browser tabs update automatically
- **Demo route** — `/demo` serves a static snapshot with seeded champion data (no API keys needed)
- **HKJC-themed** — dark forest green design, co-branded Datadog + HKJC header

## Certification tiers

| Tier | Requirements | Prize |
|---|---|---|
| 🥉 Bronze | Session 1 + Dashboard + Monitor | Datadog Sticker Pack |
| 🥈 Silver | Bronze + Sessions 2 & 3 + SLO | Datadog T-Shirt |
| 🥇 Gold | Silver + Sessions 4–6 + Notebook + Bits AI SRE | Datadog Hoodie |
| 💎 Platinum | Gold + Learning Path + Case Created | $50 Gift Card |

Special prizes: First to Platinum (Backpack), First Bits AI SRE (Collector's Badge), Top Scorer ($100 Gift Voucher).

## Quick start

```bash
npm install

# Copy and fill in credentials
cp .env.example .env   # or create .env manually (see below)

node server.js
# → http://localhost:3000
```

The server fetches live data on startup and auto-refreshes every 30 minutes.
Visit `/demo` for a static demo with no API keys required.

## .env reference

```
DD_API_KEY=<Datadog API key>
DD_APP_KEY=<Datadog Application key>
DD_SITE=datadoghq.com          # or ap1.datadoghq.com, datadoghq.eu, etc.
DD_ORG_NAME=HKJC               # displayed in the header

# User filtering (pick one approach)
DD_USER_EMAILS=alice@hkjc.org.hk,bob@hkjc.org.hk   # explicit list
DD_USER_DOMAIN=hkjc.org.hk                           # all active users in domain
DD_USER_LIMIT=50                                      # cap (0 = no limit)

ADMIN_PIN=1234                 # PIN to unlock manual milestone editing
PORT=3000
REFRESH_INTERVAL_MS=1800000    # 30 min default
```

## Manual milestones

Training sessions, learning paths, and certifications are tracked via `overrides.json`.
Toggle them directly in the UI (unlock with the 🔒 button) — changes persist automatically.
Or edit the file directly:

```json
{
  "user@hkjc.org.hk": {
    "session_1": true,
    "session_2": true,
    "session_3": false,
    "learning_path": false,
    "cert_fundamentals": false,
    "cert_apm": false,
    "cert_logs": false
  }
}
```

Manual milestone IDs: `session_1`–`session_6`, `learning_path`, `cert_fundamentals`, `cert_apm`, `cert_logs`.

## Milestone categories

| Category | Detection | Milestones |
|---|---|---|
| Core — Audit Trail | Auto (Audit Trail) | Dashboard, Monitor, SLO, Notebook, Case, Bits AI SRE |
| Org Foundation | Auto (Usage Metric) | Infra Hosts, Containers, APM, Logs, RUM, Custom Metrics, Serverless |
| Special Achievements | Auto (Usage Metric) | DBM, Continuous Profiler, Network Monitoring |
| HKJC Day 1 | Manual | Sessions 1–3 |
| HKJC Day 2 | Manual | Sessions 4–6 |
| Self Learning | Manual | Persona Based Learning Path |
| Advanced | Manual | Fundamentals Cert, APM Cert, Log Management Cert |

## Deployment (GCP)

The app runs on GCP VM `hkjc-scorecard` (project `datadog-ese-sandbox`, zone `asia-east2-a`) behind nginx, managed by PM2.

```bash
# Deploy code changes
./deploy.sh

# Deploy + re-pull live Datadog data
./deploy.sh --refresh-data
```

Manual deploy steps:
```bash
# Upload changed files
gcloud compute scp --tunnel-through-iap --project=datadog-ese-sandbox --zone=asia-east2-a \
  <files> hkjc-scorecard:~/adoption-scorecard/

# Restart
gcloud compute ssh hkjc-scorecard --project=datadog-ese-sandbox --zone=asia-east2-a \
  --tunnel-through-iap --command="pm2 restart scorecard"
```

Live at **https://dd-hkjc-adoption-scorecard.com** · Demo at **/demo**

## File structure

```
├── index.html          Main SPA
├── demo.html           Static demo route (/demo)
├── style.css           HKJC dark forest green theme
├── script.js           Rendering — grid, awards panel, evidence modal
├── server.js           Node.js server: Datadog API proxy + static serving + auto-refresh
├── refresh.js          Standalone data refresh (writes data.js)
├── data.js             Generated live data (gitignored)
├── data.sample.js      Fallback sample data for demo mode
├── overrides.json      Persisted manual milestone completions
├── evidence.json       Cached evidence (gitignored)
├── dd-logo.png         Datadog logo (Dash)
├── hkjc-logo.png       HKJC crest
├── ecosystem.config.js PM2 process config
├── nginx.conf          Nginx reverse proxy config
├── deploy.sh           GCP deployment script
└── package.json
```
