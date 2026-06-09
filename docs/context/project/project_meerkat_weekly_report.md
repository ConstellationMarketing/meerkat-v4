---
name: Meerkat Weekly Report (automated)
description: Automated weekly email report — article generation stats and editing feedback by version, sends Monday 9am EDT
type: project
---

**Script:** `/root/meerkat-service/weekly-report.js` on VPS (also in local repo at `/Users/elicurtin/meerkatv4/weekly-report.js`)

**Schedule:** Cron on VPS, every Monday 9am EDT (1pm UTC): `0 13 * * 1`

**Recipients:** elicurtin@gmail.com, patrick@goconstellation.com, jacqueline@goconstellation.com, lindsay@goconstellation.com

**Sends via:** Gmail SMTP using app password (stored in VPS .env as `GMAIL_APP_PASSWORD`, from elicurtin@gmail.com)

**Report contents:**
- Table 1: Weekly summary (last 4 weeks) — articles generated, batch articles, feedback count, avg edit time
- Table 2: Performance by version (all time) — feedback count, avg edit time, median edit time

**Log:** `/root/meerkat-service/weekly-report.log`

**How to apply:** To preview locally: `cd /Users/elicurtin/meerkatv4 && node weekly-report.js --preview`. To add recipients, update `REPORT_RECIPIENTS` in VPS .env.
