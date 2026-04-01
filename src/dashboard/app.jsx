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

// ─── Base Path Detection ─────────────────────────────
// /effy/dashboard → API base = /effy/dashboard/api
const DASH_BASE = (() => {
  const p = window.location.pathname.replace(/\/+$/, '');
  // /effy/dashboard/... → /effy/dashboard
  const idx = p.indexOf('/dashboard');
  return idx >= 0 ? p.slice(0, idx + '/dashboard'.length) : '/dashboard';
})();

// ─── Data Fetcher / SSE ──────────────────────────────

function useAPI(path, interval = 5000) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let active = true;
    const load = () => fetch(`${DASH_BASE}/api${path}`)
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
    const es = new EventSource(`${DASH_BASE}/api/events`);
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

function Section({ title, trailing, children, noPad, info }) {
  return React.createElement('div', { style: cardStyle },
    React.createElement('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 22px 0' }
    },
      React.createElement('span', { style: { fontSize: 15, fontWeight: 600, color: C.text1, display: 'flex', alignItems: 'center' } },
        title,
        info && React.createElement(InfoTip, { text: info }),
      ),
      trailing,
    ),
    React.createElement('div', { style: noPad ? {} : { padding: '14px 22px 18px' } }, children),
  );
}

// ─── Info Tooltip ────────────────────────────────────

function InfoTip({ text }) {
  const [show, setShow] = useState(false);
  return React.createElement('span', {
    style: { position: 'relative', display: 'inline-flex', marginLeft: 5, cursor: 'help' },
    onMouseEnter: () => setShow(true),
    onMouseLeave: () => setShow(false),
  },
    React.createElement('span', {
      style: {
        width: 14, height: 14, borderRadius: '50%', fontSize: 9, fontWeight: 600,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        backgroundColor: C.border, color: C.text3,
      }
    }, 'i'),
    show && React.createElement('div', {
      style: {
        position: 'absolute', bottom: '110%', left: '50%', transform: 'translateX(-50%)',
        background: 'rgba(29,29,31,0.92)', color: '#fff', fontSize: 11, lineHeight: 1.5,
        padding: '8px 12px', borderRadius: 8, whiteSpace: 'pre-line',
        minWidth: 200, maxWidth: 280, zIndex: 100,
        boxShadow: '0 4px 16px rgba(0,0,0,0.2)', pointerEvents: 'none',
      }
    }, text),
  );
}

// ─── KPI Card ────────────────────────────────────────

function Stat({ label, value, sub, trend, info }) {
  return React.createElement('div', { style: { ...cardStyle, padding: '20px 22px' } },
    React.createElement('div', { style: { fontSize: 12, color: C.text3, fontWeight: 500, marginBottom: 6, display: 'flex', alignItems: 'center' } },
      label,
      info && React.createElement(InfoTip, { text: info }),
    ),
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
// Conversations Tab
// ═══════════════════════════════════════════════════════

// ─── Memory Architecture Panel ──────────────────────

function MemoryGuidePanel({ open, onToggle }) {
  const h2 = (text) => React.createElement('div', {
    style: { fontSize: 14, fontWeight: 700, color: C.text1, marginTop: 18, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }
  }, text);

  const row = (icon, title, desc) => React.createElement('div', {
    style: { display: 'flex', gap: 10, padding: '10px 0', borderBottom: `1px solid ${C.border}` }
  },
    React.createElement('span', { style: { fontSize: 20, lineHeight: 1 } }, icon),
    React.createElement('div', { style: { flex: 1 } },
      React.createElement('div', { style: { fontSize: 13, fontWeight: 600, color: C.text1, marginBottom: 2 } }, title),
      React.createElement('div', { style: { fontSize: 12, color: C.text2, lineHeight: 1.5 } }, desc),
    ),
  );

  const badge = (text, color) => React.createElement('span', {
    style: {
      display: 'inline-block', fontSize: 10, fontWeight: 600, padding: '2px 8px',
      borderRadius: 6, backgroundColor: `${color}14`, color,
    }
  }, text);

  return React.createElement('div', {
    style: {
      position: 'fixed', top: 52, right: open ? 0 : -360, width: 360,
      height: 'calc(100vh - 52px)', backgroundColor: C.card,
      borderLeft: `1px solid ${C.border}`,
      boxShadow: open ? '-4px 0 24px rgba(0,0,0,0.08)' : 'none',
      transition: 'right 0.3s ease',
      zIndex: 40, overflowY: 'auto',
    }
  },
    // Content
    React.createElement('div', { style: { padding: '20px 22px 32px' } },
      React.createElement('div', {
        style: { fontSize: 17, fontWeight: 700, color: C.text1, marginBottom: 4 }
      }, '🧠 Effy 기억 구조'),
      React.createElement('div', {
        style: { fontSize: 12, color: C.text3, marginBottom: 16 }
      }, '대화를 어디까지 기억하고, 어떻게 활용하는지'),

      // 한눈에 보기
      React.createElement('div', {
        style: { backgroundColor: C.bg, borderRadius: 12, padding: '14px 16px', marginBottom: 16 }
      },
        React.createElement('div', { style: { fontSize: 12, fontWeight: 600, color: C.text2, marginBottom: 10 } }, '한눈에 보기'),
        row('⚡', '단기 기억 (RAM)', '최대 25번 주고받기 · 30분 후 삭제'),
        row('💾', '대화 기록 (DB)', '모든 대화 영구 저장 · 검색 가능'),
        row('🧬', '지식 기억 (DB)', '사실/결정을 추출해서 영구 저장'),
      ),

      // 단기 기억
      h2('⚡ 단기 기억'),
      React.createElement('div', { style: { fontSize: 12, color: C.text2, lineHeight: 1.7 } },
        '지금 나누고 있는 대화를 서버 메모리에 보관합니다.',
        React.createElement('br'),
        React.createElement('br'),
        React.createElement('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 } },
          badge('최대 25문답', C.accent),
          badge('30분 TTL', C.orange),
          badge('15문답 후 자동요약', C.purple),
        ),
        '1번 주고받기 = 메시지 2개 (질문 + 답변)',
        React.createElement('br'),
        '30분 동안 대화가 없으면 세션이 초기화됩니다.',
        React.createElement('br'),
        React.createElement('br'),
        React.createElement('span', { style: { fontWeight: 600, color: C.text1 } }, '자동 요약: '),
        '15번 이상 주고받으면 오래된 대화는 핵심만 요약하고, 최근 5문답만 원문으로 유지합니다.',
      ),

      // Context Window
      h2('📊 LLM에 전달되는 양'),
      React.createElement('div', { style: { fontSize: 12, color: C.text2, lineHeight: 1.7, marginBottom: 8 } },
        '질문 복잡도에 따라 참고하는 정보 양이 달라집니다.',
      ),
      React.createElement('div', {
        style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 8 }
      },
        ...[
          { label: 'LIGHT', total: '8K', color: C.green, desc: '인사, 간단 질문' },
          { label: 'STANDARD', total: '35K', color: C.accent, desc: '일반 질문' },
          { label: 'DEEP', total: '70K', color: C.purple, desc: '복잡한 분석' },
        ].map(t => React.createElement('div', {
          key: t.label,
          style: {
            textAlign: 'center', padding: '10px 6px', borderRadius: 10,
            backgroundColor: `${t.color}0a`, border: `1px solid ${t.color}20`,
          }
        },
          React.createElement('div', { style: { fontSize: 16, fontWeight: 700, color: t.color } }, t.total),
          React.createElement('div', { style: { fontSize: 10, fontWeight: 600, color: t.color, marginTop: 2 } }, t.label),
          React.createElement('div', { style: { fontSize: 9, color: C.text3, marginTop: 2 } }, t.desc),
        )),
      ),

      // 대화 기록
      h2('💾 대화 기록 (Episodic)'),
      React.createElement('div', { style: { fontSize: 12, color: C.text2, lineHeight: 1.7 } },
        '모든 질문-답변이 DB에 영구 저장됩니다.',
        React.createElement('br'),
        '단기 기억이 사라져도 DB에서 과거 대화를 검색해서 참조합니다.',
        React.createElement('br'),
        '이 페이지에서 보고 있는 대화 내역이 바로 이 데이터입니다.',
      ),

      // 지식 기억
      h2('🧬 지식 기억 (Semantic)'),
      React.createElement('div', { style: { fontSize: 12, color: C.text2, lineHeight: 1.7 } },
        '대화 중 중요한 내용을 자동으로 추출하여 저장합니다.',
        React.createElement('br'),
        React.createElement('br'),
        React.createElement('div', { style: { fontSize: 11, color: C.text3, fontStyle: 'italic', padding: '6px 10px', borderLeft: `3px solid ${C.border}`, marginBottom: 4 } },
          '"스프린트는 2주 단위" → 사실(Fact)'),
        React.createElement('div', { style: { fontSize: 11, color: C.text3, fontStyle: 'italic', padding: '6px 10px', borderLeft: `3px solid ${C.border}`, marginBottom: 4 } },
          '"React 대신 Vue로 결정" → 결정(Decision)'),
        React.createElement('div', { style: { fontSize: 11, color: C.text3, fontStyle: 'italic', padding: '6px 10px', borderLeft: `3px solid ${C.border}` } },
          '"김대리가 FE 담당" → 관계(Entity)'),
      ),

      // 흐름
      h2('🔄 전체 흐름'),
      React.createElement('div', {
        style: {
          fontSize: 11, fontFamily: 'SF Mono, Menlo, monospace', color: C.text2,
          backgroundColor: C.bg, borderRadius: 10, padding: 14, lineHeight: 1.8,
        }
      },
        '사용자: "배포 어떻게 해?"',
        React.createElement('br'),
        '  ├ 단기 기억: 최근 대화 원문',
        React.createElement('br'),
        '  ├ 대화 기록: "배포" 관련 과거 대화',
        React.createElement('br'),
        '  ├ 지식 기억: "GitHub Actions + ECS"',
        React.createElement('br'),
        '  ├ 사용자 프로필: AX팀 개발자',
        React.createElement('br'),
        '  └ → LLM에 전달 → 맥락 있는 답변',
      ),
    ),
  );
}

function ConversationsTab() {
  const [data, setData] = useState({ conversations: [], users: [], total: 0 });
  const [page, setPage] = useState(0);
  const [userFilter, setUserFilter] = useState('');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [guideOpen, setGuideOpen] = useState(false);
  const [groupByUser, setGroupByUser] = useState(false);
  const PAGE_SIZE = 30;

  useEffect(() => {
    const params = new URLSearchParams({ limit: PAGE_SIZE, offset: page * PAGE_SIZE });
    if (userFilter) params.set('user', userFilter);
    if (search) params.set('q', search);
    fetch(`${DASH_BASE}/api/conversations?${params}`)
      .then(r => r.json()).then(setData).catch(() => {});
  }, [page, userFilter, search]);

  const inputStyle = {
    padding: '6px 12px', fontSize: 13, border: `1px solid ${C.border}`,
    borderRadius: 8, outline: 'none', backgroundColor: '#fff', color: C.text1,
  };

  return React.createElement('div', { style: { position: 'relative' } },
    // Memory Guide Panel
    React.createElement(MemoryGuidePanel, { open: guideOpen, onToggle: () => setGuideOpen(o => !o) }),

    // Filters
    React.createElement('div', {
      style: { display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }
    },
      React.createElement('select', {
        value: userFilter,
        onChange: e => { setUserFilter(e.target.value); setPage(0); },
        style: { ...inputStyle, minWidth: 180 },
      },
        React.createElement('option', { value: '' }, `모든 사용자 (${data.users?.length || 0})`),
        (data.users || []).map(u =>
          React.createElement('option', { key: u.id || u, value: u.id || u }, u.name || u)
        ),
      ),
      React.createElement('form', {
        onSubmit: e => { e.preventDefault(); setSearch(searchInput); setPage(0); },
        style: { display: 'flex', gap: 6 },
      },
        React.createElement('input', {
          type: 'text', placeholder: '대화 내용 검색...', value: searchInput,
          onChange: e => setSearchInput(e.target.value),
          style: { ...inputStyle, width: 240 },
        }),
        React.createElement('button', {
          type: 'submit',
          style: {
            ...inputStyle, backgroundColor: C.accent, color: '#fff',
            border: 'none', cursor: 'pointer', fontWeight: 500,
          },
        }, '검색'),
        search && React.createElement('button', {
          type: 'button',
          onClick: () => { setSearch(''); setSearchInput(''); setPage(0); },
          style: { ...inputStyle, cursor: 'pointer', color: C.text2 },
        }, '초기화'),
      ),
      React.createElement('span', {
        style: { marginLeft: 'auto', fontSize: 12, color: C.text3 },
      }, `총 ${data.total?.toLocaleString() || 0}건`),
      React.createElement('button', {
        onClick: () => setGroupByUser(g => !g),
        style: {
          padding: '6px 12px', fontSize: 12, fontWeight: 500,
          border: `1px solid ${C.border}`, borderRadius: 8,
          backgroundColor: groupByUser ? C.accent : C.card, color: groupByUser ? '#fff' : C.text2,
          cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4,
        }
      }, '👤 사용자별'),
      React.createElement('button', {
        onClick: () => setGuideOpen(o => !o),
        style: {
          padding: '6px 12px', fontSize: 12, fontWeight: 500,
          border: `1px solid ${C.border}`, borderRadius: 8,
          backgroundColor: guideOpen ? C.accent : C.card, color: guideOpen ? '#fff' : C.text2,
          cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4,
        }
      }, '🧠 기억 구조'),
    ),
    // Conversation list
    (() => {
      const convs = data.conversations || [];
      if (convs.length === 0) {
        return React.createElement('div', {
          style: { ...cardStyle, padding: 40, textAlign: 'center', color: C.text3, fontSize: 14 },
        }, '대화 내역이 없습니다');
      }

      // 개별 대화 렌더링 함수
      const renderConv = (conv, i, showUser = true) =>
        React.createElement('div', {
          key: conv.id || i,
          style: {
            padding: '14px 20px',
            borderBottom: `0.5px solid ${C.border}`,
          }
        },
          React.createElement('div', {
            style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }
          },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              showUser && React.createElement('span', {
                style: { fontSize: 11, fontWeight: 600, color: '#fff', backgroundColor: C.accent, padding: '2px 8px', borderRadius: 10 }
              }, conv.userName || conv.userId?.slice(0, 12) || '?'),
              React.createElement('span', {
                style: { fontSize: 11, color: C.text3, backgroundColor: C.bg, padding: '2px 8px', borderRadius: 10 },
              }, (AGENT_MAP[conv.agent]?.icon || '💬') + ' ' + (conv.agent || 'general')),
            ),
            React.createElement('span', {
              style: { fontSize: 11, color: C.text3, fontFamily: 'SF Mono, monospace' },
            }, new Date(conv.timestamp).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })),
          ),
          conv.question && React.createElement('div', {
            style: { padding: '8px 12px', backgroundColor: '#e8f0fe', borderRadius: 10, fontSize: 13, color: C.text1, marginBottom: 6, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
          }, React.createElement('span', { style: { fontWeight: 600, color: C.accent, marginRight: 6 } }, 'Q'), conv.question.slice(0, 500)),
          conv.answer && React.createElement('div', {
            style: { padding: '8px 12px', backgroundColor: C.bg, borderRadius: 10, fontSize: 13, color: C.text2, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
          }, React.createElement('span', { style: { fontWeight: 600, color: C.green, marginRight: 6 } }, 'A'), conv.answer.slice(0, 800)),
        );

      if (groupByUser) {
        // 사용자별 그룹핑
        const groups = {};
        for (const conv of convs) {
          const key = conv.userId || '?';
          if (!groups[key]) groups[key] = { name: conv.userName || conv.userId?.slice(0, 12) || '?', convs: [] };
          groups[key].convs.push(conv);
        }
        return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
          Object.entries(groups).map(([uid, group]) =>
            React.createElement('div', { key: uid, style: { ...cardStyle, overflow: 'hidden' } },
              React.createElement('div', {
                style: {
                  padding: '12px 20px', backgroundColor: C.bg,
                  display: 'flex', alignItems: 'center', gap: 10, borderBottom: `1px solid ${C.border}`,
                }
              },
                React.createElement('span', {
                  style: { width: 32, height: 32, borderRadius: '50%', backgroundColor: C.accent, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700 }
                }, group.name.charAt(0).toUpperCase()),
                React.createElement('div', null,
                  React.createElement('div', { style: { fontSize: 14, fontWeight: 600, color: C.text1 } }, group.name),
                  React.createElement('div', { style: { fontSize: 11, color: C.text3 } }, `${group.convs.length}건의 대화`),
                ),
              ),
              group.convs.map((conv, i) => renderConv(conv, i, false)),
            ),
          ),
        );
      }

      // 기본 뷰 (시간순)
      return React.createElement('div', {
        style: { backgroundColor: C.card, borderRadius: 14, border: `0.5px solid ${C.border}`, overflow: 'hidden' }
      }, convs.map((conv, i) => renderConv(conv, i)));
    })(),

    // Pagination
    data.total > PAGE_SIZE && React.createElement('div', {
      style: { display: 'flex', justifyContent: 'center', gap: 8, marginTop: 16 },
    },
      React.createElement('button', {
        onClick: () => setPage(p => Math.max(0, p - 1)), disabled: page === 0,
        style: { ...inputStyle, cursor: page > 0 ? 'pointer' : 'default', opacity: page > 0 ? 1 : 0.4 },
      }, '← 이전'),
      React.createElement('span', {
        style: { fontSize: 13, color: C.text2, lineHeight: '32px' },
      }, `${page + 1} / ${Math.ceil(data.total / PAGE_SIZE)}`),
      React.createElement('button', {
        onClick: () => setPage(p => p + 1), disabled: (page + 1) * PAGE_SIZE >= data.total,
        style: { ...inputStyle, cursor: (page + 1) * PAGE_SIZE < data.total ? 'pointer' : 'default', opacity: (page + 1) * PAGE_SIZE < data.total ? 1 : 0.4 },
      }, '다음 →'),
    ),

    // Scroll buttons (항상 표시)
    React.createElement('div', {
      style: { position: 'fixed', bottom: 24, right: 24, display: 'flex', flexDirection: 'column', gap: 8, zIndex: 30 }
    },
      React.createElement('button', {
        onClick: () => window.scrollTo({ top: 0, behavior: 'smooth' }),
        style: {
          width: 40, height: 40, borderRadius: '50%', backgroundColor: C.card, color: C.text2,
          border: `1px solid ${C.border}`, cursor: 'pointer', fontSize: 16,
          boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }
      }, '↑'),
      React.createElement('button', {
        onClick: () => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }),
        style: {
          width: 40, height: 40, borderRadius: '50%', backgroundColor: C.accent, color: '#fff',
          border: 'none', cursor: 'pointer', fontSize: 16,
          boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }
      }, '↓'),
    ),
  );
}

// ═══════════════════════════════════════════════════════
// Main Dashboard Component
// ═══════════════════════════════════════════════════════

function Dashboard() {
  const [now, setNow] = useState(new Date());
  const [tab, setTab] = useState('overview');
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
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 16 } },
        ['overview', 'conversations'].map(t =>
          React.createElement('button', {
            key: t,
            onClick: () => setTab(t),
            style: {
              fontSize: 13, fontWeight: tab === t ? 600 : 400,
              color: tab === t ? C.accent : C.text3,
              background: 'none', border: 'none', cursor: 'pointer',
              borderBottom: tab === t ? `2px solid ${C.accent}` : '2px solid transparent',
              paddingBottom: 4,
            },
          }, t === 'overview' ? 'Overview' : '💬 대화 내역'),
        ),
        React.createElement('div', { style: { width: 1, height: 16, backgroundColor: C.border, margin: '0 4px' } }),
        React.createElement(Pill, { color: C.green }, 'Live'),
        React.createElement('span', {
          style: { fontSize: 12, color: C.text3, fontFamily: 'SF Mono, monospace', fontVariantNumeric: 'tabular-nums' }
        }, now.toLocaleTimeString('ko-KR', { hour12: false })),
      ),
    ),

    // ── Content ──
    React.createElement('main', { style: { maxWidth: 1280, margin: '0 auto', padding: '24px 32px 48px' } },

      tab === 'conversations'
        ? React.createElement(ConversationsTab)
        : React.createElement(React.Fragment, null,

      // Row 1 — KPIs
      React.createElement('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 14, marginBottom: 22 }
      },
        React.createElement(Stat, { label: 'Requests Today', value: overview.requests?.toLocaleString(), trend: 12, sub: 'across 5 agents', info: '오늘 Effy에게 들어온 메시지 수\n누군가 Teams에서 질문하면 +1' }),
        React.createElement(Stat, { label: 'Monthly Cost', value: `$${overview.cost?.current || 0}`, trend: -3, sub: `of $${overview.cost?.budget || 500} budget`, info: '이번 달 Anthropic API 사용 비용\n질문에 답변할 때마다 토큰 소모' }),
        React.createElement(Stat, { label: 'Active Sessions', value: String(overview.sessions?.active || 0), sub: `${agents.length - (overview.sessions?.active || 0)} idle`, info: '현재 대화 중인 사용자 수\n실시간 업데이트' }),
        React.createElement(Stat, { label: 'Avg Latency', value: `${overview.latency?.avg || 0}s`, trend: -8, sub: 'all tiers', info: 'LLM 응답 평균 소요 시간\n모델 티어별로 다름 (Haiku < Sonnet < Opus)' }),
        React.createElement(Stat, { label: 'API Doc Searches', value: String(overview.contextHub?.searches || 0), trend: 15, sub: 'Context Hub', info: 'Context Hub API 문서 검색 횟수\n사용자 질문에 API 문서가 참조될 때 +1' }),
      ),

      // Row 2 — Agent Cards
      React.createElement('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 14, marginBottom: 22 }
      }, agents.map(a => React.createElement(AgentCard, { key: a.id, a }))),

      // Row 3 — Cost + Tier
      React.createElement('div', {
        style: { display: 'grid', gridTemplateColumns: '5fr 3fr', gap: 14, marginBottom: 22 }
      },
        React.createElement(Section, { title: 'Cost Trend', trailing: React.createElement(Pill, null, 'March 2026'), info: '일별 API 비용 추이\n모델별 (Haiku/Sonnet/Opus) 비용 분리 표시\n매일 누적 집계' },
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

        React.createElement(Section, { title: 'Tier Distribution', info: 'Haiku/Sonnet/Opus 모델 사용 비율\n질문 복잡도에 따라 자동 선택됨\nLIGHT→Haiku, STANDARD→Sonnet, DEEP→Opus' },
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
          info: '실시간 질문-답변 로그\nTeams에서 대화할 때마다 자동 기록',
          trailing: React.createElement('span', { style: { fontSize: 12, color: C.accent, cursor: 'pointer' } }, 'View all'),
          noPad: true,
        },
          React.createElement('div', { style: { maxHeight: 380, overflowY: 'auto' } },
            (activity.events || []).map((f, i) => React.createElement(FeedRow, { key: i, f })),
          ),
        ),

        React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
          // System
          React.createElement(Section, { title: 'System', info: 'Circuit Breaker: LLM 장애 시 자동 차단\nCoalescer: 빠른 연속 메시지 병합\nBudget Gate: 월 비용 한도 관리\nRate Limit: 동시 요청 제한' },
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
      ), // end React.Fragment (overview tab)
    ),
  );
}

// ─── Mount ───────────────────────────────────────────

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(React.createElement(Dashboard));
