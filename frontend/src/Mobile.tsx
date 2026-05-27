// Mobile UI — clean minimal redesign.
// Renders when isMobile === true. Reuses backend types and helpers from App.tsx via props.

import { useState, useMemo } from 'react'
import {
  BarChart, Bar, XAxis, Tooltip, ResponsiveContainer, Cell,
  LineChart, Line, CartesianGrid,
} from 'recharts'

// ── Public types ─────────────────────────────────────────────────────────────
export interface MobileDashboardData {
  total_spent: number
  receipt_count: number
  top_category: string
  category_spend: { name: string; value: number; count: number }[]
  monthly_trend:  { month: string; total: number }[]
  daily_trend:    { date: string; total: number }[]
  recent_receipts: { id: number; merchant: string; date: string; total_amount: number; category: string; has_image: boolean }[]
  mom: { current_month: string; current_total: number; current_receipt_count: number; prev_month: string; prev_total: number; delta_pct: number | null } | null
}

export interface MobileProps {
  data: MobileDashboardData | null
  insights: { by_store: any[]; by_product: any[]; by_month: any[] } | null
  analytics: any | null
  darkMode: boolean
  connectionStatus: string
  error: string | null
  toast: { message: string; id: number } | null
  onToggleDark: () => void
  onScan: () => void
  onOpenSettings: () => void
  onRowClick: (id: number) => void
  onClearError: () => void
  formatDate: (d: string) => string
  formatMonth: (m: string) => string
  catColor: (c: string) => string
}

type Tab = 'home' | 'receipts' | 'insights' | 'settings'
const fmtMoney = (n: number) => `€${n.toFixed(2)}`

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
function currentMonth() { return MONTHS[new Date().getMonth()] }

// ── SVG helpers ──────────────────────────────────────────────────────────────
function NavIcon({ name, active }: { name: string; active: boolean }) {
  const sw = active ? 2.2 : 1.7
  const c = 'currentColor'
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      {name === 'home' && (
        <path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-5h-6v5H4a1 1 0 0 1-1-1z"
          stroke={c} strokeWidth={sw} strokeLinejoin="round"/>
      )}
      {name === 'receipt' && <>
        <path d="M6 3h12v18l-2-1.5L14 21l-2-1.5L10 21l-2-1.5L6 21V3z"
          stroke={c} strokeWidth={sw} strokeLinejoin="round"/>
        <path d="M9 8h6M9 12h6M9 16h4" stroke={c} strokeWidth={sw} strokeLinecap="round"/>
      </>}
      {name === 'chart' && (
        <path d="M4 20V10M10 20V4M16 20v-7M22 20H2"
          stroke={c} strokeWidth={sw} strokeLinecap="round"/>
      )}
      {name === 'gear' && <>
        <circle cx="12" cy="12" r="3" stroke={c} strokeWidth={sw}/>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
          stroke={c} strokeWidth={sw} strokeLinejoin="round"/>
      </>}
    </svg>
  )
}

function IconChevron() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M9 18l6-6-6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function IconSearch() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8"/>
      <path d="M21 21l-4.35-4.35" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
    </svg>
  )
}

function IconClose() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
    </svg>
  )
}

function IconSun() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.8"/>
      <path d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"
        stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
    </svg>
  )
}

function IconMoon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"
        stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

// ── Nav item ─────────────────────────────────────────────────────────────────
function NavItem({ name, label, active, onClick }:
  { name: string; label: string; active: boolean; onClick: () => void }) {
  return (
    <button className={`m-navitem${active ? ' m-navitem--active' : ''}`} onClick={onClick}>
      <NavIcon name={name} active={active} />
      <span>{label}</span>
    </button>
  )
}

// ── Main component ───────────────────────────────────────────────────────────
export default function Mobile(props: MobileProps) {
  const {
    data, insights, darkMode, connectionStatus, error,
    onToggleDark, onScan, onOpenSettings, onRowClick, onClearError,
    formatDate, formatMonth, catColor, toast,
  } = props

  const [tab, setTab] = useState<Tab>('home')
  const [query, setQuery] = useState('')

  const filteredReceipts = useMemo(() => {
    if (!data) return []
    const q = query.trim().toLowerCase()
    if (!q) return data.recent_receipts
    return data.recent_receipts.filter(r =>
      r.merchant.toLowerCase().includes(q) ||
      r.category.toLowerCase().includes(q) ||
      r.date.includes(q)
    )
  }, [data, query])

  return (
    <div className="m-app">
      {/* Top bar */}
      <header className="m-topbar">
        <span className="m-wordmark">Rezet</span>
        <button className="m-icon-btn" onClick={onToggleDark} aria-label="Toggle theme">
          {darkMode ? <IconSun /> : <IconMoon />}
        </button>
      </header>

      {/* Status notices */}
      {connectionStatus && connectionStatus !== 'Active' && (
        <div className="m-notice m-notice--info">
          <span className="m-notice-dot" />
          {connectionStatus}
        </div>
      )}
      {error && (
        <div className="m-notice m-notice--error" onClick={onClearError}>
          {error.split('\n')[0]}
        </div>
      )}

      {/* Page content */}
      <main className="m-scroll">
        {tab === 'home'     && <HomeTab data={data} onRowClick={onRowClick} formatDate={formatDate} formatMonth={formatMonth} catColor={catColor} darkMode={darkMode} />}
        {tab === 'receipts' && <ReceiptsTab data={data} query={query} setQuery={setQuery} receipts={filteredReceipts} onRowClick={onRowClick} formatDate={formatDate} catColor={catColor} />}
        {tab === 'insights' && <InsightsTab insights={insights} data={data} catColor={catColor} />}
        {tab === 'settings' && <SettingsTab onOpenSettings={onOpenSettings} darkMode={darkMode} onToggleDark={onToggleDark} />}
      </main>

      {/* Bottom nav — FAB in center slot */}
      <nav className="m-nav">
        <NavItem name="home"    label="Home"     active={tab==='home'}     onClick={() => setTab('home')} />
        <NavItem name="receipt" label="Receipts" active={tab==='receipts'} onClick={() => setTab('receipts')} />
        <button className="m-nav-fab" onClick={onScan} aria-label="Add receipt">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
          </svg>
        </button>
        <NavItem name="chart"   label="Insights" active={tab==='insights'} onClick={() => setTab('insights')} />
        <NavItem name="gear"    label="Settings" active={tab==='settings'} onClick={() => setTab('settings')} />
      </nav>

      {toast && <div className="m-toast">{toast.message}</div>}
    </div>
  )
}

// ── Home tab ─────────────────────────────────────────────────────────────────
function HomeTab({ data, onRowClick, formatDate, formatMonth, catColor, darkMode }: any) {
  if (!data) return (
    <div className="m-empty">
      <p className="m-empty-title">Loading…</p>
      <p className="m-empty-sub">Connecting to backend</p>
    </div>
  )

  if (!data.recent_receipts.length) return (
    <div className="m-empty">
      <p className="m-empty-title">No receipts yet</p>
      <p className="m-empty-sub">Tap + to scan your first receipt</p>
    </div>
  )

  const mom = data.mom
  const useDaily = data.monthly_trend.length <= 1 && (data.daily_trend?.length ?? 0) > 0
  const trendData = useDaily
    ? data.daily_trend.map((d: any) => ({ ...d, label: formatDate(d.date).slice(0, 6) }))
    : data.monthly_trend.map((m: any) => ({ ...m, label: formatMonth(m.month) }))

  const gridColor = darkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'
  const tickColor = darkMode ? '#636366' : '#aeaeb2'
  const ttStyle  = { background: darkMode ? '#1c1c1e' : '#fff', border: 'none', borderRadius: 10, fontSize: 12, color: darkMode ? '#fff' : '#1c1c1e' }

  return (
    <>
      {/* Hero */}
      <div className="m-hero">
        <p className="m-hero-eyebrow">{currentMonth()} spending</p>
        <p className="m-hero-amount">{fmtMoney(mom?.current_total ?? 0)}</p>
        <div className="m-hero-sub">
          <span>{mom?.current_receipt_count ?? 0} receipts</span>
          {mom?.delta_pct != null && mom.prev_total > 0 && (
            <span className={`m-delta ${mom.delta_pct > 0 ? 'm-delta--up' : 'm-delta--down'}`}>
              {mom.delta_pct > 0 ? '↑' : '↓'}{Math.abs(mom.delta_pct).toFixed(0)}% vs last month
            </span>
          )}
        </div>
      </div>

      {/* Bento stats */}
      <div className="m-bento">
        <div className="m-bento-card">
          <p className="m-bento-val">{fmtMoney(data.total_spent)}</p>
          <p className="m-bento-key">All time</p>
        </div>
        <div className="m-bento-card">
          <p className="m-bento-val">{data.receipt_count}</p>
          <p className="m-bento-key">Receipts</p>
        </div>
        <div className="m-bento-card">
          <p className="m-bento-val m-bento-val--sm">{data.top_category}</p>
          <p className="m-bento-key">Top category</p>
        </div>
        <div className="m-bento-card">
          <p className="m-bento-val">{data.category_spend.length}</p>
          <p className="m-bento-key">Categories</p>
        </div>
      </div>

      {/* Trend chart */}
      <p className="m-label">{useDaily ? 'Daily · This month' : '12-month trend'}</p>
      <div className="m-chart-wrap">
        <ResponsiveContainer width="100%" height={160}>
          {useDaily ? (
            <BarChart data={trendData} margin={{ top: 8, right: 4, left: -22, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: tickColor }} axisLine={false} tickLine={false} />
              <Tooltip cursor={{ fill: darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)' }} contentStyle={ttStyle} />
              <Bar dataKey="total" radius={[5,5,0,0]}>
                {trendData.map((_: any, i: number) => <Cell key={i} fill="#34c759" fillOpacity={0.85} />)}
              </Bar>
            </BarChart>
          ) : (
            <LineChart data={trendData} margin={{ top: 8, right: 4, left: -22, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: tickColor }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={ttStyle} />
              <Line type="monotone" dataKey="total" stroke="#34c759" strokeWidth={2.5} dot={false} />
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>

      {/* Recent receipts */}
      <p className="m-label">Recent</p>
      <div className="m-list">
        {data.recent_receipts.slice(0, 6).map((r: any) => (
          <button key={r.id} className="m-row" onClick={() => onRowClick(r.id)}>
            <div className="m-row-dot" style={{ background: catColor(r.category) }} />
            <div className="m-row-body">
              <p className="m-row-title">{r.merchant || 'Unknown'}</p>
              <p className="m-row-sub">{r.category} · {formatDate(r.date)}</p>
            </div>
            <p className="m-row-amount">{fmtMoney(r.total_amount)}</p>
          </button>
        ))}
      </div>

      <div className="m-spacer" />
    </>
  )
}

// ── Receipts tab ─────────────────────────────────────────────────────────────
function ReceiptsTab({ query, setQuery, receipts, onRowClick, formatDate, catColor }: any) {
  return (
    <>
      <div className="m-search">
        <IconSearch />
        <input
          type="text"
          placeholder="Merchants, categories…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
        />
        {query && (
          <button className="m-search-clear" onClick={() => setQuery('')}>
            <IconClose />
          </button>
        )}
      </div>

      {receipts.length === 0 ? (
        <div className="m-empty">
          <p className="m-empty-title">{query ? 'No matches' : 'No receipts yet'}</p>
          <p className="m-empty-sub">{query ? 'Try a different search term' : 'Tap + to add one'}</p>
        </div>
      ) : (
        <div className="m-list">
          {receipts.map((r: any) => (
            <button key={r.id} className="m-row" onClick={() => onRowClick(r.id)}>
              <div className="m-row-dot" style={{ background: catColor(r.category) }} />
              <div className="m-row-body">
                <p className="m-row-title">{r.merchant || 'Unknown'}</p>
                <p className="m-row-sub">
                  {r.category} · {formatDate(r.date)}{r.has_image ? ' · 📷' : ''}
                </p>
              </div>
              <p className="m-row-amount">{fmtMoney(r.total_amount)}</p>
            </button>
          ))}
        </div>
      )}
      <div className="m-spacer" />
    </>
  )
}

// ── Insights tab ─────────────────────────────────────────────────────────────
function InsightsTab({ insights, data, catColor }: any) {
  if (!insights && !data) return (
    <div className="m-empty">
      <p className="m-empty-title">No data yet</p>
      <p className="m-empty-sub">Scan some receipts first</p>
    </div>
  )

  const cats        = data?.category_spend?.slice(0, 6) ?? []
  const maxCat      = cats[0]?.value ?? 1
  const topStores   = insights?.by_store?.slice(0, 5) ?? []
  const topProducts = insights?.by_product?.slice(0, 5) ?? []

  return (
    <>
      {cats.length > 0 && (
        <>
          <p className="m-label">By Category</p>
          <div className="m-card">
            {cats.map((c: any) => (
              <div key={c.name} className="m-bar-row">
                <div className="m-bar-header">
                  <span className="m-bar-name">
                    <span className="m-dot" style={{ background: catColor(c.name) }} />
                    {c.name}
                  </span>
                  <span className="m-bar-val">{fmtMoney(c.value)}</span>
                </div>
                <div className="m-track">
                  <div className="m-fill" style={{ width: `${(c.value / maxCat) * 100}%`, background: catColor(c.name) }} />
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {topStores.length > 0 && (
        <>
          <p className="m-label">Top Stores</p>
          <div className="m-card">
            {topStores.map((s: any, i: number) => (
              <div key={s.merchant} className="m-rank-row">
                <span className="m-rank-n">{i + 1}</span>
                <div className="m-rank-body">
                  <p className="m-rank-title">{s.merchant}</p>
                  <p className="m-rank-sub">{s.visits} visit{s.visits !== 1 ? 's' : ''}</p>
                </div>
                <span className="m-rank-val">{fmtMoney(s.total)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {topProducts.length > 0 && (
        <>
          <p className="m-label">Top Products</p>
          <div className="m-card">
            {topProducts.map((p: any, i: number) => (
              <div key={p.name} className="m-rank-row">
                <span className="m-rank-n">{i + 1}</span>
                <div className="m-rank-body">
                  <p className="m-rank-title">{p.name}</p>
                  <p className="m-rank-sub">×{p.count}</p>
                </div>
                <span className="m-rank-val">{fmtMoney(p.total)}</span>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="m-spacer" />
    </>
  )
}

// ── Settings tab ─────────────────────────────────────────────────────────────
function SettingsTab({ onOpenSettings, darkMode, onToggleDark }: any) {
  return (
    <>
      <p className="m-label">Appearance</p>
      <div className="m-card">
        <button className="m-setting-row" onClick={onToggleDark}>
          <span className="m-setting-label">Theme</span>
          <span className="m-setting-value">{darkMode ? 'Dark' : 'Light'}</span>
          <IconChevron />
        </button>
      </div>

      <p className="m-label">AI & Connection</p>
      <div className="m-card">
        <button className="m-setting-row" onClick={onOpenSettings}>
          <span className="m-setting-label">Backend & AI Engine</span>
          <IconChevron />
        </button>
      </div>

      <p className="m-label">About</p>
      <div className="m-card">
        <div className="m-info-row">
          <span className="m-setting-label">App</span>
          <span className="m-setting-value">Rezet</span>
        </div>
        <div className="m-info-row">
          <span className="m-setting-label">Version</span>
          <span className="m-setting-value">0.3.0</span>
        </div>
        <div className="m-info-row m-info-row--last">
          <span className="m-setting-label">Stack</span>
          <span className="m-setting-value">React · Capacitor</span>
        </div>
      </div>

      <div className="m-spacer" />
    </>
  )
}
