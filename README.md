# Spelgram 3000 🔮

A gamified spelling & grammar adventure for Australian students in **Years 5–7**,
aligned to the Australian Curriculum and NAPLAN Language Conventions.

**Version 3.1** — now with **family accounts**, so one public install can serve
many families, each fully separate.

<p align="center">
  <img src="docs/screenshot-signin.png" width="49%" alt="The family sign-in screen">
  <img src="docs/screenshot-home.png" width="49%" alt="A child's home screen with the 12-level map">
</p>

## What's inside

- **Family accounts**: parents create a free account (family name + email +
  password), confirm it with a 6-digit code emailed to them, and stay signed
  in for 30 days per device. Every family's players, progress, parent code and
  Word Lab live in their own isolated folder on the server — no family can
  ever see another family's kids or stats. Password reset works by emailed
  6-digit code too, and the parent zone can change the password or sign out
  every other device. Kids **never** need an email or password: once the
  family is signed in, they just tap their name.

- **12 levels** ramping from Year 3 foundations (gentle catch-up) through Year 5/6
  to Year 7 mastery — so the app grows with each child through primary into
  high school.
- **Family profiles**: a "Who's playing?" screen; every child's XP, stars,
  streaks and badges are saved on your hosting and follow them to any device
  the family signs in on.
- **960 core questions** (720 spelling + 240 grammar), every one academically
  verified, plus a **reservoir of 400 bonus items** unlocked through play —
  1,360 in total, with every target word unique across the whole game.
- **🧪 The Word Lab**: kids press one button to "brew" a fresh batch of
  never-seen questions with a fun progress bar. Where the new content comes
  from:
  - With an **Anthropic API key** configured in the parent zone, the Word Lab
    asks Claude to write brand-new curriculum-aligned questions on the spot
    (each is machine-checked before it enters the game — answers verified,
    duplicates rejected).
  - Without a key, it unlocks random batches from the built-in reservoir.
  - Either way the game reshuffles: the engine always serves least-seen items,
    so new content appears in sessions immediately. Kids can refresh once
    every 6 hours; parents can force it anytime.
- **👪 Parent zone**, protected by a 6–8 digit **parent code** (not a
  password — quick to type, hashed on the server; after 5 wrong tries it
  locks for 5 minutes, then 10, 20, 40, up to an hour). Codes set before the
  6-digit minimum keep working until changed. Changing the code needs the
  current one; a forgotten code can be reset with the family password. The
  code is asked for **every time** you open the zone: the session lives in
  memory only, so leaving it, reloading, or closing the tab all end it — a
  child can never inherit an open parent session:
  - Per-child dashboard: accuracy, XP, stars, streak, **words to practise**
    (exactly which words they get wrong, how often, at what level) and
    **grammar topics to revisit** — with a **Print** button for a paper
    practice list.
  - Manage players: rename, reset progress, delete (deliberately impossible
    from the kids' screens).
  - Configure the Word Lab "magic key" and change the parent code.
- Everything from earlier versions: Australian voice for listen-and-type,
  NAPLAN-style proofreading questions, hints and rule teaching on every
  question, XP/ranks/badges/confetti, offline resilience.

## Deploying to GoDaddy (Deluxe hosting)

Needs PHP 8 (already on GoDaddy Deluxe). No database — everything lives in a
private data folder the app creates itself (`server-data/` next to `api.php`
unless you move it, see step 4).

1. GoDaddy → **My Products → Web Hosting → Manage** → **cPanel** → **File Manager**.
2. Go to `public_html` (or a subfolder like `public_html/spelgram`).
3. Upload **only** these, keeping the structure (not `tests/`, `docs/`,
   `README.md` or `.git`):
   ```
   index.html
   api.php
   favicon.svg
   css/  js/  data/
   ```
   Files should be `644` and folders `755` (the File Manager defaults). The
   data folder is created `700` with `600` files, so only PHP can read it.
4. **Move the data folder above `public_html`** (recommended). Create a folder
   the web server cannot serve, e.g. `/home/<cpanel-user>/spelgram-data`, then
   create `spelgram-local.php` next to `api.php` containing:
   ```php
   <?php
   return ['data_dir' => '/home/<cpanel-user>/spelgram-data'];
   ```
   `spelgram-local.php` is gitignored and never part of an upload; it only
   says where the data lives. Without it the app keeps using `server-data/`
   beside `api.php`, protected by a `.htaccess` the app writes (and refuses to
   run without). Moving an existing install: copy the whole `server-data/`
   contents into the new folder first, then add `spelgram-local.php`.
5. Visit the URL and create your own family account — you're the first user,
   nothing special to configure. Sign-up emails a 6-digit confirmation code,
   so set up mail (next section) before inviting anyone. First visit to the
   **Parent zone** asks you to create your family's parent code.
6. Optional: in the parent zone, paste an Anthropic API key (create one at
   console.anthropic.com) to turn on AI-generated refreshes **for your own
   family**. The default model is `claude-opus-5` (highest quality); a refresh
   costs roughly US$0.30–0.60. The key is stored server-side only, never shown
   again, and only ever used for the family that configured it — other
   families' Word Labs draw from the free built-in vault unless they add a
   key of their own. Each family gets at most 12 AI generations per day.

Health check: `yoursite.com/spelgram/api.php?action=ping` → `{"ok":true,...}`.
Everything else is POST only.

### Sharing it publicly

The link is now safe to put on your website: every visitor family registers
their own account and gets a private slice of the server. What keeps the
shared host healthy:

- Sign-ups need email confirmation; unconfirmed sign-ups are dropped after
  24 hours. Registering an address that already has an account emails its
  owner a heads-up instead of telling the visitor — sign-up, sign-in and
  reset answer the same way whether or not an email is known.
- Sign-ups are capped at **2,000 families** (`MAX_ACCOUNTS` in `api.php`),
  each with up to 20 players and a 256 KB cap per save file.
- Auth endpoints are rate-limited per IP (5 sign-ups and 30 failed logins an
  hour). After 8 wrong passwords for one account from one address, that
  address is slowed down for 10 minutes while other devices sign in as
  normal. Reset and confirmation codes expire after 15 minutes, allow 5
  tries, and are re-sent at most once every 2 minutes.
- Passwords are 8 to 72 characters and a short list of the most common
  passwords is refused. Session tokens are stored hashed and expire after
  30 days without use.
- Requests over 512 KB are refused before they are read.

**Confirmation and reset emails go out via [Brevo](https://www.brevo.com)**
(free tier is plenty). Create `mail.json` in the data folder on the server:

```json
{
  "brevo_key": "xkeysib-your-api-key",
  "from_email": "no-reply@your-domain",
  "from_name": "Spelgram 3000"
}
```

- `brevo_key`: Brevo → profile menu → **SMTP & API → API Keys** → *Generate
  a new API key*.
- `from_email` must be an address on a domain authenticated in Brevo
  (**Senders, Domains & Dedicated IPs**, with the SPF/DKIM records added) —
  that is what lets the mail land in inboxes rather than spam.

Without `mail.json` (or if Brevo rejects a send — the PHP error log shows
`spelgram send_mail: brevo status=...`, status only, never the body), the app
falls back to PHP `mail()`. The fallback sender is `from_email` if set,
otherwise the fixed `DEFAULT_FROM` in `api.php` (`no-reply@company31.com`,
a domain whose SPF record authorises the GoDaddy server); the request's Host
header is never used as a sender. Change `DEFAULT_FROM` if you host this on
your own domain. If no mail works at all, nobody can confirm a new account or
reset a password (nothing else breaks) — you can delete an entry from
`accounts.json` in the data folder so they can re-register, though their
kids' progress folder would then be orphaned.

### Good to know

- **Backups**: download the data folder occasionally — it holds every
  family's accounts, player progress, parent code hashes, and unlocked bonus
  words. **It also holds secrets**: your Brevo key in `mail.json` and every
  family's Anthropic key in its `config.json`. Keep backups somewhere private
  (not in a shared drive or a git repository) and delete old copies.
- **Privacy**: kids are first names + avatar only — no email, no password, no
  tracking. Parents' emails are used solely for sign-in and password reset.
  Each family's parent code gates its own management screens, not play.
- **Deleting/renaming players** lives in the parent zone.
- **Word Lab cost control**: without an API key there is zero cost, forever —
  for you and for every family that signs up. A family that adds its own key
  gets at most 12 AI generations a day (kids: a 6-hour cooldown, each of the
  4 brew steps runs once per brew; parents can brew anytime within that cap).
  If the key stops working the parent zone says so. Remove a key anytime with
  the Clear button.
- **Upgrading from v3.0** (single-family): the server layout changed from one
  shared data folder to per-account folders. Register your account first, then
  move your old `server-data/profiles.json`, `save_*.json`, `config.json` and
  `extra-bank.json` into your new `server-data/accounts/<id>/` folder.

## Local preview

```
php -S 127.0.0.1:8642
```

Then http://localhost:8642 (PHP's built-in server runs the app and the API).

Smoke test (starts its own server on port 8741 against a throwaway data
folder, never touches your working copy, exits 0 when every check passes):

```
php tests/smoke.php
```

## Content layout

- `data/spelling-*.js`, `data/grammar-*.js` — core banks, tagged by level 1–12.
- `data/reservoir-*.json` — locked bonus items the Word Lab unlocks over time.
- `server-data/accounts/<id>/extra-bank.json` — items a family has unlocked or
  AI-generated so far.

Add your own items to any bank following the existing shape — the engine picks
them up automatically.

## License

© 2026 Manuel Re / C31 Labs. Licensed under
[CC BY-NC-ND 4.0](https://creativecommons.org/licenses/by-nc-nd/4.0/):
free to use and share as-is with credit, **no modifications, no commercial
use**. See [LICENSE](LICENSE).
