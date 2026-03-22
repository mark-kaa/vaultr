// Vaultr Backend Worker
// Håndterer: 1) Prisalarm cron, 2) API proxy for Perplexity/eBay/CM/PSA

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

export default {
  // HTTP endpoint
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname;

    // ── API PROXY ENDPOINTS ──

    // POST /proxy/perplexity — AI analyse
    if (path === '/proxy/perplexity' && request.method === 'POST') {
      const body = await request.json();
      const r = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.PPLX_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      return new Response(JSON.stringify(data), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
        status: r.status,
      });
    }

    // POST /proxy/ebay/token — eBay OAuth token
    if (path === '/proxy/ebay/token' && request.method === 'POST') {
      const creds = btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`);
      const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${creds}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
      });
      const data = await r.json();
      return new Response(JSON.stringify(data), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
        status: r.status,
      });
    }

    // GET /proxy/ebay/search?q=...  — eBay Browse API
    if (path === '/proxy/ebay/search' && request.method === 'GET') {
      // Hent frisk token
      const creds = btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`);
      const tokenR = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
        method: 'POST',
        headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
      });
      const { access_token } = await tokenR.json();
      const params = url.searchParams.toString();
      const r = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`, {
        headers: { 'Authorization': `Bearer ${access_token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_DE' },
      });
      const data = await r.json();
      return new Response(JSON.stringify(data), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
        status: r.status,
      });
    }

    // GET /proxy/cm/search?name=... — Cardmarket via RapidAPI
    if (path === '/proxy/cm/search' && request.method === 'GET') {
      const params = url.searchParams.toString();
      const r = await fetch(`https://cardmarket-api-tcg.p.rapidapi.com/pokemon/cards/search?${params}`, {
        headers: {
          'X-RapidAPI-Key': env.CM_RAPIDAPI_KEY,
          'X-RapidAPI-Host': 'cardmarket-api-tcg.p.rapidapi.com',
        },
      });
      const data = await r.json();
      return new Response(JSON.stringify(data), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
        status: r.status,
      });
    }

    // GET /proxy/psa/cert/:certNumber — PSA cert lookup
    if (path.startsWith('/proxy/psa/cert/') && request.method === 'GET') {
      const certNumber = path.split('/').pop();
      const r = await fetch(`https://api.psacard.com/publicapi/cert/GetByCertNumber/${certNumber}`, {
        headers: { 'Authorization': `Bearer ${env.PSA_API_KEY}` },
      });
      const data = await r.json();
      return new Response(JSON.stringify(data), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
        status: r.status,
      });
    }

    // POST /run or ?run — prisalarm cron manuel trigger
    if (path === '/run' || url.searchParams.has('run')) {
      const result = await runPriceCheck(env);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    return new Response('Vaultr API Worker', { headers: CORS });
  },

  // Cron trigger — prisalarm hver 6. time
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runPriceCheck(env));
  }
};

// ── Prisalarm logik ──
async function fetchCMPrice(productName, setName, cmApiKey) {
  if (!cmApiKey) return null;
  try {
    const query = `${productName} ${setName}`.trim();
    const url = `https://cardmarket-api-tcg.p.rapidapi.com/pokemon/cards/search?name=${encodeURIComponent(query)}&language=en`;
    const res = await fetch(url, {
      headers: { 'X-RapidAPI-Key': cmApiKey, 'X-RapidAPI-Host': 'cardmarket-api-tcg.p.rapidapi.com' }
    });
    if (!res.ok) return null;
    const json = await res.json();
    const card = json?.data?.[0];
    if (!card) return null;
    const prices = card.prices?.cardmarket;
    const liveEUR = prices?.lowest_near_mint_DE || prices?.lowest_near_mint_FR || prices?.trend_price || null;
    return liveEUR ? Math.round(parseFloat(liveEUR) * 7.46) : null;
  } catch (e) { return null; }
}

async function sendAlarmMail(userEmail, alarms, resendApiKey) {
  const itemRows = alarms.map(a => `<tr><td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;font-weight:600;color:#e8e8e8">${a.name}</td><td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;color:#f0b429">${a.livePrice} DKK</td><td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;color:#0c7a85">${a.targetPrice} DKK</td></tr>`).join('');
  const html = `<!DOCTYPE html><html><body style="background:#0f0f0f;color:#e8e8e8;font-family:system-ui;padding:32px"><div style="max-width:520px;margin:0 auto"><h2 style="color:#f0b429">⚡ Vaultr Prisalarm</h2><p style="color:#888">Følgende kort har ramt din målpris:</p><table style="width:100%;border-collapse:collapse"><thead><tr style="color:#666;font-size:.75rem"><th style="padding:6px 12px;text-align:left;border-bottom:1px solid #333">Kort</th><th style="padding:6px 12px;text-align:left;border-bottom:1px solid #333">Live pris</th><th style="padding:6px 12px;text-align:left;border-bottom:1px solid #333">Din målpris</th></tr></thead><tbody>${itemRows}</tbody></table><a href="https://pokemon-samling.mka-831.workers.dev" style="display:inline-block;margin-top:20px;background:#f0b429;color:#000;font-weight:700;padding:10px 20px;border-radius:8px;text-decoration:none">Åbn Vaultr →</a></div></body></html>`;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Vaultr Prisalarm <onboarding@resend.dev>', to: [userEmail], subject: `🔔 ${alarms.length} kort har ramt målpris — Vaultr`, html }),
  });
}

async function runPriceCheck(env) {
  const h = { 'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}` };
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/watchlist_items?select=id,user_id,data`, { headers: h });
  if (!res.ok) return { error: await res.text() };
  const rows = await res.json();
  if (!rows.length) return { checked: 0, alarms: 0 };
  const userIds = [...new Set(rows.map(r => r.user_id))];
  const userEmails = {};
  for (const uid of userIds) {
    const ur = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${uid}`, { headers: h });
    if (ur.ok) { const u = await ur.json(); userEmails[uid] = u.email; }
  }
  const alarmsByUser = {};
  for (const row of rows) {
    const w = row.data;
    if (!w.targetPrice || w.targetPrice <= 0) continue;
    const livePrice = await fetchCMPrice(w.productName, w.set, env.CM_RAPIDAPI_KEY);
    if (!livePrice || livePrice > w.targetPrice) continue;
    if (!alarmsByUser[row.user_id]) alarmsByUser[row.user_id] = [];
    alarmsByUser[row.user_id].push({ name: w.productName, set: w.set, targetPrice: w.targetPrice, livePrice });
  }
  let total = 0;
  for (const [uid, alarms] of Object.entries(alarmsByUser)) {
    const email = userEmails[uid];
    if (email) { await sendAlarmMail(email, alarms, env.RESEND_API_KEY); total += alarms.length; }
  }
  return { checked: rows.length, alarms: total, timestamp: new Date().toISOString() };
}
