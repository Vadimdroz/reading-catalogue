export async function onRequestPost(context) {
  let url;
  try {
    const body = await context.request.json();
    url = body.url;
    if (!url || !url.startsWith('http')) throw new Error('bad url');
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  // Strategy 1: fetch directly with realistic browser headers
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,he;q=0.8',
        'Cache-Control': 'no-cache',
      }
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const data = isThreadReaderUrl(url) ? extractThreadReader(html, url) : extractFromHtml(html);

    if (data.text && data.text.length > 300) {
      return new Response(JSON.stringify(data), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }
    throw new Error('Not enough text extracted directly');

  } catch (err1) {

    // Strategy 2: Jina Reader proxy
    try {
      const jinaRes = await fetch(`https://r.jina.ai/${url}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'text/plain, */*',
          'X-No-Cache': 'true',
          'X-Timeout': '25',
        }
      });

      if (!jinaRes.ok) throw new Error(`Jina HTTP ${jinaRes.status}`);
      const raw = await jinaRes.text();
      const data = parseJinaResponse(raw);

      if (!data.text || data.text.length < 100) throw new Error('Jina returned insufficient text');

      return new Response(JSON.stringify(data), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });

    } catch (err2) {
      return new Response(JSON.stringify({
        error: `Could not fetch. Direct: ${err1.message}. Jina: ${err2.message}`
      }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }
  }
}

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
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanText(text) {
  return decodeHtmlEntities(text)
    .split('\n')
    .filter(line => line.trim().length === 0 || line.trim().length > 25)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 20000);
}

function isThreadReaderUrl(url) {
  return /threadreaderapp\.com\/thread\//i.test(url);
}

function extractThreadReader(html, url) {
  const threadIdMatch = url.match(/\/thread\/(\d+)/);
  const threadId = threadIdMatch ? threadIdMatch[1] : '';

  // Handle from first /user/ link
  const handleMatch = html.match(/<a[^>]+href=["']\/user\/([^"'\s\/]+)["']/i);
  const handle = handleMatch ? handleMatch[1] : '';

  // Display name from h3/h4 wrapping the /user/ link
  const displayNameMatch = html.match(/<h[34][^>]*>[\s\S]*?<a[^>]+href=["']\/user\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/i);
  const displayName = displayNameMatch
    ? decodeHtmlEntities(displayNameMatch[1].replace(/<[^>]+>/g, '').trim())
    : '';

  const tweetUrl = handle && threadId
    ? `https://twitter.com/${handle}/status/${threadId}` : '';

  // Title from og:title, strip the site suffix
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  const pageTitle = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  let title = decodeHtmlEntities(
    (ogTitle && ogTitle[1]) || (pageTitle && pageTitle[1]) || ''
  ).replace(/\s*on Thread Reader App\s*/i, '').trim() || (handle ? `Thread by @${handle}` : 'Twitter Thread');

  // Strip scripts/styles/nav/etc
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Blank out all href/src attribute values before tag stripping.
  // This neutralises any literal > inside mailto: or long URLs that would
  // otherwise break the <[^>]+> tag-stripping regex.
  body = body
    .replace(/\bhref="[^"]*"/gi, 'href=""')
    .replace(/\bhref='[^']*'/gi, "href=''")
    .replace(/\bsrc="[^"]*"/gi, 'src=""')
    .replace(/\baction="[^"]*"/gi, 'action=""');

  // Remove all anchor elements and their content
  body = body
    .replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, ' ')
    .replace(/<a\b[^>]*>/gi, ' ');

  // Known ThreadReaderApp page-chrome strings to exclude from content
  const noise = [
    'stay in touch', 'get notified when new unrolls', 'thread may be removed',
    'twitter may remove this content', 'save it as pdf', 'practice here first',
    'read more on our help page', 'indie developers', 'premium member',
    'small donation', 'donate anonymously', 'email the whole thread',
    'how to get url link', 'you can paste full url', 'just the id like',
    'support us', 'become a premium', 'server cost',
  ];

  const paragraphs = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(m => decodeHtmlEntities(m[1].replace(/<[^>]+>/g, '').trim()))
    .filter(p => {
      if (p.length < 30) return false;
      const lower = p.toLowerCase();
      return !noise.some(n => lower.includes(n));
    });

  let text = paragraphs.join('\n\n');
  if (!text || text.length < 100) return extractFromHtml(html);

  // Use first paragraph as title if title is still generic
  if (/^Thread by @/i.test(title)) {
    const firstLine = text.split('\n').find(l => l.trim().length > 20);
    if (firstLine) title = firstLine.trim().slice(0, 100) + (firstLine.length > 100 ? '…' : '');
  }

  text = cleanText(text);
  const author = displayName ? `${displayName} (@${handle})` : handle ? `@${handle}` : '';
  const excerpt = text.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').slice(0, 220).trim() + '…';

  return { title, author, date: '', text, excerpt, tweetUrl, isThread: true };
}

function extractFromHtml(html) {
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']{1,200})["']/i);
  const twTitle = html.match(/<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']{1,200})["']/i);
  const htmlTitle = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
  const title = decodeHtmlEntities(
    (ogTitle && ogTitle[1]) || (twTitle && twTitle[1]) || (htmlTitle && htmlTitle[1]) || 'Untitled'
  ).trim();

  const authorMatch = html.match(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']{1,100})["']/i)
    || html.match(/<meta[^>]+property=["']article:author["'][^>]+content=["']([^"']{1,100})["']/i);
  const author = authorMatch ? decodeHtmlEntities(authorMatch[1]).trim() : '';

  const dateMatch = html.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<time[^>]+datetime=["']([^"']+)["']/i);
  const date = dateMatch ? dateMatch[1].trim() : '';

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

  // Collect ALL article blocks
  const articleMatches = [...body.matchAll(/<article[^>]*>([\s\S]*?)<\/article>/gi)];
  if (articleMatches.length > 0) {
    const combined = articleMatches.map(m => m[1]).join('\n\n');
    const text = cleanText(htmlToText(combined));
    if (text.length > 300) {
      const excerpt = text.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').slice(0, 220).trim() + '…';
      return { title, author, date, text, excerpt };
    }
  }

  // Named content blocks
  const namedBlockPattern = /<div[^>]+(?:class|id)=["'][^"']*(?:article-body|article-content|articleBody|post-content|post-body|entry-content|story-body|story-content|main-content|article__body|article__content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
  const namedBlocks = [...body.matchAll(namedBlockPattern)];
  if (namedBlocks.length > 0) {
    const combined = namedBlocks.map(m => m[1]).join('\n\n');
    const text = cleanText(htmlToText(combined));
    if (text.length > 300) {
      const excerpt = text.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').slice(0, 220).trim() + '…';
      return { title, author, date, text, excerpt };
    }
  }

  // All paragraphs fallback
  const paragraphs = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(m => decodeHtmlEntities(m[1].replace(/<[^>]+>/g, '').trim()))
    .filter(p => p.length > 40);
  if (paragraphs.length > 0) {
    const text = paragraphs.join('\n\n').trim();
    const excerpt = text.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').slice(0, 220).trim() + '…';
    return { title, author, date, text, excerpt };
  }

  const text = cleanText(htmlToText(body));
  const excerpt = text.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').slice(0, 220).trim() + '…';
  return { title, author, date, text, excerpt };
}

function parseJinaResponse(raw) {
  const lines = raw.split('\n');
  let title = '', date = '', author = '', bodyStart = 0;

  for (let i = 0; i < Math.min(lines.length, 25); i++) {
    const l = lines[i];
    if (l.startsWith('Title:'))           title  = l.replace('Title:', '').trim();
    else if (l.startsWith('Published Time:')) date = l.replace('Published Time:', '').trim();
    else if (l.startsWith('Author:'))     author = l.replace('Author:', '').trim();
    else if (l.match(/^(Markdown Content|Content):/)) { bodyStart = i + 1; break; }
  }

  if (bodyStart === 0) {
    for (let i = 0; i < Math.min(lines.length, 10); i++) {
      if (lines[i].startsWith('#')) {
        if (!title) title = lines[i].replace(/^#+\s*/, '').trim();
        bodyStart = i + 1;
        break;
      }
    }
  }

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
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!title && text) title = text.split('\n').find(l => l.trim().length > 10) || 'Untitled';
  const excerpt = text.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').slice(0, 220).trim() + '…';
  return { title: title || 'Untitled', author, date, text, excerpt };
}
