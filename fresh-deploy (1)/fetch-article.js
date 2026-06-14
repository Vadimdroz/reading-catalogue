export async function onRequestPost(context) {
  let url, originalTweetUrl;
  try {
    const body = await context.request.json();
    url = body.url;
    originalTweetUrl = body.tweetUrl || '';
    if (!url || !url.startsWith('http')) throw new Error('bad url');
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  const isTweet = isTweetUrl(url);
  let directError = 'skipped (Twitter URL)';

  // Strategy 1: direct fetch — skip for Twitter/X because their SSR only returns
  // tweet #1 before a login wall, which looks like success but is incomplete.
  if (!isTweet) {
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
      let data = isThreadReaderUrl(url) ? extractThreadReader(html, url) : extractFromHtml(html);
      if (isThreadReaderUrl(url) && !data.isThread && originalTweetUrl) {
        const oembedResult = await fetchTweetOembed(originalTweetUrl).catch(() => null);
        if (oembedResult) data = oembedResult;
      }
      const minLen = (data.tweetUrl && !data.isThread) ? 10 : 300;
      if (data.text && data.text.length >= minLen) {
        return new Response(JSON.stringify(data), {
          status: 200, headers: { 'Content-Type': 'application/json' }
        });
      }
      throw new Error('Not enough text extracted directly');
    } catch (e) {
      directError = e.message;
    }
  }

  // For Twitter/X: try proxy sites + ThreadReaderApp in parallel, then Jina as final fallback.
  // Proxy sites (fxtwitter, vxtwitter) render tweets server-side without a login wall.
  if (isTweet) {
    const match = url.match(/(?:twitter\.com|x\.com)\/([^/?#]+)\/status\/(\d+)/i);
    if (match) {
      const [, uname, tid] = match;
      const proxyUrls = [
        `https://fxtwitter.com/${uname}/status/${tid}`,
        `https://vxtwitter.com/${uname}/status/${tid}`,
      ];

      const safeJina = async (targetUrl) => {
        try {
          const r = await fetch(`https://r.jina.ai/${targetUrl}`, {
            headers: { 'Accept': 'text/plain, */*', 'X-No-Cache': 'true', 'X-Timeout': '8' }
          });
          if (!r.ok) return null;
          const raw = await r.text();
          const d = parseJinaResponse(raw);
          return (d && d.text && d.text.length > 10) ? d : null;
        } catch { return null; }
      };

      const [p1, p2, traData, oembedData] = await Promise.all([
        safeJina(proxyUrls[0]),
        safeJina(proxyUrls[1]),
        (async () => { try { return await tryThreadReaderApp(url); } catch { return null; } })(),
        (async () => { try { const r = await fetchTweetOembed(url); return (r && r.text && r.text.length > 5) ? r : null; } catch { return null; } })(),
      ]);

      const tweetResult = traData || p1 || p2 || oembedData;
      if (tweetResult) {
        return new Response(JSON.stringify(tweetResult), {
          status: 200, headers: { 'Content-Type': 'application/json' }
        });
      }
    }
  }

  // Last resort: Jina on the original URL (15s timeout)
  try {
    const jinaController = new AbortController();
    const jinaTimer = setTimeout(() => jinaController.abort(), 15000);
    const jinaRes = await fetch(`https://r.jina.ai/${url}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'text/plain, */*',
        'X-No-Cache': 'true',
        'X-Timeout': '12',
      },
      signal: jinaController.signal,
    });
    clearTimeout(jinaTimer);
    if (!jinaRes.ok) throw new Error(`Jina HTTP ${jinaRes.status}`);
    const raw = await jinaRes.text();
    const data = parseJinaResponse(raw);
    const jinaMin = isTweet ? 10 : 100;
    if (!data.text || data.text.length < jinaMin) throw new Error('Jina returned insufficient text');
    return new Response(JSON.stringify(data), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  } catch (err2) {
    return new Response(JSON.stringify({
      error: `Could not fetch this content. Tried ThreadReaderApp, Nitter, Twitter API, oembed, and Jina. Last error: ${err2.message}`
    }), { status: 502, headers: { 'Content-Type': 'application/json' } });
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
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function stripWebComponentCss(text) {
  return text
    .replace(/:host\{[^\n]*\}/g, '')
    .replace(/\bnumber-flow-react\b[^\n]*/g, '')
    .replace(/\d+[KMB]?\s*(Views|Likes|Reposts|Bookmarks|Replies)/gi, '')
    .replace(/\d+:\d+\s*(AM|PM)\s*·[^\n]*/gi, '')
    .replace(/Don't miss what's happening[\s\S]*?People on X are the first to know\./gi, '')
    .replace(/Log in\s*Sign up/gi, '')
    .replace(/New to X\?[\s\S]*?Sign up now/gi, '');
}

function cleanText(text) {
  return decodeHtmlEntities(stripWebComponentCss(text))
    .split('\n')
    .filter(line => line.trim().length === 0 || line.trim().length > 25)
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
    .slice(0, 20000);
}

function isThreadReaderUrl(url) {
  return /threadreaderapp\.com\/thread\//i.test(url);
}

function isTweetUrl(url) {
  return /(?:twitter\.com|x\.com)\/[^/?#]+\/status\/\d+/i.test(url);
}

const NITTER_INSTANCES = [
  'nitter.privacyredirect.com',
  'nitter.poast.org',
];

function parseNitterThread(html) {
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  let title = titleMatch ? decodeHtmlEntities(titleMatch[1]).replace(/\s*\|\s*Nitter.*/i, '').trim() : '';

  const authorMatch = html.match(/<a[^>]+class="[^"]*fullname[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
  const author = authorMatch ? htmlToText(authorMatch[1]).trim() : '';

  // Each tweet in a Nitter thread is in a div with class containing "tweet-content"
  const tweetDivs = [...html.matchAll(/<div[^>]+class="[^"]*tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)];
  const tweets = tweetDivs
    .map(m => htmlToText(m[1]).trim())
    .filter(t => t.length > 0);

  if (tweets.length === 0) return null;

  const text = cleanText(tweets.join('\n'));
  if (text.length < 20) return null;

  const excerpt = text.replace(/\n+/g, ' ').slice(0, 220).trim() + '…';
  return { title: title || `Thread by ${author}`, author, date: '', text, excerpt, isThread: tweets.length > 1 };
}

async function fetchNitterThread(tweetUrl) {
  const match = tweetUrl.match(/(?:twitter\.com|x\.com)\/([^/?#]+)\/status\/(\d+)/i);
  if (!match) return null;
  const [, username, id] = match;

  // Try all Nitter instances in parallel, each with a 4s timeout
  const results = await Promise.all(NITTER_INSTANCES.map(async instance => {
    const nitterUrl = `https://${instance}/${username}/status/${id}`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(nitterUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        redirect: 'follow',
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      const html = await res.text();
      return parseNitterThread(html);
    } catch { return null; }
  }));
  return results.find(r => r && r.text && r.text.length > 30) || null;
}

async function tryThreadReaderApp(tweetUrl) {
  const match = tweetUrl.match(/(?:twitter\.com|x\.com)\/[^/?#]+\/status\/(\d+)/i);
  if (!match) return null;
  const id = match[1];
  const url = `https://threadreaderapp.com/thread/${id}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    redirect: 'manual',
  });
  // 302 to /authenticate means the thread isn't indexed yet
  if (res.status === 301 || res.status === 302) {
    const loc = res.headers.get('location') || '';
    if (loc.includes('authenticate')) return null;
  }
  if (res.status !== 200) return null;
  const html = await res.text();
  const data = extractThreadReader(html, url);
  return (data.isThread && data.text && data.text.length > 100) ? data : null;
}

// Twitter's own bearer token (embedded in X's web app JS, used for guest/unauthenticated calls)
const TWITTER_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I7wHoANeWDs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

async function fetchTwitterGuestApi(tweetUrl) {
  const match = tweetUrl.match(/(?:twitter\.com|x\.com)\/([^/?#]+)\/status\/(\d+)/i);
  if (!match) return null;
  const [, username, id] = match;

  // Step 1: get a guest token
  const activateRes = await fetch('https://api.twitter.com/1.1/guest/activate.json', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TWITTER_BEARER}` }
  });
  if (!activateRes.ok) return null;
  const { guest_token } = await activateRes.json();
  if (!guest_token) return null;

  // Step 2: fetch conversation timeline (v2 guest endpoint)
  const convRes = await fetch(
    `https://twitter.com/i/api/2/timeline/conversation/${id}.json?count=100&tweet_mode=extended`,
    {
      headers: {
        'Authorization': `Bearer ${TWITTER_BEARER}`,
        'X-Guest-Token': guest_token,
        'X-Twitter-Active-User': 'yes',
        'Accept': 'application/json',
      }
    }
  );
  if (!convRes.ok) return null;
  const json = await convRes.json();

  // Extract tweets by the thread author, in order
  const tweetsObj = json?.globalObjects?.tweets || {};
  const usersObj  = json?.globalObjects?.users  || {};
  const targetUser = Object.values(usersObj).find(u => u.screen_name?.toLowerCase() === username.toLowerCase());
  const targetUid = targetUser?.id_str;

  const threadTweets = Object.values(tweetsObj)
    .filter(t => t.user_id_str === targetUid && !t.full_text?.startsWith('RT @'))
    .sort((a, b) => a.id_str.localeCompare(b.id_str))
    .map(t => t.full_text || t.text || '')
    .filter(t => t.length > 0);

  if (threadTweets.length === 0) return null;

  const author = targetUser ? (targetUser.name || `@${username}`) : `@${username}`;
  const text = cleanText(threadTweets.join('\n'));
  const excerpt = text.replace(/\n+/g, ' ').slice(0, 220).trim() + '…';
  return {
    title: `Thread by ${author}`,
    author,
    date: '',
    text,
    excerpt,
    isThread: threadTweets.length > 1,
  };
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

  // Use a clean placeholder title — the frontend will replace it with an AI title via Gemini
  let title = handle ? `Thread by @${handle}` : 'Twitter Thread';

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

  // Primary: extract from ThreadReaderApp's content-tweet blocks.
  // Split on the class string to avoid issues with > inside data-action attributes.
  const contentChunks = body.split(/class="content-tweet\s+allow-preview"/i);
  let tweetTexts = [];
  let foundRealTweets = false;
  if (contentChunks.length > 2) {
    const MARKER = 'dir="auto">';
    tweetTexts = contentChunks.slice(1).map(chunk => {
      const idx = chunk.indexOf(MARKER);
      if (idx === -1) return '';
      let raw = chunk.slice(idx + MARKER.length);
      const end = raw.search(/<sup\b/i);
      if (end !== -1) raw = raw.slice(0, end);
      return decodeHtmlEntities(
        raw.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim()
      );
    }).filter(t => t.length >= 20);
    if (tweetTexts.length >= 1) foundRealTweets = true;
  }

  // Fallback: <p> tags (older ThreadReaderApp layout)
  // Do NOT set foundRealTweets — this path also catches error/request pages,
  // so we leave isThread: false to allow the oembed fallback to kick in.
  if (!foundRealTweets) {
    tweetTexts = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
      .map(m => decodeHtmlEntities(m[1].replace(/<[^>]+>/g, '').trim()))
      .filter(p => {
        if (p.length < 30) return false;
        const lower = p.toLowerCase();
        return !noise.some(n => lower.includes(n));
      });
  }

  let text = tweetTexts.join('\n\n');
  if (!text || text.length < 100) return extractFromHtml(html);

  text = cleanText(text);
  const author = displayName ? `${displayName} (@${handle})` : handle ? `@${handle}` : '';
  const excerpt = text.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').slice(0, 220).trim() + '…';

  return { title, author, date: '', text, excerpt, tweetUrl, isThread: foundRealTweets };
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

  // DraftJS / rich-text editor content (e.g. ynet.co.il uses <span data-text="true">)
  const dataTextSpans = [...body.matchAll(/<span[^>]+data-text="true"[^>]*>([\s\S]*?)<\/span>/gi)]
    .map(m => decodeHtmlEntities(m[1].replace(/<[^>]+>/g, '').trim()))
    .filter(t => t.length > 10);
  if (dataTextSpans.length > 0) {
    const text = cleanText(dataTextSpans.join('\n'));
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

async function fetchFxTwitter(tweetUrl) {
  const match = tweetUrl.match(/(?:twitter\.com|x\.com)\/([^/?#]+)\/status\/(\d+)/i);
  if (!match) return null;
  const [, username, id] = match;
  const res = await fetch(`https://api.fxtwitter.com/${username}/status/${id}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  if (!res.ok) return null;
  const json = await res.json();
  if (json.code !== 200 || !json.tweet) return null;
  const tweet = json.tweet;
  const text = cleanText(tweet.text || '');
  if (!text || text.length < 5) return null;
  const author = tweet.author?.name || tweet.author?.screen_name || '';
  const excerpt = text.replace(/\n+/g, ' ').slice(0, 220).trim() + '…';
  return { title: `Tweet by ${author}`, author, date: tweet.created_at || '', text, excerpt, tweetUrl, isThread: false };
}

async function fetchTweetOembed(tweetUrl) {
  // Normalise x.com/twitter.com URL — publish.x.com requires a full username/status URL
  const cleanUrl = tweetUrl.split('?')[0].replace('twitter.com', 'x.com');
  const res = await fetch(
    `https://publish.x.com/oembed?url=${encodeURIComponent(cleanUrl)}&omit_script=true&dnt=true`
  );
  if (!res.ok) return null;
  const data = await res.json();
  if (!data || !data.html) return null;

  const html = data.html;
  const pMatch = html.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
  if (!pMatch) return null;

  let text = pMatch[1]
    .replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, '')  // strip t.co shorteners, pic URLs, etc.
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .trim();
  text = decodeHtmlEntities(text).replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();

  if (text.length < 5) return null;

  const author = data.author_name || '';
  const title = text.slice(0, 100) + (text.length > 100 ? '…' : '');
  const excerpt = text.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').slice(0, 220).trim() + '…';
  const returnUrl = data.url || cleanUrl;

  return { title, author, date: '', text, excerpt, tweetUrl: returnUrl, isThread: false };
}

function parseJinaResponse(raw) {
  const lines = stripWebComponentCss(raw).split('\n');
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

  let text = lines.slice(bodyStart)
    .map(l => l
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '')   // remove markdown images
      .replace(/\[\]\([^)]*\)/g, '')              // remove empty links
      .replace(/^#{1,6}\s+/, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/^[-*+]\s+/, '')
      .replace(/^\d+\.\s+/, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^>\s+/, '')
    )
    .filter(l => {
      const t = l.trim();
      if (!t) return true;
      if (t.length <= 20) return false;
      // Strip web component CSS (Twitter's number-flow-react animated counters)
      if (t.startsWith(':host{') || /\bnumber-flow-react\b/.test(t)) return false;
      // Strip Twitter UI noise: timestamps, view/like counts
      if (/^\d+:\d+\s*(AM|PM)\s*·/i.test(t)) return false;
      if (/^\d+[KMB]?\s*(Views|Likes|Reposts|Bookmarks|Replies)$/i.test(t)) return false;
      return true;
    })
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();

  // Strip inline Twitter UI noise that can survive the line filter
  text = text
    .replace(/\d+[KMB]?\s*(Views|Likes|Reposts|Bookmarks|Replies)/gi, '')
    .replace(/\d+:\d+\s*(AM|PM)\s*·[^\n]*/gi, '')
    .replace(/\n{2,}/g, '\n')
    .trim();

  // Strip duplicate title lines (title shown separately in the card)
  if (title && title.length > 10) {
    const esc = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp('^' + esc + '\\s*$', 'gm'), '');
  }
  // Strip ad/widget boilerplate lines that survive the length filter
  text = text
    .replace(/^(Sponsored|Promoted)\s+Links.*/gim, '')
    .split('\n')
    .filter(l => {
      const t = l.trim().toLowerCase();
      if (!t) return true;
      return !(
        t.endsWith('learn more') || t.endsWith('get offer') ||
        t.endsWith('shop now')   || t.endsWith('read more') ||
        t.endsWith('find out more') || t.endsWith('shop now.') ||
        t === 'undo'
      );
    })
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();

  // For X/Twitter Jina titles: "name on X: "tweet text..."" → extract author + clean title
  if (!author && title && /\bon X[:：]/i.test(title)) {
    author = title.replace(/\s+on X[:：].*/i, '').trim();
    title = title.replace(/^.*?\bon X[:：]\s*["""„]/i, '').replace(/[""""]$/, '').trim();
  }

  if (!title && text) title = text.split('\n').find(l => l.trim().length > 10) || 'Untitled';
  const excerpt = text.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').slice(0, 220).trim() + '…';
  return { title: title || 'Untitled', author, date, text, excerpt };
}
