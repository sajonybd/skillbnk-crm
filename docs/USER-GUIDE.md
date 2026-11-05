# skillBNK CRM: user guide

This CRM turns the marketing plan into a daily to-do list. Open **Plan** each morning and work from the top.

## 1. Your day in five steps
1. **Plan** (first item in the menu). It shows today's lead actions, daily targets, team tasks, how leads are responding, and what you achieved so far.
2. **Do the lead actions from the top.** Each card says exactly what to do, for example "Send the short email" or "Check if the invite was accepted".
3. After you do it on LinkedIn or email, **type what you wrote** in the small box on the card (this feeds your end-of-day report), then press the button that matches what happened.
4. **Hit your daily targets** and tick your **team tasks**.
5. At the end of the day open **Reports → End-of-day update**, press Copy and submit it.

After 12:00 the Plan opens on the **next working day** so tomorrow's work is ready. Use the Today / Tomorrow switch to go back. Friday is the day off.

## 2. Reading a lead card
- **Name, title, company.** A green **PURSUE** badge means the plan marks this lead as a real opportunity. **A / B / C** is the tier.
- **The coloured label** is the action: red = they replied or just accepted (do first), orange = follow-up or email, blue = check, grey = research.
- **"Why · due"** says which rule put it here and how late it is.
- **Click the name** to open the full lead: history, notes, meetings, all fields.

## 3. The buttons (they update dates and status for you)
| Button | Use it when | What the CRM does |
|---|---|---|
| **Accepted** | They accepted your connection request | Saves the accept date; next step becomes "send the first message" |
| **Still pending** | Invite not accepted yet | Hides the lead for a few days, then asks again |
| **Email sent / First message sent / Follow-up sent / Last follow-up sent** | You sent it | Logs it with the text you typed, sets status "Unseen", schedules the next step |
| **They replied** | They answered | Status "Replied", the lead goes to the top of your list |
| **Seen, no reply** | They read it, no answer | Status "Seen, no reply" |
| **Commented** | You commented on their post | Logs the comment with your text |
| **Nurture** | Real value but not now | Moves to nurture, comes back after the nurture days |
| **Not a fit / Close** | No business path | Stops outreach on this lead |
| **Later** | Not today | Pushes it to tomorrow |

## 3a. What the response labels mean
- **Unseen**: you sent a message and have no sign they opened it.
- **Seen, no reply**: they read it and did not answer.
- **Replied**: they answered. Answer within the day.

## 4. Daily targets and next actions: how they work
- **Daily targets** (Targets page) are numbers per person per day: profile reviews, comments, likes, follows, connection requests, direct messages. They are **counted automatically** from what you log, so log every action.
- **Lead actions** are decided by the follow-up cadence (Playbook → Rules). For each lead the CRM looks at the invite date, accept date and first-message date and picks the step that is due.
- **Order of the list:** replies and PURSUE leads first, then what is due today, then late ones (least late first), then by step type and tier.
- **Daily limit:** you get a limited number of lead actions a day (set by the admin). The rest carry over to the next day.
- **Stale:** a step that is far too late (default 14 days) moves to the **Stale** tab, where the admin or you can close it or move it to nurture in bulk.

## 5. Adding leads
- **Leads → Add lead**, or **Import** for a spreadsheet. The CRM never creates a duplicate: if the email, LinkedIn link, or name + company already exists, the new information is added to the existing lead and you are told.
- Fill **Tier**, **Opportunity path**, **Assessment** and, for a lead that is not a fit, **Denial reason**. These show in your reports.

## 6. Meetings
Open a lead → **Meetings** → add date and time. The weekly meeting target and carryover are on the **Meetings** page.

## 7. Reports
**Reports** builds three documents from the log: the **Daily work plan** (for tomorrow), the **End-of-day update** (prospects touched with the exact comments and messages, research verdicts with reasons) and the **Weekly KPI** (target vs actual, pipeline, lead quality). Press **Copy**, **Download .md** or **Print / PDF**.

## 8. Playbook, rules and asking for changes
The **Playbook** page holds the marketing plan and the rule numbers. Everyone can read it. Only the admin edits it. If you think something should change, use **Ask the admin to change the plan** on that page.

## 9. For the admin
- **Playbook → Rules**: change the cadence days, the stale limit, and the daily limit for the team or for one person.
- **Playbook → Plan text**: edit the written plan.
- **Playbook → Requests**: approve or decline change requests from the team or the AI agent.
- **Targets → Set targets**: the daily numbers per person. **Tasks → Add task**: the standing task list.
- **Team**: add people, reset passwords. Change the default passwords (`admin123`, `welcome123`) before anyone uses a live server.
- **Import → Update existing**: fill blanks of leads already in the CRM from a sheet.

## 10. Safety
- Everything on LinkedIn is done by hand. The CRM only plans, tracks and reports; it does not send messages.
- Never share your password or API key. Keys are under **API key** (bottom left); delete a key if it leaks.
