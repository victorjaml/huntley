# Setting up the tracker sheet

This is the one part of huntley you wire up by hand. It takes about ten minutes and costs nothing.

## What you are building, and why it looks like this

An email can only ever issue a `GET`. So the **Add** button in each digest row has to be a link. The question that follows is: a link to *what*?

The obvious answer — a small web server — means opening a port through your router, getting a certificate, keeping a daemon alive, and having a service on the public internet whose whole job is to write to your job tracker. That is a lot of exposure for one button.

Instead, the link points at a **Google Apps Script web app bound to your tracker spreadsheet**. It is already authenticated to your sheet, so there is no service-account key sitting on your disk. Nothing listens on your home network. And huntley never has to reach *in* — it reads the sheet back on its next run, so the whole flow is pull-only.

```
     digest email                    Apps Script                  your sheet
  ┌────────────────┐              ┌──────────────┐            ┌──────────────┐
  │ [Add]  ────────┼── signed ───►│ verify HMAC  │── append ─►│ Applications │
  │                │     GET      │ check expiry │            │ Inbox        │
  └────────────────┘              └──────────────┘            │ Approvals    │
                                                              └───────┬──────┘
       huntley (server) ◄──────────── reads CSV ────────────────────┘
```

Every link carries `(action, id, expiry)` and an HMAC-SHA256 signature over exactly those three, keyed by a secret only huntley and the script know. A link cannot be forged, an `add` signature cannot be replayed as an `approve`, and a forwarded email stops working when the link expires.

---

## 1. Create the spreadsheet

Make a new Google Sheet. Call it anything; `huntley tracker` is fine.

From the URL, note the spreadsheet id — the long string between `/d/` and `/edit`:

```
https://docs.google.com/spreadsheets/d/1AbC...XyZ/edit
                                       ^^^^^^^^^^
```

## 2. Add the script

In that sheet: **Extensions › Apps Script**. Delete the placeholder `myFunction` and paste the entire contents of [`apps-script/Code.gs`](../apps-script/Code.gs).

Save (the disk icon, or ⌘S).

## 3. Give the script the signing secret

`huntley setup` already generated one into your `.env`. Read it back:

```bash
grep HUNTLEY_LINK_SECRET .env
```

In the Apps Script editor: **Project Settings** (the gear, left sidebar) › **Script Properties** › **Add script property**.

| Property | Value |
|---|---|
| `HUNTLEY_LINK_SECRET` | the exact value from your `.env` |

This must match byte for byte. If it does not, every Add button returns "signature is not valid" — which is the system working correctly, just frustratingly.

## 4. Create the tabs

Back in the editor, choose the `setUpTabs` function from the dropdown at the top and press **Run**. Google will ask you to authorize the script the first time — it is your own script, editing your own sheet.

You will see a warning that the app is not verified. That is expected for a personal script you just wrote. **Advanced › Go to huntley (unsafe)**.

You should now have three tabs:

| Tab | What lands there | Who writes it |
|---|---|---|
| **Applications** | your tracker: one row per role you intend to apply to | Apps Script on Add; you, afterwards |
| **Inbox** | the raw click log — every Add and Ignore | Apps Script |
| **Approvals** | weekly proposals you approved | Apps Script |

`Applications` is yours to live in. Edit `status`, `applied_at`, `outcome` and `notes` freely — the weekly review reads them, and huntley never overwrites a row you have touched.

`Inbox` and `Approvals` are machine logs. Leave them alone.

## 5. Deploy it as a web app

**Deploy › New deployment**. Click the gear next to "Select type" and choose **Web app**.

| Field | Value | Why |
|---|---|---|
| Description | `huntley` | anything |
| Execute as | **Me** | so the script can write to your sheet |
| Who has access | **Anyone** | required — clicking from your phone's mail app is not an authenticated session |

> **"Anyone" sounds alarming.** It means anyone who has the URL can invoke the script — but the script refuses every request without a valid HMAC signature, and the deployment URL itself is a long random string that is never published. The signature, not the URL's secrecy, is what protects you.

**Deploy**, then copy the **Web app URL**. It looks like:

```
https://script.google.com/macros/s/AKfycb.../exec
```

## 6. Tell huntley about it

In `config/huntley.yml`:

```yaml
sheet:
  enabled: true
  webapp_url: "https://script.google.com/macros/s/AKfycb.../exec"
  spreadsheet_id: "1AbC...XyZ"
```

Check it:

```bash
huntley doctor
```

You want `✓ Add links   endpoint and signing key are configured`.

## 7. Let huntley read the sheet back

Adding a role is only half of it. The weekly review needs to know *which* roles you added, so huntley has to read the sheet too.

**File › Share › Publish to web.** Under the first dropdown pick the **Inbox** tab, under the second pick **Comma-separated values (.csv)**, then **Publish**.

Copy the URL you get and put it in `.env`:

```bash
HUNTLEY_SHEET_CSV_URL=https://docs.google.com/spreadsheets/d/e/2PACX-.../pub?gid=0&single=true&output=csv
```

Repeat for the **Applications** and **Approvals** tabs, note each tab's `gid` from its URL, and list them in `config/huntley.yml`. Without a gid a tab is not read at all — an Approvals tab with no gid means APPROVE clicks never reach huntley, and `huntley doctor` will say so:

```yaml
sheet:
  gids:
    inbox: 0
    applications: 123456789
    approvals: 987654321
```

> A published tab is readable by anyone who has that long URL. If you would rather not publish the Applications tab at all, publish only **Inbox** and **Approvals** — Add-tracking and the APPROVE gate both keep working; the weekly review just loses the outcome data you record by hand.

Verify:

```bash
huntley sync
```

## 8. Try it

```bash
huntley run --dry-run
open data/digests/*-dryrun.html
```

Click an Add button. You should get a confirmation page, and a new row in **Applications** with status **To apply**.

Note that status. huntley writes `To apply`, never `Applied` — Add means "I want to apply to this", not "I applied". You mark it applied yourself, after you actually do.

---

## When you change the script

Apps Script does not redeploy on save. After editing `Code.gs`:

**Deploy › Manage deployments › ✏️ (edit) › Version: New version › Deploy.**

Creating a *new deployment* instead gives you a new URL and silently breaks every Add link in every digest you have already been sent. Always edit the existing one.

## Troubleshooting

| Symptom | Cause |
|---|---|
| "This link's signature is not valid" | `HUNTLEY_LINK_SECRET` differs between `.env` and Script Properties |
| "This link has expired" | links last 30 days by default; run `huntley run` for fresh ones |
| Clicking Add shows a Google sign-in page | the deployment's access is not set to "Anyone" |
| Add works, but the weekly review sees nothing | `HUNTLEY_SHEET_CSV_URL` is unset, or the Inbox tab is not published |
| `huntley sync` says "returned a sign-in page" | the URL is the normal sheet URL, not the published-CSV one |
| Rows appear in Inbox but not Applications | that job id is already on the tracker — Add is idempotent |
