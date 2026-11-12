# Baxnaano Online Booking — setup guide

Your own system, built from zero:

| File | What it is |
|---|---|
| `index.html` | Patient booking page (Kaafi-style) |
| `admin.html` | Staff page: bookings, mark paid, doctors, settings |
| `config.js` | Your Supabase address + public key (the ONLY file you edit) |
| `api.js` | Talks to Supabase (or runs DEMO mode if config.js is empty) |
| `supabase/schema.sql` | Creates the whole database (run once) |
| `supabase/functions/odoo-sync/index.ts` | Sends bookings into Odoo 13 |
| `photos/` | Doctor photos |

**How it works:** patient books → gets queue number, time and a reference number (BX-XXXXXX) → pays by USSD → reception sees it in `admin.html` and taps **✅ Bixiyay** (paid) → the booking appears automatically in Odoo **Registration** as a Draft OPD appointment.

---

## Step 1 — Supabase database (10 min)
1. supabase.com → your **Baxnaano Hospital** organization → project **baxnaano-booking**.
2. **SQL Editor → New query** → paste all of `supabase/schema.sql`.
3. At the very bottom, change `YOUR-EMAIL@example.com` to your email → **Run**.
4. **Authentication → Users → Add user → Create new user**: same email + a strong password, tick **Auto Confirm User**. This is your admin login.
5. **Project Settings → API**: copy **Project URL** and the **anon / publishable** key.
   ⚠️ Never use or share the `service_role` key.

## Step 2 — Website on your GitHub (5 min)
1. github.com → **New repository** → `baxnaano-booking` → Public → Create.
2. Edit `config.js`: paste the Project URL and anon key.
3. **Add file → Upload files** → drag in ALL files and folders → **Commit changes**.
4. **Settings → Pages** → Source: **Deploy from a branch** → `main` / `(root)` → Save.
5. After ~1 minute your site is live at `https://YOUR-USERNAME.github.io/baxnaano-booking/`
   and admin at `…/baxnaano-booking/admin.html`.

## Step 3 — Odoo link (10 min)
1. Supabase → **Edge Functions → Deploy a new function → Via Editor** → name it `odoo-sync` → paste `supabase/functions/odoo-sync/index.ts` → **Deploy**.
2. Open the function → **Details** → turn **OFF** "Enforce JWT verification" (the function checks access itself) → Save.
3. **Edge Functions → Secrets** → add:
   - `ODOO_URL` = `https://baxnaano.softprimeconsulting.com`
   - `ODOO_DB` = `baxnaano_hms_live`
   - `ODOO_USER` = login of the "Online Booking" Odoo user (not admin)
   - `ODOO_PASSWORD` = that user's password
   - `WEBHOOK_SECRET` = a long random word you invent
   - `PUSH_WHEN` = `paid`
4. **SQL Editor** → run (put in your function URL and the same secret word):
   ```sql
   insert into private.config values
     ('odoo_sync_url',    'https://YOUR-PROJECT.supabase.co/functions/v1/odoo-sync'),
     ('odoo_sync_secret', 'THE-SAME-SECRET-WORD')
   on conflict (key) do update set value = excluded.value;
   ```

## Step 4 — Test
1. On your phone open the site → book any doctor.
2. Open `admin.html` → log in → tap **✅ Bixiyay** on that booking.
3. After a few seconds the **Odoo** column shows **✓ Odoo** → check Odoo **Registration**.
4. If it shows **⚠ Khalad**, hover/tap it to see the reason, fix, then tap **↻**.

## Doctors and Odoo IDs
Each doctor in admin → **Dhakhaatiirta** has an **Odoo Doctor ID**. Starting values (from your Odoo):
Dr. Harith = 22, Dr. Yahye Shoole = 23, Dr. Sadio Omar = 46, Dr. Hersi = 49.
A new doctor needs their Odoo ID, otherwise their bookings can't go to Odoo.

## Later: baxnaano.com
To point baxnaano.com at this new site: add a file `CNAME` containing `baxnaano.com`, and change the domain's DNS to GitHub Pages. Whoever controls the domain must do the DNS part.
