// Cloudflare Worker: Vaultr Prisalarm
// Cron trigger: hver 6. time
// Kræver Environment Variables i Cloudflare Dashboard:
//   RESEND_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, CM_RAPIDAPI_KEY

const EUR_TO_DKK = 7.46

async function fetchCMPrice(productName, setName, cmApiKey) {
  if (!cmApiKey) return null
  try {
    const query = `${productName} ${setName}`.trim()
    const url = `https://cardmarket-api-tcg.p.rapidapi.com/pokemon/cards/search?name=${encodeURIComponent(query)}&language=en`
    const res = await fetch(url, {
      headers: {
        'X-RapidAPI-Key': cmApiKey,
        'X-RapidAPI-Host': 'cardmarket-api-tcg.p.rapidapi.com',
      }
    })
    if (!res.ok) return null
    const json = await res.json()
    const card = json?.data?.[0]
    if (!card) return null
    const prices = card.prices?.cardmarket
    const liveEUR = prices?.lowest_near_mint_DE || prices?.lowest_near_mint_FR || prices?.trend_price || null
    return liveEUR ? Math.round(parseFloat(liveEUR) * EUR_TO_DKK) : null
  } catch (e) {
    console.error('CM API fejl:', e)
    return null
  }
}

async function sendAlarmMail(userEmail, alarms, resendApiKey) {
  const itemRows = alarms.map(a => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;font-weight:600;color:#e8e8e8">${a.name}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;color:#aaa">${a.set}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;color:#f0b429">${a.livePrice} DKK</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;color:#0c7a85">${a.targetPrice} DKK</td>
    </tr>`).join('')

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="background:#0f0f0f;color:#e8e8e8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:0">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px">
    <div style="margin-bottom:28px">
      <span style="font-size:1.4rem;font-weight:800;letter-spacing:-.02em">⚡ Vaultr</span>
      <span style="font-size:.75rem;color:#666;margin-left:8px">Prisalarm</span>
    </div>
    <div style="background:#161616;border:1px solid #2a2a2a;border-radius:12px;padding:24px;margin-bottom:20px">
      <h2 style="margin:0 0 8px;font-size:1.1rem;color:#fff">🔔 ${alarms.length === 1 ? '1 kort har' : alarms.length + ' kort har'} ramt din målpris</h2>
      <p style="margin:0 0 20px;color:#888;font-size:.85rem">Live Cardmarket-prisen er nu lig med eller under din målpris.</p>
      <table style="width:100%;border-collapse:collapse;font-size:.85rem">
        <thead><tr style="color:#666;font-size:.72rem;text-transform:uppercase;letter-spacing:.04em">
          <th style="padding:6px 12px;text-align:left;border-bottom:1px solid #2a2a2a">Kort</th>
          <th style="padding:6px 12px;text-align:left;border-bottom:1px solid #2a2a2a">Sæt</th>
          <th style="padding:6px 12px;text-align:left;border-bottom:1px solid #2a2a2a">Live pris</th>
          <th style="padding:6px 12px;text-align:left;border-bottom:1px solid #2a2a2a">Din målpris</th>
        </tr></thead>
        <tbody>${itemRows}</tbody>
      </table>
    </div>
    <a href="https://pokemon-samling.mka-831.workers.dev"
       style="display:inline-block;background:#f0b429;color:#000;font-weight:700;font-size:.85rem;padding:10px 22px;border-radius:8px;text-decoration:none;margin-bottom:24px">
      Åbn Vaultr →
    </a>
    <p style="color:#444;font-size:.72rem;margin:0">
      Du modtager denne mail fordi du følger disse kort i Vaultr Watchlist.<br>
      Priser tjekkes automatisk hver 6. time. Afsender: Vaultr Prisalarm
    </p>
  </div>
</body></html>`

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Vaultr Prisalarm <onboarding@resend.dev>',
      to: [userEmail],
      subject: alarms.length === 1
        ? `🔔 ${alarms[0].name} har ramt målpris — Vaultr`
        : `🔔 ${alarms.length} kort har ramt målpris — Vaultr`,
      html,
    })
  })
  const body = await res.json()
  if (!res.ok) throw new Error('Resend: ' + JSON.stringify(body))
  return body
}

export default {
  // HTTP endpoint (til manuelt test)
  async fetch(request, env) {
    if (request.method !== 'POST' && !request.url.includes('?run')) {
      return new Response('Vaultr Price Alert Worker. POST to trigger or add ?run', { status: 200 })
    }
    const result = await runPriceCheck(env)
    return new Response(JSON.stringify(result, null, 2), {
      headers: { 'Content-Type': 'application/json' }
    })
  },

  // Cron trigger
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runPriceCheck(env))
  }
}

async function runPriceCheck(env) {
  const SUPABASE_URL     = env.SUPABASE_URL
  const SUPABASE_KEY     = env.SUPABASE_SERVICE_KEY
  const RESEND_KEY       = env.RESEND_API_KEY
  const CM_KEY           = env.CM_RAPIDAPI_KEY

  // Hent alle watchlist items + user emails fra Supabase
  const res = await fetch(`${SUPABASE_URL}/rest/v1/watchlist_items?select=id,user_id,data`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    }
  })

  if (!res.ok) {
    const err = await res.text()
    return { error: 'Supabase fetch fejl: ' + err }
  }

  const rows = await res.json()
  if (!rows.length) return { checked: 0, alarms: 0 }

  // Hent user emails
  const userIds = [...new Set(rows.map(r => r.user_id))]
  const userEmails = {}
  for (const uid of userIds) {
    const ur = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${uid}`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      }
    })
    if (ur.ok) {
      const u = await ur.json()
      userEmails[uid] = u.email
    }
  }

  // Grupper per user og tjek priser
  const alarmsByUser = {}
  for (const row of rows) {
    const w = row.data
    if (!w.targetPrice || w.targetPrice <= 0) continue
    const livePrice = await fetchCMPrice(w.productName, w.set, CM_KEY)
    if (!livePrice) continue
    if (livePrice <= w.targetPrice) {
      if (!alarmsByUser[row.user_id]) alarmsByUser[row.user_id] = []
      alarmsByUser[row.user_id].push({
        name: w.productName,
        set: w.set,
        targetPrice: w.targetPrice,
        livePrice,
      })
    }
  }

  let totalAlarms = 0
  const mailsSent = []
  for (const [uid, alarms] of Object.entries(alarmsByUser)) {
    const email = userEmails[uid]
    if (!email) continue
    try {
      await sendAlarmMail(email, alarms, RESEND_KEY)
      totalAlarms += alarms.length
      mailsSent.push({ email, alarms: alarms.length })
      console.log(`✅ Mail sendt til ${email}: ${alarms.length} alarmer`)
    } catch (e) {
      console.error(`❌ Mail fejl for ${email}:`, e.message)
    }
  }

  return {
    checked: rows.length,
    alarms: totalAlarms,
    mailsSent,
    timestamp: new Date().toISOString()
  }
}
