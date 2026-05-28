// Mobile UI — polished redesign with animations.
// Renders when isMobile === true. Reuses backend types and helpers from App.tsx via props.

import { useState, useMemo, useEffect, useRef } from 'react'
import { isMobile, isLocalBackend } from './api'
import {
  BarChart, Bar, XAxis, Tooltip, ResponsiveContainer, Cell,
  CartesianGrid, Area, AreaChart,
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
const currentMonth = () => MONTHS[new Date().getMonth()]

// ── Hook: smooth count-up animation ──────────────────────────────────────────
function useCountUp(target: number, duration = 750): number {
  const [val, setVal] = useState(0)
  const raf = useRef<number>(0)
  useEffect(() => {
    const start = performance.now()
    const from = 0
    const step = (now: number) => {
      const p = Math.min((now - start) / duration, 1)
      const eased = 1 - Math.pow(1 - p, 3)
      setVal(from + (target - from) * eased)
      if (p < 1) raf.current = requestAnimationFrame(step)
    }
    raf.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf.current)
  }, [target])
  return val
}

// ── SVG Icons ────────────────────────────────────────────────────────────────
function NavIcon({ name, active }: { name: string; active: boolean }) {
  const sw = active ? 2.2 : 1.7
  const c  = 'currentColor'
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

const ChevronRight = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
    <path d="M9 18l6-6-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)

const SearchIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8"/>
    <path d="M21 21l-4.35-4.35" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
  </svg>
)

const CloseIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
    <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
  </svg>
)

const SunIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.8"/>
    <path d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
  </svg>
)

const MoonIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)

// ── Nav item ─────────────────────────────────────────────────────────────────
function NavItem({ name, label, active, onClick }:
  { name: string; label: string; active: boolean; onClick: () => void }) {
  return (
    <button className={`m-navitem${active ? ' m-navitem--active' : ''}`} onClick={onClick}>
      {active && <span className="m-nav-pip" />}
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

  const [tab, setTab]       = useState<Tab>('home')
  const [pageKey, setPageKey] = useState(0)
  const [query, setQuery]   = useState('')

  const needsSetup = isMobile && isLocalBackend() && !!error

  function switchTab(t: Tab) {
    if (t === tab) return
    setTab(t)
    setPageKey(k => k + 1)
  }

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
      <div className="m-topbar">
        <span className="m-wordmark">Rezet</span>
        <button className="m-icon-btn" onClick={onToggleDark} aria-label="Toggle theme">
          {darkMode ? <SunIcon /> : <MoonIcon />}
        </button>
      </div>

      {/* Status notices */}
      {connectionStatus && connectionStatus !== 'Active' && (
        <div className="m-notice m-notice--info">
          <span className="m-notice-dot" />
          {connectionStatus}
        </div>
      )}
      {error && !needsSetup && (
        <div className="m-notice m-notice--error" onClick={onClearError}>
          {error.split('\n')[0]}
        </div>
      )}

      {/* Page content */}
      <main className="m-scroll">
        <div className="m-page" key={pageKey}>
          {needsSetup && tab !== 'settings'
            ? <SetupCard onOpenSettings={() => { switchTab('settings'); onOpenSettings() }} />
            : tab === 'home'     ? <HomeTab data={data} onRowClick={onRowClick} formatDate={formatDate} formatMonth={formatMonth} catColor={catColor} darkMode={darkMode} />
            : tab === 'receipts' ? <ReceiptsTab data={data} query={query} setQuery={setQuery} receipts={filteredReceipts} onRowClick={onRowClick} formatDate={formatDate} catColor={catColor} />
            : tab === 'insights' ? <InsightsTab insights={insights} data={data} catColor={catColor} />
            : <SettingsTab onOpenSettings={onOpenSettings} darkMode={darkMode} onToggleDark={onToggleDark} />
          }
        </div>
      </main>

      {/* Bottom nav — FAB in center slot */}
      <nav className="m-nav">
        <NavItem name="home"    label="Home"     active={tab==='home'}     onClick={() => switchTab('home')} />
        <NavItem name="receipt" label="Receipts" active={tab==='receipts'} onClick={() => switchTab('receipts')} />
        <button className="m-nav-fab" onClick={onScan} aria-label="Add receipt">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
          </svg>
        </button>
        <NavItem name="chart"   label="Insights" active={tab==='insights'} onClick={() => switchTab('insights')} />
        <NavItem name="gear"    label="Settings" active={tab==='settings'} onClick={() => switchTab('settings')} />
      </nav>

      {toast && <div className="m-toast">{toast.message}</div>}
    </div>
  )
}

// ── Setup card ───────────────────────────────────────────────────────────────
function SetupCard({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className="m-setup">
      <div className="m-setup-icon">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none">
          <path className="m-wifi-3" d="M5 12.55a11 11 0 0 1 14.08 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
          <path className="m-wifi-2" d="M1.42 9a16 16 0 0 1 21.16 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
          <path className="m-wifi-1" d="M8.53 16.11a6 6 0 0 1 6.95 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
          <circle cx="12" cy="20" r="1.2" fill="currentColor"/>
        </svg>
      </div>
      <p className="m-setup-title">Connect to your Mac</p>
      <p className="m-setup-body">
        Rezet's AI runs on your Mac. <strong>localhost</strong> won't work from a phone — you need your Mac's local IP.
      </p>
      <div className="m-setup-steps">
        <div className="m-setup-step">
          <span className="m-setup-n">1</span>
          <span>On your Mac, open Terminal and run:</span>
        </div>
        <div className="m-setup-code">ipconfig getifaddr en0</div>
        <div className="m-setup-step">
          <span className="m-setup-n">2</span>
          <span>Make sure Rezet is open and running on the Mac</span>
        </div>
        <div className="m-setup-step">
          <span className="m-setup-n">3</span>
          <span>Tap below and enter the IP, e.g.:</span>
        </div>
        <div className="m-setup-code">http://192.168.1.42:8888</div>
      </div>
      <button className="m-setup-btn" onClick={onOpenSettings}>
        Open Settings
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ marginLeft: 6 }}>
          <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
    </div>
  )
}

// ── Home tab ─────────────────────────────────────────────────────────────────
function HomeTab({ data, onRowClick, formatDate, formatMonth, catColor, darkMode }: any) {
  const mom = data?.mom
  const animAmount = useCountUp(mom?.current_total ?? 0, 800)

  if (!data) return (
    <div className="m-empty">
      <div className="m-skeleton m-skeleton-hero" />
      <div className="m-skeleton-row">
        <div className="m-skeleton m-skeleton-card" />
        <div className="m-skeleton m-skeleton-card" />
      </div>
      <div className="m-skeleton-row">
        <div className="m-skeleton m-skeleton-card" />
        <div className="m-skeleton m-skeleton-card" />
      </div>
    </div>
  )

  if (!data.recent_receipts.length) return (
    <div className="m-empty">
      <div className="m-empty-glyph">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
          <path d="M6 3h12v18l-2-1.5L14 21l-2-1.5L10 21l-2-1.5L6 21V3z"
            stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
          <path d="M9 8h6M9 12h6M9 16h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </div>
      <p className="m-empty-title">No receipts yet</p>
      <p className="m-empty-sub">Tap + to scan your first receipt</p>
    </div>
  )

  const useDaily = data.monthly_trend.length <= 1 && (data.daily_trend?.length ?? 0) > 0
  const trendData = useDaily
    ? data.daily_trend.map((d: any) => ({ ...d, label: formatDate(d.date).slice(0, 6) }))
    : data.monthly_trend.map((m: any) => ({ ...m, label: formatMonth(m.month) }))

  const gridColor = darkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)'
  const tickColor = darkMode ? '#48484a' : '#c7c7cc'
  const ttStyle  = {
    background: darkMode ? '#2c2c2e' : '#fff',
    border: 'none',
    borderRadius: 10,
    fontSize: 12,
    color: darkMode ? '#fff' : '#1c1c1e',
    boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
  }

  return (
    <>
      {/* Hero */}
      <div className="m-hero">
        <p className="m-hero-eyebrow">{currentMonth()} spending</p>
        <p className="m-hero-amount">€{animAmount.toFixed(2)}</p>
        <div className="m-hero-sub">
          <span>{mom?.current_receipt_count ?? 0} receipts</span>
          {mom?.delta_pct != null && (mom.prev_total ?? 0) > 0 && (
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
              <Tooltip cursor={{ fill: darkMode ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)' }} contentStyle={ttStyle} />
              <Bar dataKey="total" radius={[5,5,0,0]}>
                {trendData.map((_: any, i: number) => <Cell key={i} fill="#34c759" fillOpacity={0.85} />)}
              </Bar>
            </BarChart>
          ) : (
            <AreaChart data={trendData} margin={{ top: 8, right: 4, left: -22, bottom: 0 }}>
              <defs>
                <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#34c759" stopOpacity={0.25}/>
                  <stop offset="100%" stopColor="#34c759" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: tickColor }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={ttStyle} />
              <Area type="monotone" dataKey="total" stroke="#34c759" strokeWidth={2.5}
                fill="url(#areaGrad)" dot={false} activeDot={{ r: 4, fill: '#34c759', strokeWidth: 0 }} />
            </AreaChart>
          )}
        </ResponsiveContainer>
      </div>

      {/* Recent receipts */}
      <p className="m-label">Recent</p>
      <div className="m-list">
        {data.recent_receipts.slice(0, 6).map((r: any) => (
          <button key={r.id} className="m-row" onClick={() => onRowClick(r.id)}>
            <div className="m-row-avatar" style={{ background: catColor(r.category) + '22' }}>
              <div className="m-row-dot" style={{ background: catColor(r.category) }} />
            </div>
            <div className="m-row-body">
              <p className="m-row-title">{r.merchant || 'Unknown'}</p>
              <p className="m-row-sub">{r.category} · {formatDate(r.date)}</p>
            </div>
            <div className="m-row-right">
              <p className="m-row-amount">{fmtMoney(r.total_amount)}</p>
              <ChevronRight />
            </div>
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
        <SearchIcon />
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
            <CloseIcon />
          </button>
        )}
      </div>

      {receipts.length === 0 ? (
        <div className="m-empty">
          <div className="m-empty-glyph">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
              <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M21 21l-4.35-4.35" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </div>
          <p className="m-empty-title">{query ? 'No matches' : 'No receipts yet'}</p>
          <p className="m-empty-sub">{query ? 'Try a different search term' : 'Tap + to add one'}</p>
        </div>
      ) : (
        <div className="m-list">
          {receipts.map((r: any) => (
            <button key={r.id} className="m-row" onClick={() => onRowClick(r.id)}>
              <div className="m-row-avatar" style={{ background: catColor(r.category) + '22' }}>
                <div className="m-row-dot" style={{ background: catColor(r.category) }} />
              </div>
              <div className="m-row-body">
                <p className="m-row-title">{r.merchant || 'Unknown'}</p>
                <p className="m-row-sub">
                  {r.category} · {formatDate(r.date)}{r.has_image ? ' · 📷' : ''}
                </p>
              </div>
              <div className="m-row-right">
                <p className="m-row-amount">{fmtMoney(r.total_amount)}</p>
                <ChevronRight />
              </div>
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
            {cats.map((c: any, i: number) => (
              <div key={c.name} className="m-bar-row" style={{ animationDelay: `${i * 0.05}s` }}>
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
function SettingsRow({ icon, label, value, onClick }: { icon: string; label: string; value?: string; onClick?: () => void }) {
  const el = (
    <div className={`m-setting-row${onClick ? ' m-setting-row--btn' : ''}`}
      onClick={onClick} role={onClick ? 'button' : undefined}>
      <span className="m-setting-icon">{icon}</span>
      <span className="m-setting-label">{label}</span>
      {value && <span className="m-setting-value">{value}</span>}
      {onClick && <span className="m-setting-chev"><ChevronRight /></span>}
    </div>
  )
  return el
}

function SettingsTab({ onOpenSettings, darkMode, onToggleDark }: any) {
  return (
    <>
      <p className="m-label">Appearance</p>
      <div className="m-card">
        <SettingsRow icon="🎨" label="Theme" value={darkMode ? 'Dark' : 'Light'} onClick={onToggleDark} />
      </div>

      <p className="m-label">AI & Connection</p>
      <div className="m-card">
        <SettingsRow icon="🔗" label="Backend & AI Engine" onClick={onOpenSettings} />
      </div>

      <p className="m-label">About</p>
      <div className="m-card">
        <SettingsRow icon="📱" label="App" value="Rezet" />
        <SettingsRow icon="🏷" label="Version" value="0.3.0" />
        <SettingsRow icon="⚙️" label="Stack" value="React · Capacitor" />
      </div>

      <div className="m-spacer" />
    </>
  )
}
