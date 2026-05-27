// Mobile UI — phone-first, Material 3 inspired layout.
// Renders when isMobile === true. Reuses backend types and helpers from App.tsx via props.

import { useState, useMemo } from 'react'
import {
  BarChart, Bar, XAxis, Tooltip, ResponsiveContainer, Cell,
  LineChart, Line, CartesianGrid,
} from 'recharts'

// ── Public types (mirror App.tsx) ───────────────────────────────────────────
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
  onScan: () => void                  // open scan/new receipt modal
  onOpenSettings: () => void
  onRowClick: (id: number) => void
  onClearError: () => void
  formatDate: (d: string) => string
  formatMonth: (m: string) => string
  catColor: (c: string) => string
}

type Tab = 'home' | 'receipts' | 'insights' | 'settings'

// ── Helpers ─────────────────────────────────────────────────────────────────
const fmtMoney = (n: number) => `€${n.toFixed(2)}`

// ── Component ───────────────────────────────────────────────────────────────
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
      {/* ── Top App Bar ── */}
      <div className="m-topbar">
        <div className="m-topbar-title">
          {tab === 'home' && 'Rezet'}
          {tab === 'receipts' && 'Receipts'}
          {tab === 'insights' && 'Insights'}
          {tab === 'settings' && 'Settings'}
        </div>
        <div className="m-topbar-actions">
          <button className="m-icon-btn" onClick={onToggleDark} aria-label="Toggle theme">
            {darkMode ? '☀' : '⏾'}
          </button>
        </div>
      </div>

      {/* ── Connection chip — only when not active ── */}
      {connectionStatus && connectionStatus !== 'Active' && (
        <div className="m-conn-chip">
          <span className="m-conn-dot" />
          <span>{connectionStatus}</span>
        </div>
      )}

      {/* ── Error banner ── */}
      {error && (
        <div className="m-error" onClick={onClearError}>
          <span>⚠</span><span>{error.split('\n')[0]}</span><span className="m-error-x">✕</span>
        </div>
      )}

      {/* ── Page content ── */}
      <div className="m-scroll">
        {tab === 'home' && (
          <HomeTab
            data={data}
            onRowClick={onRowClick}
            formatDate={formatDate}
            formatMonth={formatMonth}
            catColor={catColor}
            darkMode={darkMode}
          />
        )}
        {tab === 'receipts' && (
          <ReceiptsTab
            data={data}
            query={query}
            setQuery={setQuery}
            receipts={filteredReceipts}
            onRowClick={onRowClick}
            formatDate={formatDate}
            catColor={catColor}
          />
        )}
        {tab === 'insights' && (
          <InsightsTab insights={insights} data={data} catColor={catColor} />
        )}
        {tab === 'settings' && (
          <SettingsTab onOpenSettings={onOpenSettings} darkMode={darkMode} onToggleDark={onToggleDark} />
        )}
      </div>

      {/* ── FAB — only on home & receipts ── */}
      {(tab === 'home' || tab === 'receipts') && (
        <button className="m-fab" onClick={onScan} aria-label="Scan receipt">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
          </svg>
        </button>
      )}

      {/* ── Bottom Nav ── */}
      <nav className="m-bottomnav">
        <button className={`m-navitem${tab==='home'?' active':''}`} onClick={() => setTab('home')}>
          <NavIcon name="home" active={tab==='home'} /><span>Home</span>
        </button>
        <button className={`m-navitem${tab==='receipts'?' active':''}`} onClick={() => setTab('receipts')}>
          <NavIcon name="receipt" active={tab==='receipts'} /><span>Receipts</span>
        </button>
        <button className={`m-navitem${tab==='insights'?' active':''}`} onClick={() => setTab('insights')}>
          <NavIcon name="chart" active={tab==='insights'} /><span>Insights</span>
        </button>
        <button className={`m-navitem${tab==='settings'?' active':''}`} onClick={() => setTab('settings')}>
          <NavIcon name="settings" active={tab==='settings'} /><span>Settings</span>
        </button>
      </nav>

      {toast && <div className="m-toast">{toast.message}</div>}
    </div>
  )
}

// ── Nav icons ───────────────────────────────────────────────────────────────
function NavIcon({ name, active }: { name: string; active: boolean }) {
  const sw = active ? 2.2 : 1.8
  const c = 'currentColor'
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      {name === 'home' && (
        <>
          <path d="M3 11l9-8 9 8" stroke={c} strokeWidth={sw} strokeLinejoin="round"/>
          <path d="M5 10v10h4v-6h6v6h4V10" stroke={c} strokeWidth={sw} strokeLinejoin="round" fill={active ? 'currentColor' : 'none'} fillOpacity={active ? 0.15 : 0}/>
        </>
      )}
      {name === 'receipt' && (
        <>
          <path d="M6 3h12v18l-2-1.5L14 21l-2-1.5L10 21l-2-1.5L6 21V3z" stroke={c} strokeWidth={sw} strokeLinejoin="round" fill={active ? 'currentColor' : 'none'} fillOpacity={active ? 0.1 : 0}/>
          <path d="M9 8h6M9 12h6M9 16h4" stroke={c} strokeWidth={sw} strokeLinecap="round"/>
        </>
      )}
      {name === 'chart' && (
        <>
          <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" stroke={c} strokeWidth={sw} strokeLinecap="round"/>
        </>
      )}
      {name === 'settings' && (
        <>
          <circle cx="12" cy="12" r="3" stroke={c} strokeWidth={sw}/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" stroke={c} strokeWidth={sw} strokeLinejoin="round"/>
        </>
      )}
    </svg>
  )
}

// ── Tab: Home ───────────────────────────────────────────────────────────────
function HomeTab({ data, onRowClick, formatDate, formatMonth, catColor, darkMode }: any) {
  if (!data) {
    return (
      <div className="m-empty">
        <div className="m-empty-icon">📊</div>
        <h3>Loading your data…</h3>
        <p>Connecting to backend</p>
      </div>
    )
  }
  const hasReceipts = data.recent_receipts.length > 0
  if (!hasReceipts) {
    return (
      <div className="m-empty">
        <div className="m-empty-icon">📸</div>
        <h3>No receipts yet</h3>
        <p>Tap <strong>＋</strong> below to scan your first one.</p>
      </div>
    )
  }

  const mom = data.mom
  const useDaily = data.monthly_trend.length <= 1 && (data.daily_trend?.length ?? 0) > 0
  const trendData = useDaily
    ? data.daily_trend.map((d: any) => ({ ...d, label: formatDate(d.date).slice(0, 6) }))
    : data.monthly_trend.map((m: any) => ({ ...m, label: formatMonth(m.month) }))

  return (
    <>
      {/* ── Hero card: This Month ── */}
      <div className="m-hero">
        <div className="m-hero-label">This Month</div>
        <div className="m-hero-value">
          {fmtMoney(mom?.current_total ?? 0)}
        </div>
        <div className="m-hero-meta">
          <span>{mom?.current_receipt_count ?? 0} receipts</span>
          {mom?.delta_pct !== null && mom?.delta_pct !== undefined && mom.prev_total > 0 && (
            <span className={`m-hero-delta ${mom.delta_pct > 0 ? 'up' : 'down'}`}>
              {mom.delta_pct > 0 ? '↑' : '↓'} {Math.abs(mom.delta_pct).toFixed(0)}% vs last
            </span>
          )}
        </div>
      </div>

      {/* ── Quick stats: 2-column grid ── */}
      <div className="m-quickstats">
        <div className="m-stat">
          <div className="m-stat-icon" style={{ background: 'rgba(0,122,255,0.14)', color: '#0060e6' }}>💰</div>
          <div className="m-stat-text">
            <div className="m-stat-value">{fmtMoney(data.total_spent)}</div>
            <div className="m-stat-label">All time</div>
          </div>
        </div>
        <div className="m-stat">
          <div className="m-stat-icon" style={{ background: 'rgba(175,82,222,0.14)', color: '#7c3aed' }}>📜</div>
          <div className="m-stat-text">
            <div className="m-stat-value">{data.receipt_count}</div>
            <div className="m-stat-label">Receipts</div>
          </div>
        </div>
        <div className="m-stat">
          <div className="m-stat-icon" style={{ background: catColor(data.top_category) + '22', color: catColor(data.top_category) }}>🏷</div>
          <div className="m-stat-text">
            <div className="m-stat-value m-stat-value-sm">{data.top_category}</div>
            <div className="m-stat-label">Top category</div>
          </div>
        </div>
        <div className="m-stat">
          <div className="m-stat-icon" style={{ background: 'rgba(52,199,89,0.14)', color: '#0d8a3a' }}>📊</div>
          <div className="m-stat-text">
            <div className="m-stat-value">{data.category_spend.length}</div>
            <div className="m-stat-label">Categories</div>
          </div>
        </div>
      </div>

      {/* ── Spending chart ── */}
      <div className="m-section-header">
        <h3>{useDaily ? 'This Month · Daily' : '12-Month Trend'}</h3>
      </div>
      <div className="m-chart-card">
        <ResponsiveContainer width="100%" height={180}>
          {useDaily ? (
            <BarChart data={trendData} margin={{ top: 12, right: 8, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'} vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: darkMode ? '#a0a0ab' : '#86868b' }} axisLine={false} tickLine={false} />
              <Tooltip cursor={{ fill: darkMode ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)' }} />
              <Bar dataKey="total" radius={[6,6,0,0]}>
                {trendData.map((_:any, i:number) => (
                  <Cell key={i} fill="#0071e3" fillOpacity={0.9}/>
                ))}
              </Bar>
            </BarChart>
          ) : (
            <LineChart data={trendData} margin={{ top: 12, right: 12, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'} vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: darkMode ? '#a0a0ab' : '#86868b' }} axisLine={false} tickLine={false} />
              <Tooltip />
              <Line type="monotone" dataKey="total" stroke="#0071e3" strokeWidth={2.5}
                dot={{ fill: '#0071e3', r: 3, strokeWidth: 0 }} />
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>

      {/* ── Recent receipts ── */}
      <div className="m-section-header">
        <h3>Recent</h3>
      </div>
      <div className="m-list">
        {data.recent_receipts.slice(0, 6).map((r: any) => (
          <button key={r.id} className="m-listitem" onClick={() => onRowClick(r.id)}>
            <div className="m-listitem-dot" style={{ background: catColor(r.category) }} />
            <div className="m-listitem-text">
              <div className="m-listitem-name">{r.merchant || 'Unknown'}</div>
              <div className="m-listitem-meta">
                <span>{r.category}</span>
                <span>·</span>
                <span>{formatDate(r.date)}</span>
              </div>
            </div>
            <div className="m-listitem-amt">{fmtMoney(r.total_amount)}</div>
          </button>
        ))}
      </div>

      <div style={{ height: 100 }} /> {/* FAB clearance */}
    </>
  )
}

// ── Tab: Receipts ───────────────────────────────────────────────────────────
function ReceiptsTab({ query, setQuery, receipts, onRowClick, formatDate, catColor }: any) {
  return (
    <>
      <div className="m-searchbar">
        <span className="m-searchbar-icon">🔍</span>
        <input
          type="text"
          placeholder="Search merchants, categories…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
        />
        {query && (
          <button className="m-searchbar-clear" onClick={() => setQuery('')}>✕</button>
        )}
      </div>

      <div className="m-list">
        {receipts.length === 0 ? (
          <div className="m-empty m-empty-inline">
            <div className="m-empty-icon">📋</div>
            <h3>{query ? 'No matches' : 'No receipts yet'}</h3>
            <p>{query ? 'Try a different search term.' : 'Tap + to add one.'}</p>
          </div>
        ) : receipts.map((r: any) => (
          <button key={r.id} className="m-listitem" onClick={() => onRowClick(r.id)}>
            <div className="m-listitem-dot" style={{ background: catColor(r.category) }} />
            <div className="m-listitem-text">
              <div className="m-listitem-name">{r.merchant || 'Unknown'}</div>
              <div className="m-listitem-meta">
                <span>{r.category}</span>
                <span>·</span>
                <span>{formatDate(r.date)}</span>
                {r.has_image && <><span>·</span><span>📷</span></>}
              </div>
            </div>
            <div className="m-listitem-amt">{fmtMoney(r.total_amount)}</div>
          </button>
        ))}
      </div>
      <div style={{ height: 100 }} />
    </>
  )
}

// ── Tab: Insights ───────────────────────────────────────────────────────────
function InsightsTab({ insights, data, catColor }: any) {
  if (!insights && !data) return <div className="m-empty"><div className="m-empty-icon">📊</div><h3>No data</h3></div>

  const topStores = insights?.by_store?.slice(0, 5) ?? []
  const topProducts = insights?.by_product?.slice(0, 5) ?? []
  const cats = data?.category_spend?.slice(0, 6) ?? []
  const maxCat = cats[0]?.value ?? 1

  return (
    <>
      {cats.length > 0 && (
        <>
          <div className="m-section-header"><h3>By Category</h3></div>
          <div className="m-card">
            {cats.map((c: any) => (
              <div key={c.name} className="m-bar-row">
                <div className="m-bar-row-top">
                  <span><span className="m-dot" style={{ background: catColor(c.name) }} /> {c.name}</span>
                  <strong>{fmtMoney(c.value)}</strong>
                </div>
                <div className="m-bar-track">
                  <div className="m-bar-fill" style={{ width: `${(c.value / maxCat) * 100}%`, background: catColor(c.name) }} />
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {topStores.length > 0 && (
        <>
          <div className="m-section-header"><h3>Top Stores</h3></div>
          <div className="m-card">
            {topStores.map((s: any, i: number) => (
              <div key={s.merchant} className="m-rank-row">
                <span className="m-rank-num">{i + 1}</span>
                <div className="m-rank-text">
                  <div className="m-rank-name">{s.merchant}</div>
                  <div className="m-rank-meta">{s.visits} visit{s.visits !== 1 ? 's' : ''}</div>
                </div>
                <span className="m-rank-amt">{fmtMoney(s.total)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {topProducts.length > 0 && (
        <>
          <div className="m-section-header"><h3>Top Products</h3></div>
          <div className="m-card">
            {topProducts.map((p: any, i: number) => (
              <div key={p.name} className="m-rank-row">
                <span className="m-rank-num">{i + 1}</span>
                <div className="m-rank-text">
                  <div className="m-rank-name">{p.name}</div>
                  <div className="m-rank-meta">×{p.count}</div>
                </div>
                <span className="m-rank-amt">{fmtMoney(p.total)}</span>
              </div>
            ))}
          </div>
        </>
      )}
      <div style={{ height: 100 }} />
    </>
  )
}

// ── Tab: Settings ───────────────────────────────────────────────────────────
function SettingsTab({ onOpenSettings, darkMode, onToggleDark }: any) {
  return (
    <div className="m-settings">
      <div className="m-section-header"><h3>Appearance</h3></div>
      <div className="m-card">
        <button className="m-row-btn" onClick={onToggleDark}>
          <span>{darkMode ? '☀' : '⏾'}</span>
          <span className="m-row-btn-label">Theme</span>
          <span className="m-row-btn-value">{darkMode ? 'Dark' : 'Light'}</span>
        </button>
      </div>

      <div className="m-section-header"><h3>Backend & AI</h3></div>
      <div className="m-card">
        <button className="m-row-btn" onClick={onOpenSettings}>
          <span>⚙</span>
          <span className="m-row-btn-label">Connection & AI Engine</span>
          <span className="m-row-btn-chev">›</span>
        </button>
      </div>

      <div className="m-section-header"><h3>About</h3></div>
      <div className="m-card">
        <div className="m-row-info">
          <span className="m-row-info-label">Version</span>
          <span className="m-row-info-value">0.2.0</span>
        </div>
        <div className="m-row-info">
          <span className="m-row-info-label">Made with</span>
          <span className="m-row-info-value">React + Capacitor</span>
        </div>
      </div>
      <div style={{ height: 100 }} />
    </div>
  )
}
