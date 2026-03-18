/* global React, ReactDOM, Recharts */
const { useState, useEffect } = React;
const {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} = Recharts;

// ═══════════════════════════════════════════════════════
// Effy Mission Control v3.6.1
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

// ─── Data Fetcher / SSE ──────────────────────────────

function useAPI(path, interval = 5000) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let active = true;
    const load = () => fetch(`/dashboard/api${path}`)
      .then(r => r.json()).then(d => { if (active) setData(d); })
      .catch(() => {});
    load();
    const t = setInterval(load, interval);
    return () => { active = false; clearInterval(t); };
  }, [path, interval]);
  return data;
}

function useSSE() {
  const [events, setEvents] = useState([]);
  useEffect(() => {
    const es = new EventSource('/dashboard/api/events');
    es.addEventListener('activity', (e) => {
      try {
        const d = JSON.parse(e.data);
        setEvents(prev => [d, ...prev].slice(0, 50));
      } catch {}
    });
    return () => es.close();
  }, []);
  return events;
}

// ─── Fallback mock data (API 미연결 시) ──────────────

const MOCK = {
  overview: {
    requests: 1925, cost: { current: 68.3, budget: 500, percent: 14 },
    sessions: { active: 2, total: 47 }, latency: { avg: 2.4 },
    contextHub: { searches: 287 },
  },
  agents: { agents: [
    { id: 'general', name: 'General', tier: 'tier1', tierLabel: 'Haiku', status: 'active', requests: 847, latency: 1.2, toolCount: 24 },
    { id: 'code', name: 'Code', tier: 'tier2', tierLabel: 'Sonnet', status: 'active', requests: 523, latency: 3.8, toolCount: 26 },
    { id: 'ops', name: 'Ops', tier: 'tier1', tierLabel: 'Haiku', status: 'active', requests: 312, latency: 1.5, toolCount: 27 },
    { id: 'knowledge', name: 'Knowledge', tier: 'tier1', tierLabel: 'Haiku', status: 'idle', requests: 198, latency: 2.1, toolCount: 24 },
    { id: 'strategy', name: 'Strategy', tier: 'tier3', tierLabel: 'Opus', status: 'idle', requests: 45, latency: 8.4, toolCount: 24 },
  ]},
  cost: {
    history: [
      { d: '3/1', haiku: 2.1, sonnet: 8.4, opus: 12.0 },
      { d: '3/4', haiku: 3.2, sonnet: 11.2, opus: 18.5 },
      { d: '3/7', haiku: 2.8, sonnet: 9.8, opus: 22.1 },
      { d: '3/10', haiku: 4.1, sonnet: 14.3, opus: 28.7 },
      { d: '3/13', haiku: 3.5, sonnet: 12.1, opus: 35.2 },
      { d: '3/16', haiku: 5.2, sonnet: 16.8, opus: 42.0 },
      { d: '3/18', haiku: 4.8, sonnet: 15.2, opus: 48.3 },
    ],
    tierDistribution: [
      { name: 'Haiku', value: 1357, color: '#5ac8fa' },
      { name: 'Sonnet', value: 523, color: '#5856d6' },
      { name: 'Opus', value: 38, color: '#af52de' },
      { name: 'Opus ET', value: 7, color: '#ff3b30' },
    ],
  },
  activity: { events: [
    { time: '18:42', agent: 'code', icon: '🔧', detail: 'shell → git status', tier: 'T2' },
    { time: '18:41', agent: 'general', icon: '💬', detail: '사용자 U001에게 응답 (347 tokens)', tier: 'T1' },
    { time: '18:40', agent: 'ops', icon: '📋', detail: "create_task → 'Fix login bug'", tier: 'T1' },
    { time: '18:38', agent: 'code', icon: '🔍', detail: "search_api_docs → 'stripe webhooks'", tier: 'T2' },
    { time: '18:37', agent: 'knowledge', icon: '💾', detail: 'save_knowledge → team pool', tier: 'T1' },
    { time: '18:35', agent: 'general', icon: '📝', detail: '교정 감지 → Lesson 후보 생성', tier: 'T1' },
    { time: '18:33', agent: 'strategy', icon: '🗳️', detail: 'Committee → approve (2/3)', tier: 'T3' },
    { time: '18:30', agent: 'ops', icon: '⚡', detail: 'Circuit Breaker 복구 완료', tier: 'T1' },
  ]},
  sessions: { sessions: [
    { id: 'a1b2', user: 'Drake', agent: 'code', msgs: 12, tokens: '8.4K', cost: '$0.34', duration: '4:12', status: 'active' },
    { id: 'c3d4', user: 'Alex', agent: 'general', msgs: 5, tokens: '2.1K', cost: '$0.02', duration: '1:30', status: 'active' },
    { id: 'e5f6', user: 'Sarah', agent: 'ops', msgs: 8, tokens: '4.2K', cost: '$0.08', duration: '2:45', status: 'idle' },
    { id: 'g7h8', user: 'Drake', agent: 'strategy', msgs: 3, tokens: '12.8K', cost: '$1.92', duration: '6:10', status: 'done' },
    { id: 'i9j0', user: 'Mike', agent: 'knowledge', msgs: 6, tokens: '3.1K', cost: '$0.04', duration: '1:55', status: 'done' },
  ]},
  tools: { tools: [
    { name: 'slack_reply', count: 892 }, { name: 'search_knowledge', count: 421 },
    { name: 'search_api_docs', count: 287 }, { name: 'save_knowledge', count: 198 },
    { name: 'shell', count: 156 }, { name: 'file_read', count: 134 },
    { name: 'create_task', count: 98 }, { name: 'web_search', count: 87 },
  ]},
  memory: {
    working: 267, episodic: 2640, semantic: 500, entity: 100,
    history: [
      { d: '3/12', L1: 245, L2: 1820, L3: 432, L4: 89 },
      { d: '3/13', L1: 312, L2: 1950, L3: 445, L4: 91 },
      { d: '3/14', L1: 198, L2: 2100, L3: 461, L4: 93 },
      { d: '3/15', L1: 278, L2: 2250, L3: 472, L4: 95 },
      { d: '3/16', L1: 334, L2: 2380, L3: 488, L4: 97 },
      { d: '3/17', L1: 289, L2: 2510, L3: 495, L4: 98 },
      { d: '3/18', L1: 267, L2: 2640, L3: 500, L4: 100 },
    ],
  },
  system: {
    circuitBreaker: { status: 'closed', detail: 'All models healthy' },
    coalescer: { status: 'active', detail: '150ms batch' },
    budgetGate: { status: 'ok', detail: '$68 / $500 (14%)' },
    rateLimit: { status: 'ok', detail: '4 / 20 slots' },
  },
};

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

  // Fetch data with fallback to mock
  const overview = useAPI('/overview', 5000) || MOCK.overview;
  const agentData = useAPI('/agents', 5000) || MOCK.agents;
  const costInfo = useAPI('/cost', 15000) || MOCK.cost;
  const activity = useAPI('/activity', 3000) || MOCK.activity;
  const sessData = useAPI('/sessions', 5000) || MOCK.sessions;
  const toolInfo = useAPI('/tools', 10000) || MOCK.tools;
  const memInfo = useAPI('/memory', 10000) || MOCK.memory;
  const sysInfo = useAPI('/system', 5000) || MOCK.system;

  const agents = agentData.agents || [];
  const activeCount = agents.filter(a => a.status === 'active').length;

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
        React.createElement(Pill, { color: C.green }, 'Live'),
        React.createElement('span', {
          style: { fontSize: 12, color: C.text3, fontFamily: 'SF Mono, monospace', fontVariantNumeric: 'tabular-nums' }
        }, now.toLocaleTimeString('ko-KR', { hour12: false })),
      ),
    ),

    // ── Content ──
    React.createElement('main', { style: { maxWidth: 1280, margin: '0 auto', padding: '24px 32px 48px' } },

      // Row 1 — KPIs
      React.createElement('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 14, marginBottom: 22 }
      },
        React.createElement(Stat, { label: 'Requests Today', value: overview.requests?.toLocaleString(), trend: 12, sub: 'across 5 agents' }),
        React.createElement(Stat, { label: 'Monthly Cost', value: `$${overview.cost?.current || 0}`, trend: -3, sub: `of $${overview.cost?.budget || 500} budget` }),
        React.createElement(Stat, { label: 'Active Sessions', value: String(overview.sessions?.active || 0), sub: `${agents.length - (overview.sessions?.active || 0)} idle` }),
        React.createElement(Stat, { label: 'Avg Latency', value: `${overview.latency?.avg || 0}s`, trend: -8, sub: 'all tiers' }),
        React.createElement(Stat, { label: 'API Doc Searches', value: String(overview.contextHub?.searches || 0), trend: 15, sub: 'Context Hub' }),
      ),

      // Row 2 — Agent Cards
      React.createElement('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 14, marginBottom: 22 }
      }, agents.map(a => React.createElement(AgentCard, { key: a.id, a }))),

      // Row 3 — Cost + Tier
      React.createElement('div', {
        style: { display: 'grid', gridTemplateColumns: '5fr 3fr', gap: 14, marginBottom: 22 }
      },
        React.createElement(Section, { title: 'Cost Trend', trailing: React.createElement(Pill, null, 'March 2026') },
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
          trailing: React.createElement('span', { style: { fontSize: 12, color: C.accent, cursor: 'pointer' } }, 'View all'),
          noPad: true,
        },
          React.createElement('div', { style: { maxHeight: 380, overflowY: 'auto' } },
            (activity.events || []).map((f, i) => React.createElement(FeedRow, { key: i, f })),
          ),
        ),

        React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
          // System
          React.createElement(Section, { title: 'System' },
            React.createElement('div', null,
              React.createElement(SystemRow, { label: 'Circuit Breaker', detail: sysInfo.circuitBreaker?.detail, ok: sysInfo.circuitBreaker?.status !== 'open' }),
              React.createElement(SystemRow, { label: 'Coalescer', detail: sysInfo.coalescer?.detail, ok: true }),
              React.createElement(SystemRow, { label: 'Budget Gate', detail: sysInfo.budgetGate?.detail, ok: true }),
              React.createElement(SystemRow, { label: 'Rate Limit', detail: sysInfo.rateLimit?.detail, ok: true }),
            ),
          ),

          // Context Hub
          React.createElement(Section, { title: 'Context Hub' },
            React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 } },
              React.createElement(MiniStat, { value: '602', label: 'Authors', color: C.indigo }),
              React.createElement(MiniStat, { value: '1,651', label: 'Docs', color: C.cyan }),
              React.createElement(MiniStat, { value: String(overview.contextHub?.searches || 0), label: 'Searches', color: C.green }),
              React.createElement(MiniStat, { value: '3', label: 'Custom', color: C.orange }),
            ),
          ),

          // Self-Improvement
          React.createElement(Section, { title: 'Self-Improvement' },
            React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 } },
              React.createElement(IconStat, { value: 23, label: 'Corrections', icon: '📝', color: C.orange }),
              React.createElement(IconStat, { value: 8, label: 'Lessons', icon: '🎓', color: C.purple }),
              React.createElement(IconStat, { value: 3, label: 'Global', icon: '🌐', color: C.cyan }),
              React.createElement(IconStat, { value: 12, label: 'Votes', icon: '🗳️', color: C.pink }),
            ),
          ),
        ),
      ),

      // Row 5 — Tools + Memory
      React.createElement('div', {
        style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 22 }
      },
        React.createElement(Section, { title: 'Tool Usage', trailing: React.createElement(Pill, null, 'Top 8') },
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
