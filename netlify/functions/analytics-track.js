// BADSEED SOIL - Analytics Tracking Function
// Uses Netlify Blobs for production, in-memory for local dev

const { getStore } = require("@netlify/blobs");

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

// In-memory fallback for local dev
const localStore = {
  events: [],
  stats: {}
};

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

// Check if running in production (Netlify)
function isProduction() {
  return process.env.NETLIFY === 'true' || process.env.CONTEXT === 'production' || process.env.CONTEXT === 'deploy-preview';
}

exports.handler = async function(event, context) {
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { event: eventType, page, card, data, sessionId, timestamp } = body;

    // Validate event type
    if (!eventType || !VALID_EVENTS.includes(eventType)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid event type' })
      };
    }

    // Get client info from headers
    const clientHeaders = event.headers || {};
    const clientInfo = {
      ip: clientHeaders['x-forwarded-for']?.split(',')[0]?.trim() || clientHeaders['client-ip'] || 'unknown',
      userAgent: clientHeaders['user-agent'] || 'unknown',
      referer: clientHeaders['referer'] || 'direct',
      country: clientHeaders['x-country'] || clientHeaders['x-nf-client-connection-ip'] ? 'detected' : 'unknown'
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

    if (isProduction()) {
      // PRODUCTION: Use Netlify Blobs
      const store = getStore('soil-analytics');

      // Store individual event
      const eventKey = `events/${today}/${hour}/${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      await store.setJSON(eventKey, eventRecord);

      // Update aggregated stats
      await updateProductionStats(store, eventRecord, today);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, mode: 'production', eventKey })
      };

    } else {
      // LOCAL DEV: Use in-memory storage
      localStore.events.push(eventRecord);

      if (localStore.events.length > 1000) {
        localStore.events = localStore.events.slice(-1000);
      }

      if (!localStore.stats[today]) {
        localStore.stats[today] = {
          date: today,
          pageViews: 0,
          uniqueVisitors: [],
          cardHovers: { voice: 0, value: 0, agent: 0 },
          cardClicks: { voice: 0, value: 0, agent: 0 },
          cardHoverTime: { voice: 0, value: 0, agent: 0 },
          sessions: 0,
          totalSessionDuration: 0,
          countries: {},
          referers: {},
          hourlyActivity: Array(24).fill(0)
        };
      }

      const stats = localStore.stats[today];

      switch (eventType) {
        case 'page_view':
          stats.pageViews++;
          if (!stats.uniqueVisitors.includes(visitorHash)) {
            stats.uniqueVisitors.push(visitorHash);
          }
          break;
        case 'session_start':
          stats.sessions++;
          break;
        case 'card_hover_start':
          if (card && stats.cardHovers[card] !== undefined) {
            stats.cardHovers[card]++;
          }
          break;
        case 'card_hover_end':
          if (card && data?.duration && stats.cardHoverTime[card] !== undefined) {
            stats.cardHoverTime[card] += data.duration;
          }
          break;
        case 'card_click':
          if (card && stats.cardClicks[card] !== undefined) {
            stats.cardClicks[card]++;
          }
          break;
        case 'session_end':
          if (data?.duration) {
            stats.totalSessionDuration += data.duration;
          }
          break;
      }

      if (clientInfo.country && clientInfo.country !== 'unknown') {
        stats.countries[clientInfo.country] = (stats.countries[clientInfo.country] || 0) + 1;
      }

      const eventHour = new Date(timestamp || Date.now()).getHours();
      stats.hourlyActivity[eventHour]++;

      global.soilAnalyticsStore = localStore;

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, mode: 'local', stored: localStore.events.length })
      };
    }

  } catch (error) {
    console.error('Analytics error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal error', details: error.message })
    };
  }
};

// Update production stats in Netlify Blobs
async function updateProductionStats(store, event, date) {
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
  const hour = new Date(event.timestamp).getHours();
  stats.hourlyActivity[hour]++;

  stats.lastUpdated = Date.now();

  await store.setJSON(statsKey, stats);
}
