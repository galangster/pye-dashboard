// Sends one test email to the alert recipients. Run from the "test-email" workflow.
const env = process.env;
const to = (env.ALERT_TO || 'chris@protectyoungeyes.com,nick@thecreative.company').split(',').map((s) => s.trim()).filter(Boolean);
const from = env.ALERT_FROM || 'PYE Uptime <alerts@alerts.thecreative.company>';

const text = `This is a test from the new PYE uptime monitor. No action is needed.

From now on, it checks these sites every 5 minutes:
- Protect Young Eyes (protectyoungeyes.com)
- Tech Ready Family (techreadyfamily.com)
- Ten Billion Minutes (tenbillionminutes.org)
- Better Tech Project (bettertechproject.org)

You'll get an email when:
- a site is down for 2 checks in a row (about 10 minutes), with a reminder every 2 hours until it's back
- a site recovers, with the total downtime
- an SSL certificate or domain is close to expiring, or a site is consistently slow

If the monitor itself stops, healthchecks.io emails you separately.

Heads-up: tenbillionminutes.org and techreadyfamily.com come up for renewal in January 2027. You'll get a warning 30 days before each.

If this landed in spam, please mark it "Not spam" so real alerts get through.

Dashboard: https://pye-dashboard.vercel.app`;

const res = await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify({ from, to, subject: '✅ PYE uptime monitor is live (test email)', text }),
});
const body = await res.text();
console.log(`HTTP ${res.status} ${body}`);
if (!res.ok) process.exit(1);
