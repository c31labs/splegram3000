# Spelgram 3000 🔮

A gamified spelling & grammar adventure for Australian students in **Years 5–7**,
aligned to the Australian Curriculum and NAPLAN Language Conventions.

**Version 3.0** — Years 5–7, the Word Lab, and a parent zone.

## What's inside

- **12 levels** ramping from Year 3 foundations (gentle catch-up) through Year 5/6
  to Year 7 mastery — so the app grows with each child through primary into
  high school.
- **Family profiles**: a "Who's playing?" screen; every child's XP, stars,
  streaks and badges are saved on your hosting and follow them to any device.
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
- **👪 Parent zone**, protected by a 4–8 digit **parent code** (not a
  password — quick to type, hashed on the server, locked for 5 minutes after
  5 wrong tries). The code is asked for **every time** you open the zone: the
  session lives in memory only, so leaving it, reloading, or closing the tab
  all end it — a child can never inherit an open parent session:
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

Needs PHP (already on GoDaddy Deluxe). No database — everything lives in a
protected `server-data/` folder the app creates itself.

1. GoDaddy → **My Products → Web Hosting → Manage** → **cPanel** → **File Manager**.
2. Go to `public_html` (or a subfolder like `public_html/spelgram`).
3. Upload the whole project, keeping the structure:
   ```
   index.html
   api.php
   css/  js/  data/
   ```
4. Visit the URL. First visit to the **Parent zone** asks you to create your
   parent code.
5. Optional: in the parent zone, paste an Anthropic API key (create one at
   console.anthropic.com) to turn on AI-generated refreshes. The default
   model is `claude-opus-5` (highest quality); a refresh costs roughly
   US$0.30–0.60. The key is stored server-side only and never shown again.

Health check: `yoursite.com/spelgram/api.php?action=ping` → `{"ok":true,...}`.

### Good to know

- **Backups**: download the `server-data/` folder occasionally — it holds all
  player progress, the parent code hash, and unlocked bonus words.
- **Privacy**: first names only, no emails, no passwords for kids. Don't share
  the link publicly. The parent code gates management and settings, not play.
- **Deleting/renaming players** now lives in the parent zone.
- **Word Lab cost control**: without an API key there is zero cost, forever.
  With a key, kids can trigger at most 4 refreshes a day (6-hour cooldown).
  Remove the key anytime with the Clear button.

## Local preview

```
php -S 127.0.0.1:8642
```

Then http://localhost:8642 (PHP's built-in server runs the app and the API).

## Content layout

- `data/spelling-*.js`, `data/grammar-*.js` — core banks, tagged by level 1–12.
- `data/reservoir-*.json` — locked bonus items the Word Lab unlocks over time.
- `server-data/extra-bank.json` — items unlocked or AI-generated so far.

Add your own items to any bank following the existing shape — the engine picks
them up automatically.

## License

© 2026 Manuel Re / C31 Labs. Licensed under
[CC BY-NC-ND 4.0](https://creativecommons.org/licenses/by-nc-nd/4.0/):
free to use and share as-is with credit, **no modifications, no commercial
use**. See [LICENSE](LICENSE).
