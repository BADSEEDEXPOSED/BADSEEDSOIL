// BADSEED SOIL - Analytics Retrieval Function
// Uses Netlify Blobs for production, in-memory for local dev

const { getStore } = require("@netlify/blobs");

// Check if running in production (Netlify)
function isProduction() {
  const netlifyIndicators = [
    process.env.NETLIFY,
    process.env.CONTEXT,
    process.env.DEPLOY_URL,
    process.env.URL,
    process.env.SITE_ID
  ];
  return netlifyIndicators.some(v => v !== undefined && v !== '');
}

exports.handler = async function(event, context) {
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const params = event.queryStringParameters || {};
    const range = params.range || '7d';
    const type = params.type || 'summary';

    if (isProduction()) {
      // PRODUCTION: Use Netlify Blobs with siteID and token from env
      const siteID = process.env.SITE_ID;
      const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.BLOB_TOKEN;

      if (siteID && token) {
        const store = getStore('soil-analytics', { siteID, token });

        if (type === 'summary') {
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify(await getProductionSummary(store, range))
          };
        }

        if (type === 'realtime') {
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify(await getProductionRealtime(store))
          };
        }

        if (type === 'events') {
          const limit = parseInt(params.limit || '100');
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify(await getProductionEvents(store, limit))
          };
        }
      } else {
        // No blob credentials - return empty data
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            range,
            generated: Date.now(),
            mode: 'production-no-storage',
            note: 'Blobs not configured - add NETLIFY_BLOBS_TOKEN env var',
            overview: { pageViews: 0, uniqueVisitors: 0, sessions: 0, avgSessionDuration: '0s', bounceRate: 0 },
            cardEngagement: {
              voice: { hovers: 0, clicks: 0, avgHoverTime: 0, clickRate: 0, share: 0 },
              value: { hovers: 0, clicks: 0, avgHoverTime: 0, clickRate: 0, share: 0 },
              agent: { hovers: 0, clicks: 0, avgHoverTime: 0, clickRate: 0, share: 0 }
            },
            topCountries: [],
            topReferers: [],
            hourlyActivity: Array(24).fill(0),
            peakHour: 0,
            dailyStats: []
          })
        };
      }

    } else {
      // LOCAL DEV: Use in-memory storage
      const localStore = global.soilAnalyticsStore || { events: [], stats: {} };

      if (type === 'summary') {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify(getLocalSummary(localStore, range))
        };
      }

      if (type === 'realtime') {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify(getLocalRealtime(localStore))
        };
      }

      if (type === 'events') {
        const limit = parseInt(params.limit || '100');
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify(getLocalEvents(localStore, limit))
        };
      }
    }

    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid type' })
    };

  } catch (error) {
    console.error('Analytics get error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal error', details: error.message })
    };
  }
};

// ============ PRODUCTION FUNCTIONS (Netlify Blobs) ============

async function getProductionSummary(store, range) {
  const days = range === '1d' ? 1 : range === '7d' ? 7 : 30;
  const dates = [];

  for (let i = 0; i < days; i++) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    dates.push(date.toISOString().split('T')[0]);
  }

  let totals = {
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

  const dailyStats = [];

  for (const date of dates) {
    try {
      const stats = await store.get(`stats/${date}`, { type: 'json' });
      if (stats) {
        dailyStats.push({ date, ...stats });

        totals.pageViews += stats.pageViews || 0;
        totals.sessions += stats.sessions || 0;
        totals.totalSessionDuration += stats.totalSessionDuration || 0;

        if (stats.uniqueVisitors) {
          stats.uniqueVisitors.forEach(v => {
            if (!totals.uniqueVisitors.includes(v)) {
              totals.uniqueVisitors.push(v);
            }
          });
        }

        ['voice', 'value', 'agent'].forEach(card => {
          totals.cardHovers[card] += stats.cardHovers?.[card] || 0;
          totals.cardClicks[card] += stats.cardClicks?.[card] || 0;
          totals.cardHoverTime[card] += stats.cardHoverTime?.[card] || 0;
        });

        Object.entries(stats.countries || {}).forEach(([country, count]) => {
          totals.countries[country] = (totals.countries[country] || 0) + count;
        });

        Object.entries(stats.referers || {}).forEach(([ref, count]) => {
          totals.referers[ref] = (totals.referers[ref] || 0) + count;
        });

        (stats.hourlyActivity || []).forEach((count, hour) => {
          totals.hourlyActivity[hour] += count;
        });
      }
    } catch (e) {
      // Date not found, skip
    }
  }

  const result = formatSummaryResponse(totals, dailyStats, range);
  result.mode = 'production-blobs';
  return result;
}

async function getProductionRealtime(store) {
  const now = Date.now();
  const thirtyMinutesAgo = now - (30 * 60 * 1000);
  const fiveMinutesAgo = now - (5 * 60 * 1000);

  const today = new Date().toISOString().split('T')[0];
  const hour = new Date().getHours().toString().padStart(2, '0');
  const prevHour = ((parseInt(hour) - 1 + 24) % 24).toString().padStart(2, '0');

  const recentEvents = [];

  for (const h of [prevHour, hour]) {
    try {
      const { blobs } = await store.list({ prefix: `events/${today}/${h}/` });
      for (const blob of blobs.slice(-50)) {
        const event = await store.get(blob.key, { type: 'json' });
        if (event && event.timestamp >= thirtyMinutesAgo) {
          recentEvents.push(event);
        }
      }
    } catch (e) {
      // Continue
    }
  }

  const result = formatRealtimeResponse(recentEvents, now, fiveMinutesAgo);
  result.mode = 'production-blobs';
  return result;
}

async function getProductionEvents(store, limit) {
  const events = [];
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  for (const date of [today, yesterday]) {
    for (let h = 23; h >= 0 && events.length < limit; h--) {
      const hour = h.toString().padStart(2, '0');
      try {
        const { blobs } = await store.list({ prefix: `events/${date}/${hour}/` });
        for (const blob of blobs.reverse()) {
          if (events.length >= limit) break;
          const event = await store.get(blob.key, { type: 'json' });
          if (event) events.push(event);
        }
      } catch (e) {
        // Continue
      }
    }
    if (events.length >= limit) break;
  }

  return {
    generated: Date.now(),
    mode: 'production-blobs',
    count: events.length,
    events: events.sort((a, b) => b.timestamp - a.timestamp)
  };
}

// ============ LOCAL DEV FUNCTIONS (In-Memory) ============

function getLocalSummary(store, range) {
  const days = range === '1d' ? 1 : range === '7d' ? 7 : 30;
  const dates = [];

  for (let i = 0; i < days; i++) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    dates.push(date.toISOString().split('T')[0]);
  }

  let totals = {
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

  const dailyStats = [];

  for (const date of dates) {
    const stats = store.stats[date];
    if (stats) {
      dailyStats.push({ date, ...stats });

      totals.pageViews += stats.pageViews || 0;
      totals.sessions += stats.sessions || 0;
      totals.totalSessionDuration += stats.totalSessionDuration || 0;

      if (stats.uniqueVisitors) {
        stats.uniqueVisitors.forEach(v => {
          if (!totals.uniqueVisitors.includes(v)) {
            totals.uniqueVisitors.push(v);
          }
        });
      }

      ['voice', 'value', 'agent'].forEach(card => {
        totals.cardHovers[card] += stats.cardHovers?.[card] || 0;
        totals.cardClicks[card] += stats.cardClicks?.[card] || 0;
        totals.cardHoverTime[card] += stats.cardHoverTime?.[card] || 0;
      });

      Object.entries(stats.countries || {}).forEach(([country, count]) => {
        totals.countries[country] = (totals.countries[country] || 0) + count;
      });

      Object.entries(stats.referers || {}).forEach(([ref, count]) => {
        totals.referers[ref] = (totals.referers[ref] || 0) + count;
      });

      (stats.hourlyActivity || []).forEach((count, hour) => {
        totals.hourlyActivity[hour] += count;
      });
    }
  }

  const result = formatSummaryResponse(totals, dailyStats, range);
  result.mode = 'local';
  return result;
}

function getLocalRealtime(store) {
  const now = Date.now();
  const thirtyMinutesAgo = now - (30 * 60 * 1000);
  const fiveMinutesAgo = now - (5 * 60 * 1000);

  const recentEvents = store.events.filter(e => e.timestamp >= thirtyMinutesAgo);
  const result = formatRealtimeResponse(recentEvents, now, fiveMinutesAgo);
  result.mode = 'local';
  return result;
}

function getLocalEvents(store, limit) {
  const events = store.events
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);

  return {
    generated: Date.now(),
    mode: 'local',
    count: events.length,
    events
  };
}

// ============ SHARED FORMATTERS ============

function formatSummaryResponse(totals, dailyStats, range) {
  const uniqueCount = totals.uniqueVisitors.length;
  const avgSessionDuration = totals.sessions > 0
    ? Math.round(totals.totalSessionDuration / totals.sessions / 1000)
    : 0;

  const totalHovers = totals.cardHovers.voice + totals.cardHovers.value + totals.cardHovers.agent;
  const totalClicks = totals.cardClicks.voice + totals.cardClicks.value + totals.cardClicks.agent;

  const cardEngagement = {};
  ['voice', 'value', 'agent'].forEach(card => {
    cardEngagement[card] = {
      hovers: totals.cardHovers[card],
      clicks: totals.cardClicks[card],
      avgHoverTime: totals.cardHovers[card] > 0
        ? Math.round(totals.cardHoverTime[card] / totals.cardHovers[card])
        : 0,
      clickRate: totals.cardHovers[card] > 0
        ? Math.round((totals.cardClicks[card] / totals.cardHovers[card]) * 100)
        : 0,
      share: totalHovers > 0
        ? Math.round((totals.cardHovers[card] / totalHovers) * 100)
        : 0
    };
  });

  const topCountries = Object.entries(totals.countries)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([country, count]) => ({ country, count }));

  const topReferers = Object.entries(totals.referers)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([referer, count]) => ({ referer, count }));

  const peakHour = totals.hourlyActivity.indexOf(Math.max(...totals.hourlyActivity));

  return {
    range,
    generated: Date.now(),
    overview: {
      pageViews: totals.pageViews,
      uniqueVisitors: uniqueCount,
      sessions: totals.sessions,
      avgSessionDuration: `${avgSessionDuration}s`,
      bounceRate: totals.sessions > 0 && totals.pageViews > 0
        ? Math.round((1 - (totalClicks / totals.pageViews)) * 100)
        : 0
    },
    cardEngagement,
    topCountries,
    topReferers,
    hourlyActivity: totals.hourlyActivity,
    peakHour,
    dailyStats: dailyStats.map(d => ({
      date: d.date,
      pageViews: d.pageViews || 0,
      uniqueVisitors: d.uniqueVisitors?.length || 0,
      sessions: d.sessions || 0
    }))
  };
}

function formatRealtimeResponse(recentEvents, now, fiveMinutesAgo) {
  const activeVisitors = new Set();
  const recentHovers = { voice: 0, value: 0, agent: 0 };
  const recentClicks = { voice: 0, value: 0, agent: 0 };
  let recentPageViews = 0;

  recentEvents.forEach(event => {
    if (event.timestamp >= fiveMinutesAgo) {
      activeVisitors.add(event.visitorHash);
    }
    if (event.event === 'page_view') recentPageViews++;
    if (event.event === 'card_hover_start' && event.card) {
      recentHovers[event.card]++;
    }
    if (event.event === 'card_click' && event.card) {
      recentClicks[event.card]++;
    }
  });

  return {
    generated: now,
    window: '30m',
    activeVisitors: activeVisitors.size,
    pageViews: recentPageViews,
    cardActivity: {
      voice: { hovers: recentHovers.voice, clicks: recentClicks.voice },
      value: { hovers: recentHovers.value, clicks: recentClicks.value },
      agent: { hovers: recentHovers.agent, clicks: recentClicks.agent }
    },
    eventStream: recentEvents
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 20)
      .map(e => ({
        event: e.event,
        card: e.card,
        timestamp: e.timestamp,
        country: e.client?.country
      }))
  };
}
