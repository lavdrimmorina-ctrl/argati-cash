// ── ARGATI CASH — Cloudflare Worker ──────────────────────────────────────
// Handles VAPID push notifications for Argati Cash PWA
// Deploy to: Cloudflare Workers (free tier)

// ── CONFIG — set these as Worker Environment Variables in Cloudflare ──────
// VAPID_PUBLIC_KEY  = your generated VAPID public key
// VAPID_PRIVATE_KEY = your generated VAPID private key
// VAPID_SUBJECT     = mailto:you@example.com

// ── VAPID KEY GENERATOR (run once locally with node) ─────────────────────
// const webpush = require('web-push'); console.log(webpush.generateVAPIDKeys());

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(req.url);

    // ── GET /vapid-public-key ─────────────────────────────────────────────
    if (url.pathname === '/vapid-public-key') {
      return json({ key: env.VAPID_PUBLIC_KEY });
    }

    // ── POST /subscribe — save a push subscription ────────────────────────
    if (url.pathname === '/subscribe' && req.method === 'POST') {
      const body = await req.json();
      const { subscription, deviceId } = body;
      if (!subscription || !deviceId) return json({ error: 'Missing fields' }, 400);
      await env.CASH_SUBS.put(`sub:${deviceId}`, JSON.stringify(subscription));
      return json({ ok: true });
    }

    // ── POST /unsubscribe ─────────────────────────────────────────────────
    if (url.pathname === '/unsubscribe' && req.method === 'POST') {
      const { deviceId } = await req.json();
      if (deviceId) await env.CASH_SUBS.delete(`sub:${deviceId}`);
      return json({ ok: true });
    }

    // ── POST /notify — send a push to a specific device ──────────────────
    if (url.pathname === '/notify' && req.method === 'POST') {
      const { deviceId, title, body, icon } = await req.json();
      const raw = await env.CASH_SUBS.get(`sub:${deviceId}`);
      if (!raw) return json({ error: 'No subscription found' }, 404);
      const sub = JSON.parse(raw);
      const result = await sendPush(env, sub, { title, body, icon: icon || '/icon-192.png' });
      return json(result);
    }

    // ── POST /notify-all — send to all subscribed devices ────────────────
    if (url.pathname === '/notify-all' && req.method === 'POST') {
      const { title, body, icon } = await req.json();
      const list = await env.CASH_SUBS.list({ prefix: 'sub:' });
      const results = await Promise.allSettled(
        list.keys.map(async k => {
          const raw = await env.CASH_SUBS.get(k.name);
          if (!raw) return;
          return sendPush(env, JSON.parse(raw), { title, body, icon: icon || '/icon-192.png' });
        })
      );
      return json({ sent: results.filter(r => r.status === 'fulfilled').length });
    }

    // ── GET /test — quick health check ───────────────────────────────────
    if (url.pathname === '/test') {
      return json({ status: 'Argati Cash Worker running', ts: new Date().toISOString() });
    }

    return json({ error: 'Not found' }, 404);
  },

  // ── SCHEDULED — daily evening notification at 18:00 UTC ──────────────
  async scheduled(event, env, ctx) {
    const list = await env.CASH_SUBS.list({ prefix: 'sub:' });
    if (!list.keys.length) return;
    await Promise.allSettled(
      list.keys.map(async k => {
        const raw = await env.CASH_SUBS.get(k.name);
        if (!raw) return;
        return sendPush(env, JSON.parse(raw), {
          title: '💸 Argati Cash',
          body: "Don't forget to log today's expenses!",
          icon: '/icon-192.png',
        });
      })
    );
  },
};

// ── PUSH HELPER ───────────────────────────────────────────────────────────
async function sendPush(env, subscription, payload) {
  const endpoint = subscription.endpoint;
  const p256dh = subscription.keys?.p256dh;
  const auth = subscription.keys?.auth;

  if (!endpoint || !p256dh || !auth) return { error: 'Invalid subscription' };

  const vapidHeaders = await buildVapidHeaders(
    env.VAPID_PRIVATE_KEY,
    env.VAPID_PUBLIC_KEY,
    env.VAPID_SUBJECT || 'mailto:admin@argati.cash',
    endpoint
  );

  const body = JSON.stringify(payload);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      ...vapidHeaders,
      'Content-Type': 'application/json',
      'Content-Length': body.length.toString(),
      'TTL': '86400',
    },
    body,
  });

  return { status: res.status, ok: res.ok };
}

// ── VAPID header builder using Web Crypto ─────────────────────────────────
async function buildVapidHeaders(privateKeyB64, publicKeyB64, subject, endpoint) {
  const audience = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 12 * 3600;

  const header = btoa(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const payload = btoa(JSON.stringify({ aud: audience, exp, sub: subject })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const unsigned = `${header}.${payload}`;

  const keyData = base64UrlDecode(privateKeyB64);
  const key = await crypto.subtle.importKey(
    'raw', keyData,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign']
  );

  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(unsigned)
  );

  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const token = `${unsigned}.${sigB64}`;

  return {
    Authorization: `vapid t=${token}, k=${publicKeyB64}`,
  };
}

function base64UrlDecode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
