// PYE uptime monitor. Runs every 5 minutes from GitHub Actions.
// Checks each site, emails alerts through Resend, and writes the dashboard data.
// No dependencies: Node 22 built-ins only.

import fs from 'node:fs/promises';
import path from 'node:path';
import tls from 'node:tls';
import { setTimeout as sleep } from 'node:timers/promises';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 5_000;
const CONFIRM_FAILS = 2; // checks in a row before a DOWN email
const REMINDER_MS = 2 * HOUR;
const WARNING_REPEAT_MS = DAY;
const SLOW_MS = Number(process.env.SLOW_MS || 8_000);
const SLOW_STREAK = 3;
const SSL_WARN_DAYS = Number(process.env.SSL_WARN_DAYS || 14);
const DOMAIN_WARN_DAYS = Number(process.env.DOMAIN_WARN_DAYS || 30);
const DOMAIN_LOOKUP_EVERY_MS = DAY;
const LOOKUP_RETRY_MS = HOUR; // after a failed RDAP lookup
const CERT_LOOKUP_EVERY_MS = DAY;
const WEBFLOW_LOOKUP_EVERY_MS = HOUR;
const HISTORY_MS = 7 * DAY;

const env = process.env;
const DATA_DIR = env.DATA_DIR || 'data';
const SITES_FILE = env.SITES_FILE || path.join(import.meta.dirname, 'sites.json');
const DRY_RUN = env.DRY_RUN === '1';
const DASHBOARD_URL = env.DASHBOARD_URL || 'https://pye-dashboard.vercel.app';
const ALERT_FROM = env.ALERT_FROM || 'PYE Uptime <alerts@alerts.thecreative.company>';
const ALERT_TO = (env.ALERT_TO || 'chris@protectyoungeyes.com,nick@thecreative.company')
  .split(',').map((s) => s.trim()).filter(Boolean);

const HINTS = {
  dns: 'The domain name is not resolving. Check the DNS records in Cloudflare (or wherever the domain\'s DNS is hosted) and that the domain has not expired.',
  timeout: `The site did not answer within ${TIMEOUT_MS / 1000} seconds. Check https://status.webflow.com for a Webflow outage, then the site's hosting in Webflow.`,
  connection: 'The connection was refused or dropped. Check https://status.webflow.com for a Webflow outage, then the domain settings in Webflow.',
  server: 'The server returned an error. Check https://status.webflow.com for a Webflow outage, then republish the site in Webflow.',
  ssl: 'The HTTPS certificate is failing, so browsers will show a security warning. Check the SSL settings for the domain in Webflow and Cloudflare.',
  'wrong-page': 'The site answered, but not with the right page. Check that the site is published in Webflow and that the domain is still connected to it.',
  redirect: 'The site sends visitors to a different domain. Check redirects in Webflow and rules in Cloudflare. An unexpected redirect can mean the domain was tampered with.',
};

// ---------- formatting ----------

function fmtTime(ms) {
  const d = new Date(ms);
  const et = d.toLocaleString('en-US', {
    timeZone: 'America/Detroit', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const hst = d.toLocaleString('en-US', { timeZone: 'Pacific/Honolulu', hour: 'numeric', minute: '2-digit' });
  return `${et} ET (${hst} HST)`;
}

function fmtDuration(ms) {
  const mins = Math.max(1, Math.round(ms / MINUTE));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 48) return m ? `${h} h ${m} min` : `${h} h`;
  return `${Math.floor(h / 24)} days ${h % 24} h`;
}

// ---------- probes ----------

const registrable = (host) => host.split('.').slice(-2).join('.');

function classifyError(err) {
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
    return { kind: 'timeout', message: `No response within ${TIMEOUT_MS / 1000} seconds` };
  }
  const code = err?.cause?.code || err?.code || '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { kind: 'dns', message: `DNS lookup failed (${code})` };
  if (/CERT|TLS|SSL|UNABLE_TO_VERIFY|SELF_SIGNED/.test(code)) return { kind: 'ssl', message: `HTTPS certificate error (${code})` };
  return { kind: 'connection', message: `Connection failed (${code || err?.message || 'unknown error'})` };
}

async function probe(site) {
  const started = Date.now();
  try {
    const res = await fetch(site.url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'follow',
      headers: { 'user-agent': 'PYE-Uptime-Monitor/1.0 (+https://pye-dashboard.vercel.app)', 'cache-control': 'no-cache' },
    });
    const body = await res.text();
    const ms = Date.now() - started;
    const base = { ms, httpCode: res.status };
    if (registrable(new URL(res.url).hostname) !== registrable(new URL(site.url).hostname)) {
      return { ...base, ok: false, kind: 'redirect', message: `Redirects to a different domain: ${res.url}` };
    }
    if (res.status >= 500) return { ...base, ok: false, kind: 'server', message: `Server error: HTTP ${res.status}` };
    if (res.status >= 400) return { ...base, ok: false, kind: 'wrong-page', message: `Page error: HTTP ${res.status}` };
    if (site.expectedText && !body.toLowerCase().includes(site.expectedText.toLowerCase())) {
      return { ...base, ok: false, kind: 'wrong-page', message: `The page loaded but does not contain "${site.expectedText}"` };
    }
    return { ...base, ok: true };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, httpCode: 0, ...classifyError(err) };
  }
}

async function probeWithRetry(site) {
  const first = await probe(site);
  if (first.ok) return first;
  await sleep(RETRY_DELAY_MS);
  return probe(site);
}

async function certExpiry(host, cache) {
  const cached = cache[host];
  if (cached && Date.now() - cached.checkedAt < CERT_LOOKUP_EVERY_MS) return cached.expiresAt;
  const expiresAt = await readCertExpiry(host);
  if (expiresAt) cache[host] = { expiresAt, checkedAt: Date.now() };
  return expiresAt ?? cached?.expiresAt ?? null;
}

function readCertExpiry(host) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port: 443, servername: host, timeout: 10_000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      resolve(cert?.valid_to ? new Date(cert.valid_to).toISOString() : null);
    });
    socket.on('error', () => resolve(null));
    socket.on('timeout', () => { socket.destroy(); resolve(null); });
  });
}

async function domainExpiry(domain, cache) {
  const cached = cache[domain];
  if (cached && Date.now() - cached.checkedAt < DOMAIN_LOOKUP_EVERY_MS) return cached.expiresAt;
  try {
    const res = await fetch(`https://rdap.org/domain/${domain}`, {
      headers: { accept: 'application/rdap+json', 'user-agent': 'PYE-Uptime-Monitor/1.0' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`RDAP HTTP ${res.status}`);
    const json = await res.json();
    const exp = json.events?.find((e) => e.eventAction === 'expiration')?.eventDate ?? null;
    cache[domain] = { expiresAt: exp, checkedAt: Date.now() };
    return exp;
  } catch (err) {
    console.warn(`Domain lookup failed for ${domain}: ${err.message}`);
    const expiresAt = cached?.expiresAt ?? null;
    // Retry in an hour rather than on every run.
    cache[domain] = { expiresAt, checkedAt: Date.now() - DOMAIN_LOOKUP_EVERY_MS + LOOKUP_RETRY_MS };
    return expiresAt;
  }
}

async function webflowSites(cache) {
  if (!env.WEBFLOW_TOKEN) return {};
  if (cache.checkedAt && Date.now() - cache.checkedAt < WEBFLOW_LOOKUP_EVERY_MS) return cache.sites;
  cache.checkedAt = Date.now(); // also throttles retries after a failure
  try {
    const res = await fetch('https://api.webflow.com/v2/sites', {
      headers: { authorization: `Bearer ${env.WEBFLOW_TOKEN}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { sites = [] } = await res.json();
    cache.sites = Object.fromEntries(sites.map((s) => [s.shortName, { lastPublished: s.lastPublished ?? null, displayName: s.displayName }]));
  } catch (err) {
    console.warn(`Webflow lookup failed: ${err.message}`);
  }
  return cache.sites ?? {};
}

// ---------- email ----------

async function sendEmail(subject, text) {
  if (DRY_RUN) {
    console.log(`\n=== EMAIL to ${ALERT_TO.join(', ')}\nSubject: ${subject}\n\n${text}\n===`);
    return true;
  }
  if (!env.RESEND_API_KEY) {
    console.error(`RESEND_API_KEY is not set. Could not send: ${subject}`);
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: ALERT_FROM, to: ALERT_TO, subject, text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
    console.log(`Sent: ${subject}`);
    return true;
  } catch (err) {
    console.error(`Email failed (${subject}): ${err.message}`);
    return false;
  }
}

const FOOTER = `Dashboard: ${DASHBOARD_URL}\n\nPYE uptime monitor. It checks every 5 minutes. While a site stays down you get a reminder every 2 hours, and one email when it recovers.`;

function downEmail(site, s, now, webflow) {
  const reminder = Boolean(s.lastAlertAt);
  const subject = reminder
    ? `🔴 STILL DOWN: ${site.name}, ${fmtDuration(now - s.downSince)}`
    : `🔴 DOWN: ${site.name} | ${s.lastError.message.slice(0, 70)}`;
  const lines = [
    `${site.name} is ${reminder ? 'still ' : ''}down.`,
    '',
    `What failed: ${s.lastError.message}`,
    `Down since: ${fmtTime(s.downSince)} (${fmtDuration(now - s.downSince)})`,
    `Last good check: ${s.lastOkAt ? fmtTime(s.lastOkAt) : 'none recorded'}`,
    `URL: ${site.url}`,
  ];
  const published = webflow?.lastPublished ? Date.parse(webflow.lastPublished) : null;
  if (published && s.downSince - published < HOUR && s.downSince >= published) {
    lines.push('', `Note: this site was published in Webflow at ${fmtTime(published)}, ${fmtDuration(s.downSince - published)} before it went down. The publish may be the cause.`);
  }
  lines.push('', `Check first: ${HINTS[s.lastError.kind] ?? HINTS.server}`, '', FOOTER);
  return [subject, lines.join('\n')];
}

function recoveredEmail(site, rec) {
  const dur = fmtDuration(rec.recoveredAt - rec.downSince);
  return [
    `✅ RECOVERED: ${site.name}, down ${dur}`,
    [
      `${site.name} is back up.`,
      '',
      `Down from: ${fmtTime(rec.downSince)}`,
      `Back up at: ${fmtTime(rec.recoveredAt)}`,
      `Total downtime: ${dur}`,
      `Last error: ${rec.lastError}`,
      `URL: ${site.url}`,
      '',
      FOOTER,
    ].join('\n'),
  ];
}

function warningEmail(site, w) {
  return [
    `🟡 WARNING: ${w.title}: ${site.name}`,
    [`${site.name}: ${w.message}`, '', `URL: ${site.url}`, '', `What to do: ${w.action}`, '', FOOTER].join('\n'),
  ];
}

// ---------- state ----------

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(path.join(DATA_DIR, file), 'utf8')); } catch { return fallback; }
}
async function writeJson(file, value, indent = 2) {
  await fs.writeFile(path.join(DATA_DIR, file), JSON.stringify(value, null, indent) + '\n');
}

// One pass over the history: uptime for 24h and 7d (null when there is no data) and the speed trend.
function stats(history, now) {
  const acc = {};
  for (const c of history.checks) {
    const recent = c.t >= now - DAY;
    for (const r of c.results) {
      const a = acc[r.name] ??= { day: [0, 0], week: [0, 0], msRecent: [0, 0], msBefore: [0, 0] };
      a.week[0] += r.ok; a.week[1] += 1;
      if (recent) { a.day[0] += r.ok; a.day[1] += 1; }
      if (r.ok) { const m = recent ? a.msRecent : a.msBefore; m[0] += r.ms; m[1] += 1; }
    }
  }
  const pct = ([ok, n]) => (n ? Math.round((ok / n) * 10_000) / 100 : null);
  const avg = ([sum, n]) => (n ? sum / n : null);
  return (name) => {
    const a = acc[name];
    if (!a) return { uptime24h: null, uptime7d: null, trend: 'stable' };
    const recent = avg(a.msRecent);
    const before = avg(a.msBefore);
    let trend = 'stable';
    if (recent && before && recent > before * 1.2) trend = 'degrading';
    else if (recent && before && recent < before * 0.8) trend = 'improving';
    return { uptime24h: pct(a.day), uptime7d: pct(a.week), trend };
  };
}

// ---------- main ----------

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const sites = JSON.parse(await fs.readFile(SITES_FILE, 'utf8'));
  const state = await readJson('state.json', {});
  state.sites ??= {};
  state.domains ??= {};
  state.certs ??= {};
  state.webflow ??= {};
  const history = await readJson('history.json', { checks: [] });
  const now = Date.now();
  let emailFailures = 0;
  const send = async (subject, text) => {
    const ok = await sendEmail(subject, text);
    if (!ok) emailFailures += 1;
    return ok;
  };

  const [webflow, probes] = await Promise.all([
    webflowSites(state.webflow),
    Promise.all(sites.map(async (site) => {
      const host = new URL(site.url).hostname;
      const domain = registrable(host);
      const [result, certExp, domainExp] = await Promise.all([
        probeWithRetry(site),
        certExpiry(host, state.certs),
        domainExpiry(domain, state.domains),
      ]);
      const sslDays = certExp ? (Date.parse(certExp) - now) / DAY : null;
      return { site, domain, result, sslDays, domainExp };
    })),
  ]);

  const results = [];
  for (const { site, domain, result: r, sslDays, domainExp } of probes) {
    const s = state.sites[site.name] ??= { status: 'up', fails: 0, slowStreak: 0, warnings: {} };
    if (webflow[site.webflowShortName]) s.webflow = webflow[site.webflowShortName];
    const wf = s.webflow ?? null;

    // DOWN / RECOVERED
    if (r.ok) {
      if (s.status === 'down') {
        s.recoveryPending = { downSince: s.downSince, recoveredAt: now, lastError: s.lastError?.message ?? 'unknown' };
      }
      Object.assign(s, { status: 'up', fails: 0, firstFailAt: null, downSince: null, lastAlertAt: null, lastError: null, lastOkAt: now });
      s.slowStreak = r.ms > SLOW_MS ? s.slowStreak + 1 : 0;
    } else {
      s.fails += 1;
      s.slowStreak = 0;
      s.firstFailAt ??= now;
      s.lastError = { kind: r.kind, message: r.message };
      if (s.status !== 'down' && s.fails >= CONFIRM_FAILS) {
        s.status = 'down';
        s.downSince = s.firstFailAt;
      }
    }
    if (s.status === 'down' && (!s.lastAlertAt || now - s.lastAlertAt >= REMINDER_MS)) {
      if (await send(...downEmail(site, s, now, wf))) s.lastAlertAt = now;
    }
    if (s.recoveryPending) {
      if (await send(...recoveredEmail(site, s.recoveryPending))) delete s.recoveryPending;
    }

    // WARNINGS
    const active = [];
    if (sslDays !== null && sslDays < SSL_WARN_DAYS) {
      const days = Math.floor(sslDays);
      active.push({ key: 'ssl', title: `SSL certificate expires in ${days} days`, message: `The HTTPS certificate expires in ${days} days. After that, browsers will block the site with a security warning.`, action: 'Webflow renews certificates automatically. If it has not, check the domain connection in Webflow and the SSL mode in Cloudflare.' });
    }
    if (domainExp) {
      const days = Math.floor((Date.parse(domainExp) - now) / DAY);
      if (days < DOMAIN_WARN_DAYS) {
        active.push({ key: 'domain', title: `Domain expires in ${days} days`, message: `The domain ${domain} expires on ${new Date(domainExp).toDateString()} (${days} days).`, action: 'Renew the domain with its registrar, and confirm auto-renew and the payment card on file.' });
      }
    }
    if (s.slowStreak >= SLOW_STREAK) {
      active.push({ key: 'slow', title: 'Slow responses', message: `The site took ${(r.ms / 1000).toFixed(1)} seconds to load on the last ${s.slowStreak} checks (warning threshold: ${SLOW_MS / 1000} seconds).`, action: 'Check https://status.webflow.com, then large images or scripts added in the last publish.' });
    }
    for (const w of active) {
      const prev = s.warnings[w.key];
      if (!prev || now - prev.lastAlertAt >= WARNING_REPEAT_MS) {
        if (await send(...warningEmail(site, w))) s.warnings[w.key] = { lastAlertAt: now };
      }
    }
    // Keep a cleared warning's timestamp until its repeat window passes, so a flapping warning still emails once a day at most.
    for (const [key, w] of Object.entries(s.warnings)) {
      if (!active.some((a) => a.key === key) && now - w.lastAlertAt >= WARNING_REPEAT_MS) delete s.warnings[key];
    }

    results.push({
      name: site.name,
      url: site.url,
      status: r.ok ? 'up' : 'down',
      responseTime: r.ms,
      httpCode: r.httpCode,
      error: r.ok ? null : r.message,
      downSince: s.downSince ?? null,
      warnings: active.map((w) => w.title),
      lastChecked: new Date(now).toISOString(),
      sslDaysLeft: sslDays === null ? null : Math.floor(sslDays),
      domainExpiresAt: domainExp,
      webflow: wf,
    });
  }

  history.checks.push({ t: now, results: results.map((r) => ({ name: r.name, ok: r.status === 'up', ms: r.responseTime })) });
  history.checks = history.checks.filter((c) => c.t >= now - HISTORY_MS);
  const statsFor = stats(history, now);
  for (const r of results) Object.assign(r, statsFor(r.name));

  await writeJson('state.json', state);
  await writeJson('history.json', history, 0);
  await writeJson('status.json', {
    checkTime: new Date(now).toISOString(),
    displayTime: fmtTime(now),
    allHealthy: results.every((r) => r.status === 'up'),
    results,
  });

  for (const r of results) console.log(`${r.status.toUpperCase().padEnd(4)} ${r.name} ${r.httpCode} ${r.responseTime}ms ${r.error ?? ''} ${r.warnings.join('; ')}`);
  if (emailFailures) {
    console.error(`${emailFailures} alert email(s) failed. They will retry on the next run.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
