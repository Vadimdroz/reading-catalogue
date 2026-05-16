# Reading Catalogue — Claude Context

## What the Project Is

A personal reading catalogue web app (PWA) that lets you save, store, and read articles offline. You paste an article URL and it automatically fetches and stores the full text in your browser. There's also a manual entry mode for tweets/social posts that can't be fetched automatically.

**Live URL:** https://my-reading-catalogue.pages.dev

---

## What's Working

- **URL article saving** — paste any article URL; the serverless function fetches and extracts the full text
- **Two-strategy article fetching:**
  1. Direct fetch with browser-like headers (fast, works for most open sites)
  2. Fallback to Jina Reader proxy (`https://r.jina.ai/`) for JS-heavy or hard-to-scrape pages
- **Manual Post / Tweet entry** — paste text directly with author, source, title, and optional link
- **Offline reading** — full article text stored in localStorage; service worker caches the app shell
- **Read/unread toggle** — cards dim when marked read
- **Favorites** — star articles to filter later
- **Search** — searches title, source, author, and excerpt
- **Filters** — All / Unread / Favorites / Read pill tabs
- **Stats bar** — live counts of Saved / Unread / Favorites
- **Dark mode** — automatic via `prefers-color-scheme`
- **PWA installable** — manifest + service worker; can be added to home screen (iOS/Android/desktop)
- **Offline banner** — shows when network is lost

---

## Key Decisions Made

- **Cloudflare Pages** chosen after Netlify free tier ran out (300 credits exhausted). Cloudflare has unlimited free deploys.
- **GitHub-connected deployment** — Cloudflare Pages auto-deploys on every push to the deploy repo (`my-reading-catalogue`), so drag-and-drop uploads are no longer needed.
- **Two GitHub repos:**
  - `https://github.com/Vadimdroz/my-reading-catalogue` — public, connected to Cloudflare, what gets deployed
  - `https://github.com/Vadimdroz/reading-catalogue` — private, this local repo, used as the working/backup copy
- **localStorage for storage** (`key: rc_articles_v2`) — simple, no backend needed, but means no cross-device sync
- **Jina Reader** (`https://r.jina.ai/`) used as a no-auth fallback for JS-heavy pages — no API key required
- **Text capped at 20,000 characters** per article to keep localStorage usage manageable
- **Article HTML extraction order:** `<article>` blocks → named class/id divs → all `<p>` tags → full body text

---

## What's In Progress / Next Steps

1. **Supabase sync** *(recommended next step)* — add a free Supabase backend to enable cross-device article sync. Would require:
   - Creating a Supabase project with one `articles` table
   - Updating `index.html` to read/write via Supabase JS SDK instead of (or alongside) localStorage

2. **Better article formatting** — currently stored and displayed as plain text (`white-space: pre-wrap`). Could render as styled HTML instead.

3. **Tags / categories** — allow labelling articles by topic for better organisation.

4. **Export** — share or export saved articles to PDF or email.

5. **Minor bug: stale Netlify reference in `sw.js`** — the service worker has `if (e.request.url.includes('/.netlify/')) return;` which is a leftover from the Netlify era. Should be updated to reference Cloudflare's `/fetch-article` path or simply removed.

---

## File Structure

### Local repo (`/Users/vadim.drozdovski/Claude/Projects/Reading Catalouge/`)

```
CLAUDE.md                          # This file
Reading Catalogue - Project Summary.md  # Human-readable project summary
.gitignore                         # Ignores .DS_Store, *.zip, *.log

# Canonical current versions (most recent iteration):
index (2).html                     # Latest index.html — the current app UI + JS
fresh-deploy (1)/
  index.html                       # Same as index (2).html (deployed version)
  fetch-article.js                 # Latest serverless function
  manifest.json                    # PWA manifest
  sw.js                            # Service worker

# Older iterations (kept for reference):
index.html                         # Original
index (1).html                     # Second iteration
fetch-article.js                   # Original serverless function
fetch-article (1).js               # Second iteration
fetch-article (2).js               # Third iteration
fresh-deploy/                      # Earlier deploy bundle
reading-catalogue /                # Even earlier, Netlify-era bundle
```

### Deployed structure (what Cloudflare Pages serves from `my-reading-catalogue` repo)

```
/
├── index.html                     # Main app — all UI + JavaScript
├── sw.js                          # Service worker (offline app shell caching)
├── manifest.json                  # PWA manifest (install as home screen app)
└── functions/
    └── fetch-article.js           # Cloudflare Pages Function (serverless, POST /fetch-article)
```

---

## APIs, Keys, and Dependencies

| Name | Purpose | Auth / Cost |
|---|---|---|
| **Cloudflare Pages** | Hosting + serverless functions | Free, no key needed in code |
| **Jina Reader** (`https://r.jina.ai/`) | Fallback article text extraction | No API key — free tier, no auth |
| **GitHub** (`Vadimdroz`) | Code storage + auto-deploy trigger | `~/bin/gh` authenticated as `Vadimdroz` |

**No npm packages, no build step, no bundler.** Everything is plain HTML/CSS/JS — the app is a single `index.html` file plus the serverless function.

**No API keys stored in code.** Jina Reader's free tier requires no key.

---

## How to Update the App

### Working locally
1. Edit `index (2).html` (the current canonical local file) or the files in `fresh-deploy (1)/`
2. Commit and push to the private backup repo:
   ```bash
   cd "/Users/vadim.drozdovski/Claude/Projects/Reading Catalouge"
   git add -p
   git commit -m "description of change"
   git push
   ```
3. Also push the changed files to the **deploy repo** (`my-reading-catalogue`) to trigger Cloudflare auto-deploy

### Deploying to Cloudflare (via GitHub)
1. Go to https://github.com/Vadimdroz/my-reading-catalogue
2. Upload the updated file (delete old → Add file → Upload files)
3. Cloudflare auto-deploys within ~1 minute
4. Verify at https://my-reading-catalogue.pages.dev

---

## Known Limitations

- **No cross-device sync** — localStorage is browser-local; articles saved on desktop won't appear on mobile
- **Some sites block fetching** — paywalled or heavily protected sites (e.g. ynet.co.il) return "Could not fetch." Use the Post / Tweet manual tab for these
- **Substack URLs** — use the public article URL (`https://[newsletter].substack.com/p/[slug]`), not the dashboard URL
- **localStorage cap** — most browsers allow ~5–10 MB. Heavy use (many long articles) may eventually hit limits

---

## PWA Install

- **iPhone:** Safari → Share → Add to Home Screen
- **Android:** Chrome → menu → Add to Home Screen
- **Desktop:** Click the install icon in the browser address bar
