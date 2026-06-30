export async function onRequest(context) {
  const url = new URL(context.request.url);

  // Proxy to Firebase's auth domain
  const targetUrl = new URL(context.request.url);
  targetUrl.hostname = 'wishlist-app-5ca53.firebaseapp.com';

  const init = {
    method: context.request.method,
    headers: new Headers(context.request.headers),
    redirect: 'manual',
  };
  if (context.request.method !== 'GET' && context.request.method !== 'HEAD') {
    init.body = context.request.body;
  }

  const upstream = await fetch(targetUrl.toString(), init);

  // Forward headers, removing ones that would block iframe or CSP
  const headers = new Headers();
  for (const [k, v] of upstream.headers.entries()) {
    const lower = k.toLowerCase();
    if (lower === 'x-frame-options') continue;
    if (lower === 'content-security-policy') continue;
    headers.set(k, v);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}
