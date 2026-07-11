# AlphaWeek Phase 2 Redo — Vercel Deployment Pack

## Folder structure

```txt
alphaweek-vercel/
├─ api/
│  ├─ fetch-weekly.js
│  └─ health.js
└─ vercel.json
```

## What this phase does

- `api/health.js` checks the Apps Script dashboard endpoint and reports latest week, symbol count, source count, and news count.
- `api/fetch-weekly.js` runs weekly/manual/seed jobs, reads the Apps Script watchlist, fetches Yahoo Finance prices and RSS news, then posts weekly data back to Apps Script.
- `vercel.json` schedules the weekly cron job at `30 11 * * 5`, which is Friday 11:30 UTC / Friday 18:30 Thailand time.

## Required Vercel Environment Variables

Set these in Vercel Project Settings → Environment Variables → Production, Preview, Development:

```txt
APPS_SCRIPT_URL=https://script.google.com/macros/s/AKfycbzh2PhvOrJu16P9ZLX192PEXUZqTHbp26P1y6TAXNUdO-3UCslhogZHBkoPnOcfx1SA/exec
ALPHAWEEK_PIN=<same PIN as CONFIG.PIN in Apps Script>
MANUAL_TRIGGER_TOKEN=<create a long random token>
```

Optional later:

```txt
SETSMART_API_KEY=<future SET SMART key>
```

## Verification steps

1. Deploy the folder to Vercel as project name `alphaweek`.
2. Open `/api/health`. Before seed it may show `latest_week:null` and `symbols:0` if no weekly data exists yet.
3. Run seed once only: `/api/fetch-weekly?token=<MANUAL_TRIGGER_TOKEN>&seed=1`.
4. Check Google Sheets tab `weekly_data`. Expected: around 13 weeks × 8 rows, if all 7 stocks plus SET are available.
5. Run manual weekly once: `/api/fetch-weekly?token=<MANUAL_TRIGGER_TOKEN>`.
6. Check Google Sheets tab `weekly_news` and run `/api/health` again.
7. Wait for the next Friday cron to confirm automatic run.

## Notes

- Do not commit or store real tokens in Google Drive or GitHub.
- Yahoo Finance is the temporary primary data source until SET SMART is ready.
- If `/api/health` returns `missing env: APPS_SCRIPT_URL`, the Vercel environment variables are not set or the deployment was not redeployed after setting them.
