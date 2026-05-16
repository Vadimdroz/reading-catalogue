# Reading Catalogue — Project Summary

**Created:** May 2026  
**Conversation with:** Claude (Anthropic)

---

## What Was Built

A personal reading catalogue web app that:
- Accepts any article URL and automatically fetches + saves the full text
- Catalogues articles with source, author, date, and estimated read time
- Stores articles for offline reading
- Supports manual entry for tweets/social posts (Post / Tweet tab)
- Allows marking articles as read/unread and favoriting
- Has search and filter functionality (All / Unread / Favorites / Read)

---

## Live URL

**https://my-reading-catalogue.pages.dev**

---

## Hosting & Infrastructure

| Service | Purpose | Cost |
|---|---|---|
| Cloudflare Pages | Hosting + serverless function | Free |
| GitHub | Code storage / auto-deploy trigger | Free |

**GitHub repo:** https://github.com/Vadimdroz/my-reading-catalogue

---

## File Structure (in GitHub repo)

```
/
├── index.html                        # Main app (all UI + JS)
├── sw.js                             # Service worker (offline caching)
├── manifest.json                     # PWA manifest (home screen install)
└── functions/
    └── fetch-article.js              # Serverless function (article fetching)
```

---

## How Article Fetching Works

When a URL is saved:
1. The app calls `/fetch-article` (Cloudflare Pages Function)
2. The function attempts a direct HTTP fetch with browser-like headers
3. If that fails or returns insufficient text, it falls back to **Jina Reader** (https://r.jina.ai) which renders JS-heavy pages
4. Extracted text, title, author, and date are returned to the browser
5. The article is saved to browser localStorage

---

## Known Limitations

### Cross-device sync
Articles are stored in **browser localStorage** — they do not sync between devices. Articles saved on desktop won't appear on phone and vice versa.

**Fix (not yet implemented):** Add a Supabase database backend. This was discussed and is the recommended next step.

### Sites that block fetching
Some sites block automated access entirely (e.g. paywalled content, ynet.co.il). These will return "Could not fetch this article." For these, use the **Post / Tweet** manual entry tab instead.

### Substack URLs
Use the public article URL format: `https://[newsletter].substack.com/p/[slug]`  
NOT the dashboard URL: `substack.com/home/post/p-XXXXXXX`

---

## How to Update the App

1. Edit the relevant file locally
2. Go to https://github.com/Vadimdroz/my-reading-catalogue
3. Upload the updated file (delete old → Add file → Upload)
4. Cloudflare auto-deploys within ~1 minute

---

## Deployment History & Key Issues Resolved

| Issue | Resolution |
|---|---|
| Netlify free tier exhausted (300 credits) | Migrated to Cloudflare Pages (unlimited free deploys) |
| Netlify functions not running on drag-and-drop | Connected Cloudflare Pages to GitHub repo |
| Files nested in subfolder causing 404 | Ensured all files at repo root, not inside a folder |
| Function not found by Cloudflare | Renamed path from `/functions/fetch-article` to `/fetch-article` |
| JS syntax errors from escaped characters | Rewrote affected functions avoiding Python escape issues |
| manifest.json corrupted (renamed with space) | Re-uploaded clean version |
| BBC article text truncated | Rewrote extractor to collect ALL `<article>` blocks, not just first |

---

## Recommended Next Steps

1. **Add Supabase sync** — enables cross-device article sync. Free tier is sufficient. Would require updating `index.html` and creating a Supabase project with one table.

2. **Improve article text formatting** — currently plain text; could render as styled HTML.

3. **Add tags/categories** — allow labelling articles by topic.

4. **Export to PDF/email** — share saved articles.

---

## PWA (Install as App)

The app can be installed as a home screen app:
- **iPhone:** Open in Safari → Share → Add to Home Screen
- **Android:** Open in Chrome → menu → Add to Home Screen
- **Desktop:** Click install icon in browser address bar

---

*Summary generated May 2026*
