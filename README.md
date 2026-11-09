# PYE uptime monitor

Watches the Protect Young Eyes websites, emails alerts, and shows status at https://pye-dashboard.vercel.app.

## How it works

- `.github/workflows/monitor.yml` runs `scripts/monitor.mjs` every 5 minutes (GitHub may start a run late).
- The checker loads each site in `scripts/sites.json`, retries a failure once after 5 seconds, and records the result.
- It writes `status.json`, `history.json` (7 days) and `state.json` to the `data` branch. The branch is force-pushed as one commit, so the repo does not grow.
- The dashboard (`src/app/page.tsx`) is a static Next.js export. It reads `status.json` from the `data` branch in the browser. Vercel deploys only from `main` (`vercel.json` turns off deploys from `data`).

## Alerts

Emails go to `chris@protectyoungeyes.com` and `nick@thecreative.company` through Resend.

| Email | When |
| --- | --- |
| 🔴 DOWN | 2 checks in a row fail: DNS failure, timeout (15 s), refused connection, HTTPS error, HTTP 4xx or 5xx, a redirect to another domain, or the page is missing its expected text |
| 🔴 STILL DOWN | Every 2 hours while the site stays down |
| ✅ RECOVERED | The first good check after a DOWN, with the total downtime |
| 🟡 WARNING | SSL certificate expires in under 14 days, domain expires in under 30 days, or 3 checks in a row take over 8 s. Repeats once a day while it holds |
| healthchecks.io | The monitor stopped or failed. No ping for 30 minutes, or a run reported failure |

If an email fails to send, the run fails, healthchecks.io reports it, and the email retries on the next run.

## Configuration

GitHub repository secrets (Settings → Secrets and variables → Actions):

| Secret | Required | Purpose |
| --- | --- | --- |
| `RESEND_API_KEY` | yes | Sends alert emails. The run fails without it |
| `HC_PING_URL` | yes | healthchecks.io ping URL. The run fails without it |
| `WEBFLOW_TOKEN` | no | Read-only Webflow token. Adds "last published" to the dashboard and to DOWN emails |

Optional repository variables: `ALERT_TO` (comma-separated, replaces the default recipients) and `ALERT_FROM`.

healthchecks.io check settings: period 5 minutes, grace 30 minutes, email integration to both recipients.

## Add or change a site

Edit `scripts/sites.json`. `expectedText` must appear in the page HTML (the page title works well). `webflowShortName` matches the site in the Webflow API.

## Test locally

```bash
DRY_RUN=1 DATA_DIR=/tmp/pye-data node scripts/monitor.mjs
```

`DRY_RUN=1` prints emails instead of sending them. `SITES_FILE`, `SSL_WARN_DAYS`, `DOMAIN_WARN_DAYS` and `SLOW_MS` override the defaults for tests.

`archive/2026-02/` holds the data from the old once-a-day monitor, which stopped on 27 February 2026.
