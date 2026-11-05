# Deploy to Render

The CRM is one Node service plus one SQLite file, so it needs a **persistent disk** (Render "Starter" plan or higher, about $7/month).
Run a single instance only (SQLite is a single-writer file).

## 1. Put the code on GitHub
```
git init && git add . && git commit -m "skillBNK CRM"
git remote add origin <your private repo>   # keep the repo PRIVATE
git push -u origin main
```
`.gitignore` already keeps `data/` (your leads) and `*.db` out of git.

## 2. Create the service
Render dashboard → **New → Blueprint** → pick the repo. `render.yaml` sets everything up. When asked, enter:
- `ADMIN_EMAIL`: your real login email
- `ADMIN_PASSWORD`: a strong password
- `TEAM_PASSWORD`: the starting password for Tawhid, Ahana and Safiul (they change it after login)

The first start creates an empty CRM with those accounts. Open the `.onrender.com` link and sign in.

## 3. Move your existing data (7,000+ leads, history, meetings)
On your Mac, in the project folder:
```
node scripts/export-db.js        # writes data/export/import.db, a clean copy
```
Then upload it to the server's disk. In Render: service → **Connect → SSH** (add your SSH key under Account Settings first), then from your Mac:
```
scp -s data/export/import.db <ssh-address-from-render>:/var/data/import.db
```
Finally **Manual Deploy → Restart** the service. On start the CRM swaps `import.db` in (the empty one is kept as `crm.db.before-import`).
After that, sign in with the ADMIN_EMAIL from your old database (the accounts come with the data, so the env passwords no longer apply).
Change any password that is still `admin123` or `welcome123` (top left → Password, or Team page).

## 4. Backups
- The app writes a daily snapshot to `/var/data/backups` (newest 14 kept).
- Render also snapshots the disk daily. Download an extra copy now and then: `scp` the newest file in `/var/data/backups`.

## 5. Updating
Push to GitHub; Render redeploys. A redeploy restarts the service (about a minute of downtime), the disk and data stay.

## Notes
- Custom domain and HTTPS are free on Render (Settings → Custom Domains).
- The free plan has no persistent disk: do not use it, the database would reset.
- To raise limits later or move to Postgres, the SQL lives in `server/`; ask before changing it.
