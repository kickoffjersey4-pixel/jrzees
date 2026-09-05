const ALLOWED_HOSTS = [
  'photo.yupoo.com',
  'images.footballfanatics.com',
  'classicfootballshirts.co.uk',
  'assets.adidas.com',
  'upload.wikimedia.org',
];

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = url.searchParams.get('url');

    if (!target) {
      return new Response('url required', { status: 400 });
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return new Response('invalid url', { status: 400 });
    }

    if (!ALLOWED_HOSTS.some(h => targetUrl.hostname === h || targetUrl.hostname.endsWith('.' + h))) {
      return new Response('host not allowed', { status: 403 });
    }

    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: 'GET' });
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const upstream = await fetch(targetUrl.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': `https://${targetUrl.hostname}/`,
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
      },
      redirect: 'follow',
    });

    if (!upstream.ok) {
      return new Response('upstream error', { status: upstream.status });
    }

    const response = new Response(upstream.body, upstream);
    response.headers.set('Cache-Control', 'public, max-age=2592000, s-maxage=2592000');
    response.headers.set('Access-Control-Allow-Origin', '*');

    const ct = upstream.headers.get('content-type') || 'image/jpeg';
    response.headers.set('Content-Type', ct);

    const cacheResp = response.clone();
    context.waitUntil(cache.put(cacheKey, cacheResp));

    return response;
  },
};
