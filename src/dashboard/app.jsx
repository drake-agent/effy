/* global React, ReactDOM, Recharts */
const { useState, useEffect } = React;
const {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} = Recharts;

// ═══════════════════════════════════════════════════════
// Effy Mission Control v3.6.2
// Apple HIG-inspired: 여백, 라운드, 블러, 절제된 색상
// ═══════════════════════════════════════════════════════

// ─── Palette ─────────────────────────────────────────

const C = {
  bg:     '#f5f5f7',
  card:   '#ffffff',
  border: 'rgba(0,0,0,0.06)',
  text1:  '#1d1d1f',
  text2:  '#6e6e73',
  text3:  '#aeaeb2',
  accent: '#0071e3',
  green:  '#34c759',
  orange: '#ff9f0a',
  red:    '#ff3b30',
  purple: '#af52de',
  pink:   '#ff2d55',
  cyan:   '#5ac8fa',
  indigo: '#5856d6',
  teal:   '#30d158',
};

const AGENT_MAP = {
  general:   { icon: '💬', color: '#0071e3' },
  code:      { icon: '💻', color: '#5856d6' },
  ops:       { icon: '⚙️', color: '#ff2d55' },
  knowledge: { icon: '📚', color: '#ff9f0a' },
  strategy:  { icon: '🎯', color: '#34c759' },
};

const TIER_META = {
  tier1: { label: 'Haiku',   color: '#5ac8fa' },
  tier2: { label: 'Sonnet',  color: '#5856d6' },
  tier3: { label: 'Opus',    color: '#af52de' },
  tier4: { label: 'Opus ET', color: '#ff3b30' },
};

// ─── Dashboard Data ──────────────────────────────────

const EMPTY_DASHBOARD = {
  overview: {
    requests: 0,
    cost: { current: 0, budget: 0, percent: 0 },
    sessions: { active: 0, total: 0 },
    latency: { avg: 0 },
    contextHub: { searches: 0 },
  },
  agents: { agents: [] },
  cost: { history: [], tierDistribution: [] },
  activity: { events: [] },
  sessions: { sessions: [] },
  tools: { tools: [] },
  memory: { working: 0, episodic: 0, semantic: 0, entity: 0, history: [] },
  system: {
    circuitBreaker: { status: 'closed', detail: 'No data' },
    coalescer: { status: 'inactive', detail: 'No data' },
    budgetGate: { status: 'ok', detail: 'No data' },
    rateLimit: { status: 'ok', detail: 'No data' },
  },
};

function getDashboardLocale() {
  return globalThis?.navigator?.language || Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
}

function formatMonthLabel(date, locale) {
  try {
    return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(date);
  } catch {
    return date.toISOString().slice(0, 7);
  }
}

function normalizeSnapshot(snapshot) {
  return {
    overview: snapshot?.overview || EMPTY_DASHBOARD.overview,
    agents: snapshot?.agents || EMPTY_DASHBOARD.agents,
    cost: snapshot?.cost || EMPTY_DASHBOARD.cost,
    activity: snapshot?.activity || EMPTY_DASHBOARD.activity,
    sessions: snapshot?.sessions || EMPTY_DASHBOARD.sessions,
    tools: snapshot?.tools || EMPTY_DASHBOARD.tools,
    memory: snapshot?.memory || EMPTY_DASHBOARD.memory,
    system: snapshot?.system || EMPTY_DASHBOARD.system,
    generatedAt: snapshot?.generatedAt || null,
  };
}

function eventKey(event) {
  return [event?.time, event?.agent, event?.detail, event?.tier].join('|');
}

function mergeEvents(primary = [], secondary = []) {
  const merged = [];
  const seen = new Set();

  for (const event of [...primary, ...secondary]) {
    if (!event) continue;
    const key = eventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(event);
    if (merged.length >= 50) break;
  }

  return merged;
}

function useDashboardSnapshot(interval = 10000) {
  const [state, setState] = useState({
    data: normalizeSnapshot(null),
    loading: true,
    error: null,
    lastUpdated: null,
  });

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const response = await fetch('/dashboard/api/snapshot?limit=20', {
          headers: { Accept: 'application/json' },
        });

        if (!response.ok) {
          throw new Error(`Dashboard API responded with ${response.status}`);
        }

        const snapshot = normalizeSnapshot(await response.json());
        if (!active) return;

        setState({
          data: snapshot,
          loading: false,
          error: null,
          lastUpdated: snapshot.generatedAt || new Date().toISOString(),
        });
      } catch (error) {
        if (!active) return;
        setState(prev => ({
          ...prev,
          loading: false,
          error: error?.message || 'Unable to load dashboard data',
        }));
      }
    }

    load();
    const timer = setInterval(load, interval);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [interval]);

  return state;
}

function useActivityStream(limit = 50) {
  const [events, setEvents] = useState([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (typeof EventSource === 'undefined') {
      return undefined;
    }

    const source = new EventSource('/dashboard/api/events');
    source.addEventListener('connected', () => setConnected(true));
    source.addEventListener('activity', (event) => {
      try {
        const nextEvent = JSON.parse(event.data);
        setEvents(prev => mergeEvents([nextEvent], prev).slice(0, limit));
      } catch {}
    });
    source.onerror = () => setConnected(false);

    return () => {
      setConnected(false);
      source.close();
    };
  }, [limit]);

  return { events, connected };
}

// ─── Primitives ──────────────────────────────────────

const cardStyle = {
  background: C.card, borderRadius: 16,
  border: `1px solid ${C.border}`,
  boxShadow: '0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.02)',
};

const tipStyle = {
  background: 'rgba(255,255,255,0.96)', backdropFilter: 'blur(20px)',
  border: `1px solid ${C.border}`, borderRadius: 10,
  padding: '8px 12px', boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
  fontSize: 12, color: C.text1,
};

function Pill({ children, color = C.accent }) {
  return React.createElement('span', {
    style: {
      display: 'inline-flex', alignItems: 'center', padding: '2px 9px',
      borderRadius: 100, fontSize: 11, fontWeight: 500,
      backgroundColor: `${color}14`, color,
    }
  }, children);
}

function Section({ title, trailing, children, noPad }) {
  return React.createElement('div', { style: cardStyle },
    React.createElement('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 22px 0' }
    },
      React.createElement('span', { style: { fontSize: 15, fontWeight: 600, color: C.text1 } }, title),
      trailing,
    ),
    React.createElement('div', { style: noPad ? {} : { padding: '14px 22px 18px' } }, children),
  );
}

// ─── KPI Card ────────────────────────────────────────

function Stat({ label, value, sub, trend }) {
  return React.createElement('div', { style: { ...cardStyle, padding: '20px 22px' } },
    React.createElement('div', { style: { fontSize: 12, color: C.text3, fontWeight: 500, marginBottom: 6 } }, label),
    React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
      React.createElement('span', {
        style: { fontSize: 28, fontWeight: 600, color: C.text1, letterSpacing: '-0.03em' }
      }, value),
      trend !== undefined && React.createElement('span', {
        style: { fontSize: 12, fontWeight: 600, color: trend >= 0 ? C.green : C.red }
      }, `${trend >= 0 ? '+' : ''}${trend}%`),
    ),
    sub && React.createElement('div', { style: { fontSize: 11, color: C.text3, marginTop: 3 } }, sub),
  );
}

// ─── Agent Card ──────────────────────────────────────

function AgentCard({ a }) {
  const meta = AGENT_MAP[a.id] || { icon: '🤖', color: C.accent };
  const tier = TIER_META[a.tier] || TIER_META.tier1;
  const alive = a.status === 'active';

  return React.createElement('div', {
    style: { ...cardStyle, padding: '18px 20px', borderLeft: `3px solid ${meta.color}` }
  },
    // Header
    React.createElement('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }
    },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
        React.createElement('span', { style: { fontSize: 22 } }, meta.icon),
        React.createElement('div', null,
          React.createElement('div', { style: { fontSize: 14, fontWeight: 600, color: C.text1 } }, a.name),
          React.createElement('div', { style: { fontSize: 11, color: C.text3 } }, tier.label),
        ),
      ),
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 5 } },
        React.createElement('div', {
          style: {
            width: 7, height: 7, borderRadius: '50%',
            backgroundColor: alive ? C.green : C.text3,
            boxShadow: alive ? `0 0 6px ${C.green}88` : 'none',
          }
        }),
        React.createElement('span', {
          style: { fontSize: 11, fontWeight: 500, color: alive ? C.green : C.text3 }
        }, a.status),
      ),
    ),
    // Stats
    React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between' } },
      React.createElement('div', null,
        React.createElement('div', {
          style: { fontSize: 10, color: C.text3, textTransform: 'uppercase', letterSpacing: '0.04em' }
        }, 'Requests'),
        React.createElement('div', {
          style: { fontSize: 18, fontWeight: 600, color: C.text1, marginTop: 2 }
        }, (a.requests || 0).toLocaleString()),
      ),
      React.createElement('div', { style: { textAlign: 'right' } },
        React.createElement('div', {
          style: { fontSize: 10, color: C.text3, textTransform: 'uppercase', letterSpacing: '0.04em' }
        }, 'Latency'),
        React.createElement('div', {
          style: { fontSize: 18, fontWeight: 600, marginTop: 2, color: a.latency > 5 ? C.orange : C.green }
        }, `${a.latency}s`),
      ),
    ),
  );
}

// ─── Activity Row ────────────────────────────────────

function FeedRow({ f }) {
  const color = AGENT_MAP[f.agent]?.color || C.accent;
  const tierNum = f.tier?.replace('T', '') || '1';
  const tierColor = TIER_META[`tier${tierNum}`]?.color || C.text3;

  return React.createElement('div', {
    style: {
      display: 'flex', alignItems: 'flex-start', gap: 12,
      padding: '10px 22px', borderBottom: `1px solid ${C.border}`,
    }
  },
    React.createElement('span', {
      style: { fontSize: 11, fontFamily: 'SF Mono, Menlo, monospace', color: C.text3, minWidth: 36, paddingTop: 2 }
    }, f.time),
    React.createElement('span', { style: { fontSize: 16, lineHeight: 1 } }, f.icon),
    React.createElement('div', { style: { flex: 1, minWidth: 0 } },
      React.createElement('div', { style: { fontSize: 13, color: C.text1, lineHeight: 1.5 } }, f.detail),
      React.createElement('div', { style: { display: 'flex', gap: 6, marginTop: 3 } },
        React.createElement(Pill, { color }, f.agent),
        React.createElement(Pill, { color: tierColor }, f.tier),
      ),
    ),
  );
}

// ─── System Row ──────────────────────────────────────

function SystemRow({ label, detail, ok }) {
  const color = ok ? C.green : C.orange;
  return React.createElement('div', {
    style: {
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '10px 0', borderBottom: `1px solid ${C.border}`,
    }
  },
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      React.createElement('div', {
        style: { width: 6, height: 6, borderRadius: '50%', backgroundColor: color }
      }),
      React.createElement('span', { style: { fontSize: 13, color: C.text1, fontWeight: 500 } }, label),
    ),
    React.createElement('span', { style: { fontSize: 12, color: C.text2 } }, detail),
  );
}

// ─── Mini Stat Box ───────────────────────────────────

function MiniStat({ value, label, color }) {
  return React.createElement('div', {
    style: { textAlign: 'center', padding: 10, borderRadius: 10, backgroundColor: `${color}0a` }
  },
    React.createElement('div', { style: { fontSize: 20, fontWeight: 700, color } }, value),
    React.createElement('div', {
      style: { fontSize: 10, color: C.text3, marginTop: 2, textTransform: 'uppercase', letterSpacing: '0.04em' }
    }, label),
  );
}

function IconStat({ value, label, icon, color }) {
  return React.createElement('div', {
    style: {
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '8px 10px', borderRadius: 10, backgroundColor: `${color}0a`,
    }
  },
    React.createElement('span', { style: { fontSize: 18 } }, icon),
    React.createElement('div', null,
      React.createElement('div', { style: { fontSize: 17, fontWeight: 700, color } }, value),
      React.createElement('div', { style: { fontSize: 9, color: C.text3, textTransform: 'uppercase' } }, label),
    ),
  );
}

// ─── Sessions Table ──────────────────────────────────

function SessionsTable({ sessions }) {
  const stColor = { active: C.green, idle: C.orange, done: C.text3 };
  const heads = ['Session', 'User', 'Agent', 'Msgs', 'Tokens', 'Cost', 'Time', 'Status'];

  return React.createElement('div', { style: { overflowX: 'auto' } },
    React.createElement('table', { style: { width: '100%', borderCollapse: 'collapse' } },
      React.createElement('thead', null,
        React.createElement('tr', null,
          heads.map(h => React.createElement('th', {
            key: h,
            style: {
              textAlign: 'left', padding: '10px 14px', fontSize: 10,
              fontWeight: 600, color: C.text3, textTransform: 'uppercase',
              letterSpacing: '0.06em', borderBottom: `1px solid ${C.border}`,
            },
          }, h)),
        ),
      ),
      React.createElement('tbody', null,
        sessions.map(s => {
          const sc = stColor[s.status] || C.text3;
          const ac = AGENT_MAP[s.agent]?.color || C.accent;
          return React.createElement('tr', { key: s.id, style: { borderBottom: `1px solid ${C.border}` } },
            React.createElement('td', { style: { padding: '11px 14px', fontFamily: 'SF Mono, monospace', fontSize: 12, color: C.accent } }, s.id),
            React.createElement('td', { style: { padding: '11px 14px', fontSize: 13, color: C.text1, fontWeight: 500 } }, s.user),
            React.createElement('td', { style: { padding: '11px 14px' } }, React.createElement(Pill, { color: ac }, s.agent)),
            React.createElement('td', { style: { padding: '11px 14px', fontSize: 13, color: C.text2, textAlign: 'center' } }, s.msgs),
            React.createElement('td', { style: { padding: '11px 14px', fontSize: 12, color: C.text2, fontFamily: 'SF Mono, monospace' } }, s.tokens),
            React.createElement('td', { style: { padding: '11px 14px', fontSize: 13, fontWeight: 600, color: C.text1, fontFamily: 'SF Mono, monospace' } }, s.cost),
            React.createElement('td', { style: { padding: '11px 14px', fontSize: 12, color: C.text3 } }, s.duration),
            React.createElement('td', { style: { padding: '11px 14px' } },
              React.createElement('span', {
                style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 500, color: sc }
              },
                React.createElement('span', { style: { width: 6, height: 6, borderRadius: '50%', backgroundColor: sc } }),
                s.status,
              ),
            ),
          );
        }),
      ),
    ),
  );
}

// ═══════════════════════════════════════════════════════
// Main Dashboard Component
// ═══════════════════════════════════════════════════════

function Dashboard() {
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  const locale = getDashboardLocale();
  const { data, loading, error, lastUpdated } = useDashboardSnapshot();
  const activityStream = useActivityStream();

  const overview = data.overview;
  const agentData = data.agents;
  const costInfo = data.cost;
  const sessData = data.sessions;
  const toolInfo = data.tools;
  const memInfo = data.memory;
  const sysInfo = data.system;
  const agents = agentData.agents || [];
  const activityEvents = mergeEvents(activityStream.events, data.activity?.events || []);
  const activeCount = agents.filter(a => a.status === 'active').length;
  const totalSessions = overview.sessions?.total || 0;
  const activeSessions = overview.sessions?.active || 0;
  const idleSessions = Math.max(totalSessions - activeSessions, 0);
  const lastUpdatedLabel = lastUpdated
    ? new Date(lastUpdated).toLocaleTimeString(locale, { hour12: false })
    : 'pending';
  const liveStateLabel = error ? 'Degraded' : (activityStream.connected ? 'Live' : 'Polling');
  const liveStateColor = error ? C.orange : (activityStream.connected ? C.green : C.accent);
  const toolCountLabel = toolInfo.tools?.length ? `Top ${Math.min(toolInfo.tools.length, 8)}` : 'No data';
  const monthLabel = formatMonthLabel(now, locale);

  // ─── Render ──────────────────────────────────────

  return React.createElement('div', { style: { minHeight: '100vh', backgroundColor: C.bg } },

    // ── Nav ──
    React.createElement('nav', {
      style: {
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '0 32px', height: 52,
        backgroundColor: 'rgba(255,255,255,0.72)', backdropFilter: 'saturate(180%) blur(20px)',
        borderBottom: `0.5px solid ${C.border}`,
        position: 'sticky', top: 0, zIndex: 50,
      }
    },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
        React.createElement('div', {
          style: {
            width: 28, height: 28, borderRadius: 8,
            background: 'linear-gradient(135deg, #0071e3, #5856d6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontSize: 14, fontWeight: 700,
          }
        }, 'E'),
        React.createElement('span', {
          style: { fontSize: 16, fontWeight: 600, color: C.text1, letterSpacing: '-0.01em' }
        }, 'Effy ',
          React.createElement('span', { style: { fontWeight: 400, color: C.text2 } }, 'Mission Control'),
        ),
      ),
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
        React.createElement(Pill, { color: liveStateColor }, liveStateLabel),
        React.createElement('span', {
          style: { fontSize: 12, color: C.text3, fontFamily: 'SF Mono, monospace', fontVariantNumeric: 'tabular-nums' }
        }, now.toLocaleTimeString(locale, { hour12: false })),
      ),
    ),

    error && React.createElement('div', {
      style: {
        maxWidth: 1280,
        margin: '14px auto 0',
        padding: '10px 14px',
        borderRadius: 12,
        backgroundColor: `${C.orange}12`,
        border: `1px solid ${C.orange}33`,
        color: C.text1,
        fontSize: 13,
      }
    }, `Dashboard API error: ${error}. Last successful snapshot ${lastUpdatedLabel}.`),

    // ── Content ──
    React.createElement('main', { style: { maxWidth: 1280, margin: '0 auto', padding: '24px 32px 48px' } },

      // Row 1 — KPIs
      React.createElement('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 14, marginBottom: 22 }
      },
        React.createElement(Stat, { label: 'Requests Today', value: Number(overview.requests || 0).toLocaleString(), sub: `${agents.length} agents tracked` }),
        React.createElement(Stat, { label: 'Monthly Cost', value: `$${overview.cost?.current || 0}`, sub: `of $${overview.cost?.budget || 0} budget` }),
        React.createElement(Stat, { label: 'Active Sessions', value: String(activeSessions), sub: `${idleSessions} idle` }),
        React.createElement(Stat, { label: 'Avg Latency', value: `${overview.latency?.avg || 0}s`, sub: `updated ${lastUpdatedLabel}` }),
        React.createElement(Stat, { label: 'API Doc Searches', value: String(overview.contextHub?.searches || 0), sub: loading ? 'loading snapshot' : 'Context Hub' }),
      ),

      // Row 2 — Agent Cards
      React.createElement('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 14, marginBottom: 22 }
      }, agents.map(a => React.createElement(AgentCard, { key: a.id, a }))),

      // Row 3 — Cost + Tier
      React.createElement('div', {
        style: { display: 'grid', gridTemplateColumns: '5fr 3fr', gap: 14, marginBottom: 22 }
      },
        React.createElement(Section, { title: 'Cost Trend', trailing: React.createElement(Pill, null, monthLabel) },
          React.createElement(ResponsiveContainer, { width: '100%', height: 200 },
            React.createElement(AreaChart, { data: costInfo.history || [] },
              React.createElement('defs', null,
                [['h','#5ac8fa'],['s','#5856d6'],['o','#af52de']].map(([k,c]) =>
                  React.createElement('linearGradient', { key: k, id: `g${k}`, x1: 0, y1: 0, x2: 0, y2: 1 },
                    React.createElement('stop', { offset: '0%', stopColor: c, stopOpacity: 0.15 }),
                    React.createElement('stop', { offset: '100%', stopColor: c, stopOpacity: 0 }),
                  )
                ),
              ),
              React.createElement(CartesianGrid, { stroke: C.border, strokeDasharray: '4', vertical: false }),
              React.createElement(XAxis, { dataKey: 'd', tick: { fontSize: 11, fill: C.text3 }, axisLine: false, tickLine: false }),
              React.createElement(YAxis, { tick: { fontSize: 11, fill: C.text3 }, axisLine: false, tickLine: false, tickFormatter: v => `$${v}` }),
              React.createElement(Tooltip, { contentStyle: tipStyle, formatter: v => [`$${Number(v).toFixed(1)}`] }),
              React.createElement(Area, { type: 'monotone', dataKey: 'haiku', stroke: '#5ac8fa', fill: 'url(#gh)', strokeWidth: 2, name: 'Haiku' }),
              React.createElement(Area, { type: 'monotone', dataKey: 'sonnet', stroke: '#5856d6', fill: 'url(#gs)', strokeWidth: 2, name: 'Sonnet' }),
              React.createElement(Area, { type: 'monotone', dataKey: 'opus', stroke: '#af52de', fill: 'url(#go)', strokeWidth: 2, name: 'Opus' }),
              React.createElement(Legend, { iconType: 'circle', iconSize: 6, wrapperStyle: { fontSize: 11, color: C.text3 } }),
            ),
          ),
        ),

        React.createElement(Section, { title: 'Tier Distribution' },
          React.createElement(ResponsiveContainer, { width: '100%', height: 200 },
            React.createElement(PieChart, null,
              React.createElement(Pie, {
                data: costInfo.tierDistribution || [], dataKey: 'value',
                cx: '50%', cy: '50%', innerRadius: 48, outerRadius: 72,
                paddingAngle: 3, stroke: 'none',
              },
                (costInfo.tierDistribution || []).map((e, i) =>
                  React.createElement(Cell, { key: i, fill: e.color })
                ),
              ),
              React.createElement(Tooltip, { contentStyle: tipStyle, formatter: (v, n) => [`${Number(v).toLocaleString()}`, n] }),
              React.createElement(Legend, { iconType: 'circle', iconSize: 6, wrapperStyle: { fontSize: 11, color: C.text3 } }),
            ),
          ),
        ),
      ),

      // Row 4 — Activity + Side
      React.createElement('div', {
        style: { display: 'grid', gridTemplateColumns: '5fr 3fr', gap: 14, marginBottom: 22 }
      },
        React.createElement(Section, {
          title: 'Activity',
          trailing: React.createElement(Pill, { color: activityStream.connected ? C.green : C.text3 }, activityStream.connected ? 'streaming' : 'snapshot'),
          noPad: true,
        },
          React.createElement('div', { style: { maxHeight: 380, overflowY: 'auto' } },
            activityEvents.length > 0
              ? activityEvents.map((f, i) => React.createElement(FeedRow, { key: eventKey(f) || i, f }))
              : React.createElement('div', {
                style: { padding: '20px 22px', color: C.text3, fontSize: 13 }
              }, 'No recent activity yet.'),
          ),
        ),

        React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
          // System
          React.createElement(Section, { title: 'System' },
            React.createElement('div', null,
              React.createElement(SystemRow, { label: 'Circuit Breaker', detail: sysInfo.circuitBreaker?.detail, ok: sysInfo.circuitBreaker?.status !== 'open' }),
              React.createElement(SystemRow, { label: 'Coalescer', detail: sysInfo.coalescer?.detail, ok: sysInfo.coalescer?.status === 'active' }),
              React.createElement(SystemRow, { label: 'Budget Gate', detail: sysInfo.budgetGate?.detail, ok: sysInfo.budgetGate?.status === 'ok' }),
              React.createElement(SystemRow, { label: 'Rate Limit', detail: sysInfo.rateLimit?.detail, ok: sysInfo.rateLimit?.status === 'ok' }),
            ),
          ),

          // Memory Snapshot
          React.createElement(Section, { title: 'Memory Snapshot' },
            React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 } },
              React.createElement(MiniStat, { value: Number(memInfo.working || 0).toLocaleString(), label: 'Working', color: C.indigo }),
              React.createElement(MiniStat, { value: Number(memInfo.episodic || 0).toLocaleString(), label: 'Episodic', color: C.cyan }),
              React.createElement(MiniStat, { value: Number(memInfo.semantic || 0).toLocaleString(), label: 'Semantic', color: C.green }),
              React.createElement(MiniStat, { value: Number(memInfo.entity || 0).toLocaleString(), label: 'Entity', color: C.orange }),
            ),
          ),

          // Operations Snapshot
          React.createElement(Section, { title: 'Operations Snapshot' },
            React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 } },
              React.createElement(IconStat, { value: activeCount, label: 'Active Agents', icon: '🤖', color: C.orange }),
              React.createElement(IconStat, { value: totalSessions, label: 'Sessions', icon: '💬', color: C.purple }),
              React.createElement(MiniStat, { value: String(overview.contextHub?.searches || 0), label: 'Searches', color: C.green }),
              React.createElement(IconStat, { value: `${overview.cost?.percent || 0}%`, label: 'Budget Used', icon: '💸', color: C.pink }),
              React.createElement(IconStat, { value: toolInfo.tools?.length || 0, label: 'Tracked Tools', icon: '🧰', color: C.cyan }),
            ),
          ),
        ),
      ),

      // Row 5 — Tools + Memory
      React.createElement('div', {
        style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 22 }
      },
        React.createElement(Section, { title: 'Tool Usage', trailing: React.createElement(Pill, null, toolCountLabel) },
          React.createElement(ResponsiveContainer, { width: '100%', height: 200 },
            React.createElement(BarChart, { data: toolInfo.tools || [], layout: 'vertical', margin: { left: 4 } },
              React.createElement(CartesianGrid, { stroke: C.border, strokeDasharray: '4', horizontal: false }),
              React.createElement(XAxis, { type: 'number', tick: { fontSize: 10, fill: C.text3 }, axisLine: false, tickLine: false }),
              React.createElement(YAxis, {
                type: 'category', dataKey: 'name', width: 120,
                tick: { fontSize: 10, fill: C.text2, fontFamily: 'SF Mono, monospace' },
                axisLine: false, tickLine: false,
              }),
              React.createElement(Tooltip, { contentStyle: tipStyle }),
              React.createElement(Bar, { dataKey: 'count', radius: [0, 6, 6, 0], maxBarSize: 16, name: 'Calls' },
                (toolInfo.tools || []).map((_, i) =>
                  React.createElement(Cell, { key: i, fill: `hsl(${220 + i * 12}, 60%, ${60 - i * 2}%)` })
                ),
              ),
            ),
          ),
        ),

        React.createElement(Section, {
          title: 'Memory Growth',
          trailing: React.createElement(Pill, { color: C.teal }, '4 Layers'),
        },
          React.createElement(ResponsiveContainer, { width: '100%', height: 200 },
            React.createElement(LineChart, { data: memInfo.history || [] },
              React.createElement(CartesianGrid, { stroke: C.border, strokeDasharray: '4', vertical: false }),
              React.createElement(XAxis, { dataKey: 'd', tick: { fontSize: 10, fill: C.text3 }, axisLine: false, tickLine: false }),
              React.createElement(YAxis, { tick: { fontSize: 10, fill: C.text3 }, axisLine: false, tickLine: false }),
              React.createElement(Tooltip, { contentStyle: tipStyle }),
              React.createElement(Line, { type: 'monotone', dataKey: 'L2', stroke: '#5856d6', strokeWidth: 2, dot: false, name: 'Episodic' }),
              React.createElement(Line, { type: 'monotone', dataKey: 'L3', stroke: '#af52de', strokeWidth: 2, dot: false, name: 'Semantic' }),
              React.createElement(Line, { type: 'monotone', dataKey: 'L1', stroke: '#5ac8fa', strokeWidth: 2, dot: false, name: 'Working' }),
              React.createElement(Line, { type: 'monotone', dataKey: 'L4', stroke: '#ff9f0a', strokeWidth: 2, dot: false, name: 'Entity' }),
              React.createElement(Legend, { iconType: 'line', iconSize: 10, wrapperStyle: { fontSize: 11, color: C.text3 } }),
            ),
          ),
        ),
      ),

      // Row 6 — Sessions
      React.createElement(Section, {
        title: 'Sessions',
        trailing: React.createElement('span', { style: { fontSize: 12, color: C.accent, cursor: 'pointer' } }, 'Export'),
        noPad: true,
      },
        React.createElement('div', { style: { padding: '0 0 8px' } },
          React.createElement(SessionsTable, { sessions: sessData.sessions || [] }),
        ),
      ),
    ),
  );
}

// ─── Mount ───────────────────────────────────────────

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(React.createElement(Dashboard));
