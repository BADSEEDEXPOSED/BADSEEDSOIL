// BADSEED SOIL - Analytics Tracking Function (ES Module / Netlify Functions v2)
import { getStore } from "@netlify/blobs";

// Event types we track
const VALID_EVENTS = [
  'page_view',
  'page_exit',
  'page_hidden',
  'page_visible',
  'card_hover_start',
  'card_hover_end',
  'card_click',
  'iframe_hover_start',
  'iframe_hover_end',
  'iframe_ready',
  'session_start',
  'session_end'
];

// Generate a simple hash for session grouping
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

export default async (req, context) => {
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers
    });
  }

  try {
    const body = await req.json();
    const { event: eventType, page, card, data, sessionId, timestamp } = body;

    // Validate event type
    if (!eventType || !VALID_EVENTS.includes(eventType)) {
      return new Response(JSON.stringify({ error: 'Invalid event type' }), {
        status: 400,
        headers
      });
    }

    // Get client info from headers
    const clientInfo = {
      ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown',
      userAgent: req.headers.get('user-agent') || 'unknown',
      referer: req.headers.get('referer') || 'direct',
      country: req.headers.get('x-country') || 'unknown'
    };

    // Create visitor fingerprint
    const visitorHash = hashString(clientInfo.ip + clientInfo.userAgent.substring(0, 50));

    // Build event record
    const eventRecord = {
      event: eventType,
      page: page || 'gateway',
      card: card || null,
      data: data || {},
      sessionId: sessionId || null,
      visitorHash,
      timestamp: timestamp || Date.now(),
      serverTime: Date.now(),
      client: {
        country: clientInfo.country,
        referer: clientInfo.referer
      }
    };

    const today = new Date().toISOString().split('T')[0];
    const hour = new Date().getHours().toString().padStart(2, '0');

    // Get the store - in Netlify Functions v2, context is automatically available
    const store = getStore('soil-analytics');

    // Store individual event
    const eventKey = `events/${today}/${hour}/${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    await store.setJSON(eventKey, eventRecord);

    // Update aggregated stats
    await updateStats(store, eventRecord, today);

    return new Response(JSON.stringify({
      success: true,
      mode: 'production-blobs',
      eventKey
    }), {
      status: 200,
      headers
    });

  } catch (error) {
    console.error('Analytics error:', error);
    return new Response(JSON.stringify({
      error: 'Internal error',
      details: error.message,
      stack: error.stack
    }), {
      status: 500,
      headers
    });
  }
};

// Update aggregated statistics
async function updateStats(store, event, date) {
  const statsKey = `stats/${date}`;

  let stats;
  try {
    stats = await store.get(statsKey, { type: 'json' });
  } catch {
    stats = null;
  }

  if (!stats) {
    stats = {
      date,
      pageViews: 0,
      uniqueVisitors: [],
      cardHovers: { voice: 0, value: 0, agent: 0 },
      cardClicks: { voice: 0, value: 0, agent: 0 },
      cardHoverTime: { voice: 0, value: 0, agent: 0 },
      sessions: 0,
      totalSessionDuration: 0,
      countries: {},
      referers: {},
      hourlyActivity: Array(24).fill(0),
      lastUpdated: Date.now()
    };
  }

  // Update based on event type
  switch (event.event) {
    case 'page_view':
      stats.pageViews++;
      if (!stats.uniqueVisitors.includes(event.visitorHash)) {
        stats.uniqueVisitors.push(event.visitorHash);
      }
      break;
    case 'session_start':
      stats.sessions++;
      break;
    case 'card_hover_start':
      if (event.card && stats.cardHovers[event.card] !== undefined) {
        stats.cardHovers[event.card]++;
      }
      break;
    case 'card_hover_end':
      if (event.card && event.data?.duration && stats.cardHoverTime[event.card] !== undefined) {
        stats.cardHoverTime[event.card] += event.data.duration;
      }
      break;
    case 'card_click':
      if (event.card && stats.cardClicks[event.card] !== undefined) {
        stats.cardClicks[event.card]++;
      }
      break;
    case 'session_end':
      if (event.data?.duration) {
        stats.totalSessionDuration += event.data.duration;
      }
      break;
  }

  // Update country stats
  if (event.client?.country && event.client.country !== 'unknown') {
    stats.countries[event.client.country] = (stats.countries[event.client.country] || 0) + 1;
  }

  // Update referer stats
  if (event.client?.referer && event.client.referer !== 'direct') {
    try {
      const refHost = new URL(event.client.referer).hostname;
      stats.referers[refHost] = (stats.referers[refHost] || 0) + 1;
    } catch {}
  }

  // Update hourly activity
  const eventHour = new Date(event.timestamp).getHours();
  stats.hourlyActivity[eventHour]++;

  stats.lastUpdated = Date.now();

  await store.setJSON(statsKey, stats);
}
