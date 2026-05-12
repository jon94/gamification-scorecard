# Datadog Adoption Scorecard

A certification-style gamification dashboard for tracking Datadog adoption across your team.

## Features

- **Certification Grid** — GitHub-heatmap style grid of users × milestones (green = done)
- **Scoreboard** — Champion rankings, GC leaderboard, certified practitioners list
- **Live data** from Datadog Audit Trail + Usage Metrics APIs
- **Demo mode** — works immediately with sample data (no API keys needed)
- **Dark theme** matching Datadog's ADB Champions aesthetic

## Quick start (demo)

Just open `index.html` in your browser. Sample data loads automatically.

## Live data setup

```bash
# 1. Install dependencies
npm install

# 2. Configure credentials
cp .env.example .env
# Edit .env with your DD_API_KEY, DD_APP_KEY, DD_SITE

# 3. Fetch live data
node refresh.js

# 4. Open in browser
npm run serve
# or just open index.html
```

## Manual milestone tracking

Edit `overrides.json` to set manual milestones per user:

```json
{
  "user@example.com": {
    "training_part1": true,
    "training_part2": false,
    "tags_applied": true,
    "team_training": false,
    "presentation": false
  }
}
```

You can also click any manual milestone cell in the grid to toggle it temporarily (in-memory only — run `refresh.js` to persist via `overrides.json`).

## Certification Tiers

| Tier     | Required Milestones                                              | GC Bonus |
|----------|------------------------------------------------------------------|----------|
| 🥉 Bronze  | Agent + Dashboard + Alert + Training Part 1                     | +200 GC  |
| 🥈 Silver  | Bronze + Logs + APM + Tags Applied                              | +300 GC  |
| 🥇 Gold    | Silver + RUM + Synthetics + SLO + Training Part 2               | +400 GC  |
| 💎 Platinum | Gold + Presentation + 2 Special Achievements                  | +500 GC  |

## Hosting on tiiny.host

```bash
# Zip the static files (excluding node_modules and .env)
zip -r scorecard.zip index.html style.css script.js data.js data.sample.js
# Upload scorecard.zip to https://tiiny.host
```

## File structure

```
├── index.html         Static SPA entry point
├── style.css          Dark theme styles
├── script.js          Rendering logic (grid + scoreboard)
├── refresh.js         Node.js script: Datadog APIs → data.js
├── data.js            Generated live data (gitignored)
├── data.sample.js     Demo data (committed)
├── overrides.json     Manual milestone completions
├── .env.example       Credential template
└── package.json
```
