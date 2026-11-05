# skillBNK CRM

A small leads CRM: import leads, assign them to the team, log activity, see who did what today / yesterday / this week / this month.

Node 22.5+ and one dependency (Express). Data lives in a single SQLite file. No build step.

## Run it

```bash
npm install
npm start          # → http://localhost:3000
```

First run prints the admin login (`admin@skillbnk.local` / `admin123`). Sign in, then **Password** (top right) to change it. Override with env vars: `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `PORT`, `DATA_DIR`.

`npm test` runs the API tests. `npm run dev` restarts on file changes.

## Using it

1. **Team** (admin) – add your people.
2. **Import** – choose a CSV *or* copy cells from Google Sheets and paste. Columns are matched automatically (Master Leads and Apollo exports both work); you can fix any mapping in the preview. Duplicates (same email → LinkedIn → name+company) are skipped, so re-importing is safe. Optionally assign the whole batch to one person or split it evenly across several.
3. **Leads** – owner chips with counts, search, filters (stage, quality, source, Untouched, Follow-ups due, Has meeting), tick rows and bulk-assign or bulk-set stage/quality. Each row has:
   - **LI / Co / Web** buttons: personal LinkedIn profile, company LinkedIn page, company website (greyed out when missing)
   - the email with a **copy** button and a verified/unverified dot
   - inline **Owner / Stage / Quality** dropdowns (changes are logged)
   - one-click **quick log** icons: call, email, LinkedIn action menu (profile view, follow, like, comment, connection request, connected, InMail, DM), meeting/note
   Click a lead's name for the full panel: edit details, set meeting date / next action, log with notes, full history.
4. **Analytics** – Today / Yesterday / This week / Last week / This month / All time / Custom, each with its touch count. Filter by team member, see per-channel totals, the activity matrix per member, a **daily activity chart + table by member**, and the full activity log.

Everything that changes a lead (assignment, stage, quality, meeting date, edits) is logged automatically with who did it. Logging a first call/email/LinkedIn touch on a `New` lead moves it to `Contacted`.

## Importing from the Master Leads sheet

The importer understands the sheet's free-text columns, so a re-import brings the pipeline across, not just contact details:
- **Pipeline Stage** words ("Connection Request Sent", "Discovery Call Held"…) become a CRM stage + outreach status code.
- **Qualification** (PURSUE / QUALIFY / NURTURE / SKIP) is kept as a note in *Opportunity assessment*; SKIP → quality "Not a Fit".
- **Meeting Date** text ("2026-09-11 16:00", several dates, "(CANCELLED …)") becomes real meetings.
- **Notes** lines like `[Oct 7, 2026, 10:38 AM - Name] Comment via Personal LinkedIn` become activity history (times read as Dhaka time).
- "null" / "N/A" cells are treated as empty. Leads that already exist are skipped, so re-importing never overwrites. For existing leads use `scripts/backfill-*.js`.

## Daily work, keys and backups

- **Today** page: who needs the next step (day 7 invite check, day 8 email, first message after accept, day 7 / 14 follow-ups, plus any follow-up date you set). Logging an invite or message pre-fills the next follow-up date.
- **API key** (top bar): creates a key for a script or AI agent. Send `Authorization: Bearer sbk_…`; it acts as you. Only its hash is stored. Delete with `DELETE /api/me/tokens/:id`.
- Useful agent calls: `GET /api/leads/queue?owner=me`, `GET /api/leads/funnel`, `PATCH /api/leads/:id`, `POST /api/leads/:id/activities`.
- Wrong passwords: 8 tries per 15 minutes per address and email, then HTTP 429.
- Backups: a snapshot of the database is written to `data/backups/crm-YYYY-MM-DD.db` on start and every 6 hours (newest 14 kept).
- Import has an *Update existing* option that fills blanks and adds missing meetings and history without overwriting anything.

## Changing things (the easy parts)

| I want to… | Edit |
|---|---|
| Add/rename a **stage**, **quality** or **activity type** (e.g. a new LinkedIn action), change timezone or week start, add team members | `server/config.js` – the UI reads these lists from the server (new activity types also need an icon in `TYPE_ICON`, `public/js/icons.js`) |
| Teach the importer a new **column name** | `ALIASES` in `server/lib/importer.js` |
| Add a **new lead field** | column in `server/db.js` (+ `ALTER TABLE` on an existing DB), name in `TEXT_FIELDS` in `server/routes/leads.js`, `DETAIL_FIELDS` in `public/js/views/lead-drawer.js` |
| Add a **new page** | new file in `public/js/views/` exporting `render(root, ctx)`, one line in `PAGES` in `public/js/app.js` |
| Add a new API route | new file in `server/routes/`, one line in `server/app.js` |

## Layout

```
server/
  config.js          stages, qualities, timezone, activity types
  db.js              schema + logActivity()
  auth.js            login, sessions, passwords
  lib/importer.js    CSV parsing + column mapping
  lib/range.js       today/yesterday/week/month boundaries
  routes/            leads, activity, import, team
public/
  js/app.js          router + top bar
  js/icons.js        icon set
  js/views/          one file per screen (leads, lead-drawer, analytics, import, team, login)
test/api.test.js
```

## Notes

- Backup = copy `data/crm.db` (stop the server first, or copy the `-wal` file too).
- Putting it online: run behind HTTPS (Caddy / nginx / any host that gives you Node) and set `ADMIN_PASSWORD` before the first start. Sessions are signed cookies; the signing key is generated into `data/.secret`.
- Importing a lead whose **Owner** column names someone with no account creates a placeholder member (random password) – reset it in **Team**.
