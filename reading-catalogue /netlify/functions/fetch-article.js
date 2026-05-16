const https = require('https');
const http = require('http');
const { URL } = require('url');

function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function htmlToText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<h[1-6][^>]*>/gi, '\n\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/blockquote>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/[ \t]{3,}/g, ' ')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function extractFromHtml(html) {
  // Title — try multiple meta sources
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']{1,200})["']/i);
  const twTitle = html.match(/<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']{1,200})["']/i);
  const htmlTitle = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
  const title = decodeHtmlEntities(
    (ogTitle && ogTitle[1]) || (twTitle && twTitle[1]) || (htmlTitle && htmlTitle[1]) || 'Untitled'
  ).trim();

  // Author
  const authorMatch = html.match(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']{1,100})["']/i)
    || html.match(/<meta[^>]+property=["']article:author["'][^>]+content=["']([^"']{1,100})["']/i);
  const author = authorMatch ? decodeHtmlEntities(authorMatch[1]).trim() : '';

  // Date
  const dateMatch = html.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<time[^>]+datetime=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+name=["']date["'][^>]+content=["']([^"']+)["']/i);
  const date = dateMatch ? dateMatch[1].trim() : '';

  // Strip noise elements completely
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<figure[\s\S]*?<\/figure>/gi, '')
    .replace(/<form[\s\S]*?<\/form>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Strategy A: collect ALL <article> blocks and concatenate
  // (handles BBC, Guardian etc which split content across multiple article tags)
  const articleMatches = [...body.matchAll(/<article[^>]*>([\s\S]*?)<\/article>/gi)];
  if (articleMatches.length > 0) {
    const combined = articleMatches.map(m => m[1]).join('\n\n');
    const text = cleanText(htmlToText(combined));
    if (text.length > 300) {
      const excerpt = text.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').slice(0, 220).trim() + '…';
      return { title, author, date, text, excerpt };
    }
  }

  // Strategy B: find the single largest named content block
  const namedBlockPattern = /<div[^>]+(?:class|id)=["'][^"']*(?:article-body|article-content|articleBody|post-content|post-body|entry-content|story-body|story-content|main-content|page-content|content-body|article-text|article__body|article__content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
  const namedBlocks = [...body.matchAll(namedBlockPattern)];
  if (namedBlocks.length > 0) {
    const combined = namedBlocks.map(m => m[1]).join('\n\n');
    const text = cleanText(htmlToText(combined));
    if (text.length > 300) {
      const excerpt = text.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').slice(0, 220).trim() + '…';
      return { title, author, date, text, excerpt };
    }
  }

  // Strategy C: use <main> tag
  const mainMatch = body.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (mainMatch) {
    const text = cleanText(htmlToText(mainMatch[1]));
    if (text.length > 300) {
      const excerpt = text.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').slice(0, 220).trim() + '…';
      return { title, author, date, text, excerpt };
    }
  }

  // Strategy D: extract all <p> tags from entire body — works for most sites
  const paragraphs = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(m => decodeHtmlEntities(m[1].replace(/<[^>]+>/g, '').trim()))
    .filter(p => p.length > 40);
  if (paragraphs.length > 0) {
    const text = paragraphs.join('\n\n').trim();
    const excerpt = text.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').slice(0, 220).trim() + '…';
    return { title, author, date, text, excerpt };
  }

  // Strategy E: fallback — strip everything and return raw body text
  const text = cleanText(htmlToText(body));
  const excerpt = text.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').slice(0, 220).trim() + '…';
  return { title, author, date, text, excerpt };
}


function cleanText(text) {
  return decodeHtmlEntities(text)
    .split('\n')
    .filter(line => line.trim().length === 0 || line.trim().length > 25)
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
    .slice(0, 20000);
}

function fetchUrl(urlStr, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 6) return reject(new Error('Too many redirects'));
    let parsed;
    try { parsed = new URL(urlStr); } catch { return reject(new Error('Invalid URL')); }

    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      method: 'GET',
      headers: {
        // Realistic browser user-agent — many sites block non-browser agents
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'he,en-US;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache',
        'Upgrade-Insecure-Requests': '1',
      },
      timeout: 15000
    };

    const req = lib.request(options, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const loc = res.headers.location;
        const next = loc.startsWith('http') ? loc : `${parsed.protocol}//${parsed.hostname}${loc}`;
        res.resume();
        return resolve(fetchUrl(next, redirectCount + 1));
      }
      if (res.statusCode === 403) return reject(new Error('Site blocked access (403)'));
      if (res.statusCode === 429) return reject(new Error('Rate limited by site (429)'));
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        // Detect encoding from content-type header or meta tag
        const ct = res.headers['content-type'] || '';
        const isUtf8 = ct.includes('utf-8') || ct.includes('utf8');
        const html = buf.toString(isUtf8 ? 'utf8' : 'latin1');
        // Check for charset in meta tag
        const charsetMatch = html.match(/<meta[^>]+charset=["']?([^"'\s;>]+)/i);
        const charset = charsetMatch ? charsetMatch[1].toLowerCase() : 'utf-8';
        if (charset.includes('utf') || isUtf8) {
          resolve(buf.toString('utf8'));
        } else if (charset.includes('1255') || charset.includes('windows-1255')) {
          // Windows-1255 is common on Israeli Hebrew sites
          resolve(buf.toString('latin1'));
        } else {
          resolve(buf.toString('utf8'));
        }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
    req.end();
  });
}



// Jina Reader proxy — renders JS-heavy pages and returns clean markdown
async function fetchViaJina(url) {
  const jinaUrl = `https://r.jina.ai/${url}`;
  return new Promise((resolve, reject) => {
    const parsed = new URL(jinaUrl);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/plain, */*',
        'X-No-Cache': 'true',
        'X-Timeout': '25',
      },
      timeout: 30000
    };
    const req = https.request(options, res => {
      if (res.statusCode !== 200) return reject(new Error(`Jina HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Jina timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// Parse Jina's markdown response — it uses a structured header block
function parseJinaResponse(raw) {
  const lines = raw.split('\n');
  let title = '', date = '', author = '', bodyStart = 0;

  // Jina prepends a header block like:
  // Title: Article Title
  // URL Source: https://...
  // Published Time: 2026-03-23
  // Markdown Content:
  // <article body...>
  for (let i = 0; i < Math.min(lines.length, 25); i++) {
    const l = lines[i];
    if (l.startsWith('Title:'))          title  = l.replace('Title:', '').trim();
    else if (l.startsWith('Published Time:')) date = l.replace('Published Time:', '').trim();
    else if (l.startsWith('Author:'))    author = l.replace('Author:', '').trim();
    else if (l.match(/^(Markdown Content|Content):/)) { bodyStart = i + 1; break; }
  }

  // If no structured header, find first heading
  if (bodyStart === 0) {
    for (let i = 0; i < Math.min(lines.length, 10); i++) {
      if (lines[i].startsWith('#')) {
        if (!title) title = lines[i].replace(/^#+\s*/, '').trim();
        bodyStart = i + 1;
        break;
      }
    }
  }

  // Convert markdown body to clean readable text
  const text = lines.slice(bodyStart)
    .map(l => l
      .replace(/^#{1,6}\s+/, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/^[-*+]\s+/, '')
      .replace(/^\d+\.\s+/, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^>\s+/, '')
    )
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();

  if (!title && text) title = text.split('\n').find(l => l.trim().length > 10) || 'Untitled';
  const excerpt = text.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').slice(0, 220).trim() + '…';
  return { title: title || 'Untitled', author, date, text, excerpt };
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let url;
  try {
    ({ url } = JSON.parse(event.body || '{}'));
    if (!url || !url.startsWith('http')) throw new Error('bad url');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request' }) };
  }

  // Strategy 1: fetch HTML directly and extract text
  try {
    const html = await fetchUrl(url);
    const data = extractFromHtml(html);
    if (data.text && data.text.length > 300) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      };
    }
    throw new Error('Not enough text extracted directly');
  } catch (err1) {

    // Strategy 2: Jina Reader — handles JS-rendered pages, paywalled intros, etc.
    try {
      const raw = await fetchViaJina(url);
      const data = parseJinaResponse(raw);

      if (!data.text || data.text.length < 100) throw new Error('Jina returned insufficient text');

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      };
    } catch (err2) {
      return {
        statusCode: 502,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: `Could not fetch article. Direct: ${err1.message}. Jina: ${err2.message}`
        })
      };
    }
  }
};
