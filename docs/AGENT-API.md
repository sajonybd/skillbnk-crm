# AI agent / API guide

An AI agent can use the CRM the way a team member does: read the plan, read leads, log what was done and update status. It acts **as the person whose API key it uses**, so every change is logged under that name.

## What an agent should and should not do
- **Good uses:** read today's plan, research a lead and fill its fields, **draft** messages and comments for a human to review, log activities, update status and next steps, create leads (duplicates are merged), prepare meetings, build reports, and ask the admin to change the plan.
- **Keep a human in the loop for sending.** LinkedIn forbids automated messaging and can restrict accounts. Let the agent draft; the team member sends and then logs it.
- **Follow the Playbook.** Read `GET /api/playbook` first. If the plan seems wrong, do not work around it: send a change request (below).

## Authentication
Open the CRM, press **API key** (bottom left), create a key, copy it (it is shown once). Send it on every call:
```
Authorization: Bearer sbk_xxxxxxxx
Content-Type: application/json
```
A key works for the same things its owner can do. Use the admin's key if the agent must see or update every team member. Base URL: your Render address, for example `https://skillbnk-crm.onrender.com`.

## Endpoints
| Purpose | Call |
|---|---|
| Read the marketing plan and rules | `GET /api/playbook` |
| Today's plan for one person | `GET /api/plan?assignee=me` (or a user id, or `all`), `&day=tomorrow` for the next working day |
| List team members | `GET /api/team` |
| Search leads | `GET /api/leads?q=name&owner=<id>&limit=50&page=1` |
| One lead with history | `GET /api/leads/<id>` |
| Add a lead (merges if it exists) | `POST /api/leads` with `first_name, last_name, company, title, email, linkedin, ...` |
| Edit a lead | `PATCH /api/leads/<id>` with any fields: `tier, quality, opportunity_path, assessment, denial_reason, outreach_status, owner_id, next_action, next_action_date, ...` |
| Record the result of a planned step | `POST /api/leads/<id>/step` with `{ "result": "sent", "kind": "followup", "note": "<text sent>" }` |
| Log any activity | `POST /api/leads/<id>/activities` with `{ "type": "linkedin_comment", "note": "<text>" }` |
| Book a meeting | `POST /api/leads/<id>/meetings` with `{ "scheduled_date": "2026-11-10", "scheduled_time": "15:00", "booked_by": <user id>, "notes": "..." }` |
| Reports | `GET /api/reports/plan`, `/eod`, `/weekly` with `?assignee=<id>` (returns `markdown`) |
| Ask the admin to change the plan | `POST /api/playbook/requests` with `{ "title": "...", "details": "why and what" }` |

`result` values for `/step`: `accepted, pending, sent, seen, replied, comment, nurture, not_interested, snooze`. `kind` (for `sent`): `email, first_message, followup, last_followup, reply`.
Activity `type` values: `linkedin_view, linkedin_follow, linkedin_like, linkedin_comment, linkedin_connect, linkedin_connected, linkedin_inmail, linkedin_dm, email, call, meeting, note`.

## A good daily loop for an agent
1. `GET /api/playbook` (once a day, to pick up rule changes).
2. `GET /api/plan?assignee=<member id>`: the `actions` list is already ordered and capped.
3. For each action, open `GET /api/leads/<id>`, research, and **write a draft** for the member (use the lead's `why`, `question` and notes).
4. When the member confirms it was sent, call `/step` with the text, so the reports are complete.
5. At the end of the day, `GET /api/reports/eod?assignee=<id>`.
6. If a rule or number looks wrong, `POST /api/playbook/requests`. The admin decides in the Playbook page.

## Limits
Stay under about 60 calls a minute. Logins are rate-limited. Errors come back as `{ "error": "message" }` with a normal HTTP status.
