// BADSEED SOIL - Analytics Retrieval Function (ES Module / Netlify Functions v2)
import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers
    });
  }

  try {
    const url = new URL(req.url);
    const range = url.searchParams.get('range') || '7d';
    const type = url.searchParams.get('type') || 'summary';

    // Get the store - in Netlify Functions v2, context is automatically available
    const store = getStore('soil-analytics');

    if (type === 'summary') {
      const data = await getSummaryStats(store, range);
      return new Response(JSON.stringify(data), { status: 200, headers });
    }

    if (type === 'realtime') {
      const data = await getRealtimeStats(store);
      return new Response(JSON.stringify(data), { status: 200, headers });
    }

    if (type === 'events') {
      const limit = parseInt(url.searchParams.get('limit') || '100');
      const data = await getRecentEvents(store, limit);
      return new Response(JSON.stringify(data), { status: 200, headers });
    }

    return new Response(JSON.stringify({ error: 'Invalid type' }), {
      status: 400,
      headers
    });

  } catch (error) {
    console.error('Analytics get error:', error);
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

// Get summary statistics for a date range
async function getSummaryStats(store, range) {
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

  return formatSummaryResponse(totals, dailyStats, range);
}

// Get real-time stats (last 30 minutes)
async function getRealtimeStats(store) {
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
      for (const blob of (blobs || []).slice(-50)) {
        const event = await store.get(blob.key, { type: 'json' });
        if (event && event.timestamp >= thirtyMinutesAgo) {
          recentEvents.push(event);
        }
      }
    } catch (e) {
      // Continue
    }
  }

  return formatRealtimeResponse(recentEvents, now, fiveMinutesAgo);
}

// Get recent events
async function getRecentEvents(store, limit) {
  const events = [];
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  for (const date of [today, yesterday]) {
    for (let h = 23; h >= 0 && events.length < limit; h--) {
      const hour = h.toString().padStart(2, '0');
      try {
        const { blobs } = await store.list({ prefix: `events/${date}/${hour}/` });
        for (const blob of (blobs || []).reverse()) {
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

// Format summary response
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
    mode: 'production-blobs',
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

// Format realtime response
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
    mode: 'production-blobs',
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
