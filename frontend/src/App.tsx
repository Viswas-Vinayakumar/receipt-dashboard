import { useState, useEffect, useRef, useMemo } from 'react'
import { Command } from '@tauri-apps/plugin-shell'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, Cell, LabelList,
} from 'recharts'
import './App.css'

// ── Types ──────────────────────────────────────────────────────────────────
interface DashboardData {
  total_spent: number;
  receipt_count: number;
  top_category: string;
  category_spend: { name: string; value: number; count: number }[];
  recent_receipts: { id: number; merchant: string; date: string; total_amount: number; category: string }[];
}

interface DetailReceipt {
  id: number;
  merchant: string;
  location: string;
  date: string;
  total_amount: number;
  items: { product_name: string; category: string; price: number }[];
}

interface Toast {
  message: string;
  onUndo?: () => void;
  id: number;
}

type SortOption = 'date-desc' | 'date-asc' | 'amount-desc' | 'amount-asc' | 'merchant'

// ── Constants ──────────────────────────────────────────────────────────────
const CATEGORY_COLORS: Record<string, string> = {
  Groceries:   '#34d399',
  Bakery:      '#fb923c',
  Beverages:   '#60a5fa',
  Electronics: '#a78bfa',
  Dining:      '#f472b6',
  Transport:   '#38bdf8',
  Health:      '#f87171',
  Deposit:     '#94a3b8',
  Others:      '#fbbf24',
}

const categoryColor = (name: string) => CATEGORY_COLORS[name] ?? '#94a3b8'

// ── Component ──────────────────────────────────────────────────────────────
function App() {
  // Core state
  const [data, setData]                     = useState<DashboardData | null>(null)
  const [loading, setLoading]               = useState(false)
  const [error, setError]                   = useState<string | null>(null)
  const [rateLimitWarn, setRateLimitWarn]   = useState<string | null>(null)
  const [toast, setToast]                   = useState<Toast | null>(null)
  const [showUpload, setShowUpload]         = useState(false)
  const [uploadStatus, setUploadStatus]     = useState('')
  const [connectionStatus, setConnectionStatus] = useState('Initializing...')
  // Modals
  const [showResetModal, setShowResetModal] = useState(false)
  const [detailReceipt, setDetailReceipt]   = useState<DetailReceipt | null>(null)
  const [loadingDetail, setLoadingDetail]   = useState(false)
  // Table controls
  const [searchQuery, setSearchQuery]       = useState('')
  const [sortBy, setSortBy]                 = useState<SortOption>('date-desc')
  const [filterCategory, setFilterCategory] = useState('')

  const fileInputRef   = useRef<HTMLInputElement>(null)
  const undoTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchRef      = useRef<HTMLInputElement>(null)

  // ── Data fetching ────────────────────────────────────────────────────────
  const fetchData = async () => {
    for (const base of ['http://127.0.0.1:8888', 'http://localhost:8888']) {
      try {
        const res = await tauriFetch(`${base}/api/dashboard`)
        if (res.ok) {
          setData(await res.json())
          setError(null)
          setConnectionStatus('Active')
          return
        }
      } catch {}
    }
    setConnectionStatus('Waiting...')
  }

  // ── Sidecar lifecycle ────────────────────────────────────────────────────
  useEffect(() => {
    let started = false
    let cancelled = false

    const startBackend = async () => {
      if (started || cancelled) return
      started = true
      try {
        setConnectionStatus('Starting AI Engine...')
        const command = Command.sidecar('backend')
        command.stdout.on('data', (l: string) => console.log('[backend]', l))
        command.stderr.on('data', (l: string) => console.warn('[backend]', l))

        command.on('close', async ({ code }: { code: number | null }) => {
          if (cancelled) return
          console.log(`[sidecar] exited code=${code}`)
          started = false
          await new Promise(r => setTimeout(r, 1500))
          if (cancelled) return
          try {
            const res = await tauriFetch('http://127.0.0.1:8888/api/health')
            if (res.ok) { setConnectionStatus('Active'); fetchData(); return }
          } catch {}
          setConnectionStatus('Engine Stopped')
          setTimeout(() => { if (!cancelled) startBackend() }, 3000)
        })

        command.on('error', (err: string) => {
          if (cancelled) return
          setError(`Failed to start AI engine: ${err}`)
          setConnectionStatus('Security Blocked')
        })

        await command.spawn()

        let connected = false
        for (let i = 0; i < 45; i++) {
          if (cancelled) return
          setConnectionStatus(`Connecting (${i + 1}/45)…`)
          try {
            const res = await tauriFetch('http://127.0.0.1:8888/api/health')
            if (res.ok) { connected = true; break }
          } catch {}
          await new Promise(r => setTimeout(r, 1000))
        }
        if (cancelled) return
        if (connected) { fetchData() }
        else {
          started = false
          setError('AI engine not responding on port 8888. Check ~/receipt-dashboard/app_data/backend.log.')
          setConnectionStatus('Connection Failed')
        }
      } catch (err) {
        started = false
        setError(`macOS blocked the AI engine: ${err}`)
        setConnectionStatus('Security Blocked')
      }
    }

    startBackend()
    return () => { cancelled = true; started = false }
  }, [])

  // ── Toast ────────────────────────────────────────────────────────────────
  const showToast = (message: string, onUndo?: () => void) => {
    setToast({ message, onUndo, id: Date.now() })
    if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current)
    undoTimeoutRef.current = setTimeout(() => setToast(null), 5000)
  }

  // ── Upload ───────────────────────────────────────────────────────────────
  // Parse backend error message from JSON or plain text
  const parseErrDetail = async (res: Response): Promise<{ msg: string; isRateLimit: boolean; waitSec: number }> => {
    const raw = await res.text().catch(() => res.statusText)
    let msg = raw
    try {
      const parsed = JSON.parse(raw)
      msg = parsed.detail ?? parsed.message ?? raw
    } catch {}
    const isRateLimit = res.status === 429
    const m = msg.match(/(\d+)s\.?$/)
    const waitSec = isRateLimit && m ? parseInt(m[1]) : 0
    return { msg, isRateLimit, waitSec }
  }

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (!files.length) return
    setLoading(true); setError(null); setRateLimitWarn(null)
    let ok = 0
    const errs: string[] = []
    const rateLimitMsgs: string[] = []
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        setUploadStatus(files.length > 1 ? `Analyzing ${i + 1} of ${files.length}…` : 'Gemini AI is analyzing your receipt…')
        try {
          const buf = await file.arrayBuffer()
          const form = new FormData()
          form.append('file', new Blob([buf], { type: file.type || 'image/jpeg' }), file.name)
          const res = await tauriFetch('http://127.0.0.1:8888/api/upload', { method: 'POST', body: form })
          if (!res.ok) {
            const { msg, isRateLimit } = await parseErrDetail(res)
            if (isRateLimit) {
              rateLimitMsgs.push(msg)
            } else {
              throw new Error(`${file.name}: ${msg}`)
            }
          } else {
            ok++
          }
        } catch (err) {
          errs.push(err instanceof Error ? err.message : `${file.name}: upload failed`)
        }
      }
      await fetchData()
      if (rateLimitMsgs.length) {
        setRateLimitWarn(rateLimitMsgs[0])
      }
      if (!errs.length && !rateLimitMsgs.length) {
        setShowUpload(false)
        showToast(ok === 1 ? 'Receipt processed successfully' : `${ok} receipts processed`)
      } else if (errs.length) {
        setError(errs.length === 1 ? errs[0] : `${errs.length} of ${files.length} failed — ${errs.join('; ')}`)
        if (ok > 0) showToast(`${ok} of ${files.length} receipts processed`)
      } else if (ok > 0) {
        showToast(`${ok} of ${files.length} receipts processed`)
      }
    } finally {
      setLoading(false); setUploadStatus('')
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // ── Delete with undo ─────────────────────────────────────────────────────
  const handleDelete = async (e: React.MouseEvent, id: number) => {
    e.stopPropagation()
    if (!data) return
    const snapshot = data
    setData({ ...data, recent_receipts: data.recent_receipts.filter(r => r.id !== id) })

    const doDelete = async () => {
      try {
        const res = await tauriFetch(`http://127.0.0.1:8888/api/receipts/${id}`, { method: 'DELETE' })
        if (!res.ok) throw new Error()
        await fetchData()
      } catch {
        setData(snapshot)
        showToast('Failed to delete receipt')
      }
    }

    const timer = setTimeout(doDelete, 5000)
    showToast('Receipt deleted', () => {
      clearTimeout(timer)
      setData(snapshot)
      if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current)
      setToast(null)
    })
  }

  // ── Reset ────────────────────────────────────────────────────────────────
  const doReset = async () => {
    setShowResetModal(false)
    try {
      const res = await tauriFetch('http://127.0.0.1:8888/api/reset', { method: 'POST' })
      if (!res.ok) throw new Error()
      setSearchQuery(''); setFilterCategory('')
      await fetchData(); showToast('All data cleared')
    } catch { showToast('Failed to reset data') }
  }

  // ── Receipt detail ───────────────────────────────────────────────────────
  const handleRowClick = async (id: number) => {
    setLoadingDetail(true)
    setDetailReceipt(null)
    try {
      for (const base of ['http://127.0.0.1:8888', 'http://localhost:8888']) {
        try {
          const res = await tauriFetch(`${base}/api/receipts`)
          if (res.ok) {
            const receipts: DetailReceipt[] = await res.json()
            const found = receipts.find(r => r.id === id)
            if (found) { setDetailReceipt(found); return }
          }
        } catch {}
      }
      showToast('Could not load receipt details')
    } finally {
      setLoadingDetail(false)
    }
  }

  // ── Export CSV ───────────────────────────────────────────────────────────
  const exportCSV = () => {
    if (!displayedReceipts.length) return
    const header = ['Merchant', 'Category', 'Date', 'Amount (€)']
    const rows = displayedReceipts.map(r => [
      r.merchant, r.category, formatDate(r.date), r.total_amount.toFixed(2)
    ])
    const csv = [header, ...rows]
      .map(row => row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))
      .join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }))
    const a = Object.assign(document.createElement('a'), {
      href: url,
      download: `receipts-${new Date().toISOString().split('T')[0]}.csv`,
    })
    a.click()
    URL.revokeObjectURL(url)
    showToast(`Exported ${displayedReceipts.length} receipt${displayedReceipts.length !== 1 ? 's' : ''}`)
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  const formatDate = (s: string) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const [y, m, d] = s.split('-'); return `${d}.${m}.${y}`
    }
    const sh = s.match(/^(\d{2})\.(\d{2})\.(\d{2})$/)
    if (sh) return `${sh[1]}.${sh[2]}.20${sh[3]}`
    return s
  }

  // ── Derived values ───────────────────────────────────────────────────────
  const isActive    = connectionStatus === 'Active'
  const isError     = connectionStatus.includes('Failed') || connectionStatus.includes('Blocked') || connectionStatus.includes('Stopped')
  const dotClass    = isActive ? 'dot-active' : isError ? 'dot-error' : 'dot-warn'
  const statusColor = isActive ? '#10b981' : isError ? '#ef4444' : '#f59e0b'
  const chartTotal  = data?.category_spend.reduce((s, e) => s + e.value, 0) ?? 0
  const isFiltered  = !!(searchQuery.trim() || filterCategory)

  const displayedReceipts = useMemo(() => {
    if (!data) return []
    let list = [...data.recent_receipts]
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      list = list.filter(r => r.merchant.toLowerCase().includes(q) || r.category.toLowerCase().includes(q))
    }
    if (filterCategory) {
      list = list.filter(r => r.category === filterCategory)
    }
    list.sort((a, b) => {
      switch (sortBy) {
        case 'date-asc':    return a.date.localeCompare(b.date)
        case 'date-desc':   return b.date.localeCompare(a.date)
        case 'amount-desc': return b.total_amount - a.total_amount
        case 'amount-asc':  return a.total_amount - b.total_amount
        case 'merchant':    return a.merchant.localeCompare(b.merchant)
      }
    })
    return list
  }, [data, searchQuery, sortBy, filterCategory])

  const filteredTotal = displayedReceipts.reduce((s, r) => s + r.total_amount, 0)

  // ── Chart tooltip ────────────────────────────────────────────────────────
  const ChartTooltip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null
    const d = payload[0].payload
    const pct = chartTotal > 0 ? Math.round((d.value / chartTotal) * 100) : 0
    return (
      <div className="chart-tip">
        <span className="chart-tip-dot" style={{ background: categoryColor(d.name) }} />
        <div>
          <div className="chart-tip-name">{d.name}</div>
          <div className="chart-tip-meta">
            <strong>€{d.value.toFixed(2)}</strong>
            <span className="chart-tip-sep">·</span>
            <span>{pct}% of total</span>
            <span className="chart-tip-sep">·</span>
            <span>{d.count} item{d.count !== 1 ? 's' : ''}</span>
          </div>
        </div>
      </div>
    )
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="app-container">

      {/* ── Header ── */}
      <header>
        <div>
          <h1>Receipt Dashboard</h1>
          <p className="subtitle">Your spending at a glance</p>
        </div>
        <div className="action-bar">
          <button className="btn btn-secondary" onClick={() => setShowResetModal(true)}>Reset</button>
          <button className="btn btn-primary" onClick={() => setShowUpload(s => !s)}>
            {showUpload ? 'Cancel' : '+ New Receipt'}
          </button>
        </div>
      </header>

      {/* ── Rate-limit warning banner ── */}
      {rateLimitWarn && (
        <div className="rate-limit-banner" onClick={() => setRateLimitWarn(null)}>
          <span className="rate-limit-icon">⏱</span>
          <span>{rateLimitWarn}</span>
          <span className="error-close">✕</span>
        </div>
      )}

      {/* ── Error banner ── */}
      {error && (
        <div className="error-banner" onClick={() => setError(null)}>
          <span>⚠ {error}</span>
          <span className="error-close">✕</span>
        </div>
      )}

      {/* ── Stat cards ── */}
      <div className="dashboard-grid">
        <div className="card stat-card" style={{ animationDelay: '0.05s' }}>
          <h3>Total Spent</h3>
          <div className="stat-value">€{data?.total_spent.toFixed(2) ?? '0.00'}</div>
          {data && data.receipt_count > 0 && (
            <div className="stat-sub">avg €{(data.total_spent / data.receipt_count).toFixed(2)} / receipt</div>
          )}
        </div>
        <div className="card stat-card" style={{ animationDelay: '0.1s' }}>
          <h3>Receipts</h3>
          <div className="stat-value">{data?.receipt_count ?? 0}</div>
          {data && data.category_spend.length > 0 && (
            <div className="stat-sub">{data.category_spend.length} categories</div>
          )}
        </div>
        <div className="card stat-card" style={{ animationDelay: '0.15s' }}>
          <h3>Top Category</h3>
          <div className="stat-value category-badge" style={{ fontSize: '20px' }}>
            {data?.top_category && data.top_category !== 'N/A' && (
              <span className="cat-dot" style={{ background: categoryColor(data.top_category) }} />
            )}
            {data?.top_category || 'N/A'}
          </div>
          {data && data.category_spend.length > 0 && data.top_category !== 'N/A' && (() => {
            const top = data.category_spend.find(c => c.name === data.top_category)
            const pct = chartTotal > 0 && top ? Math.round((top.value / chartTotal) * 100) : 0
            return <div className="stat-sub">{pct}% of spending</div>
          })()}
        </div>
        <div className="card stat-card" style={{ animationDelay: '0.2s' }}>
          <h3>Engine</h3>
          <div className="stat-value status-row" style={{ fontSize: '18px', color: statusColor }}>
            <span className={`status-dot ${dotClass}`} />
            {connectionStatus}
          </div>
        </div>
      </div>

      {/* ── Category chart ── */}
      {data && data.category_spend.length > 0 && (
        <section className="card chart-card" style={{ animationDelay: '0.25s' }}>
          <div className="chart-header">
            <h3>Spending by Category</h3>
            <span className="chart-total">{data.category_spend.length} categories · €{chartTotal.toFixed(2)} total</span>
          </div>
          <ResponsiveContainer width="100%" height={Math.max(100, data.category_spend.length * 56)}>
            <BarChart
              data={data.category_spend}
              layout="vertical"
              margin={{ top: 4, right: 110, left: 0, bottom: 4 }}
            >
              <XAxis type="number" hide domain={[0, 'dataMax']} />
              <YAxis
                type="category"
                dataKey="name"
                width={110}
                tick={{ fontSize: 13, fill: '#86868b' }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(0,0,0,0.03)' }} />
              <Bar dataKey="value" radius={[0, 6, 6, 0]} isAnimationActive animationDuration={900} animationEasing="ease-out">
                {data.category_spend.map(e => (
                  <Cell key={e.name} fill={categoryColor(e.name)} />
                ))}
                <LabelList
                  dataKey="value"
                  position="right"
                  formatter={(v: unknown) => {
                    const pct = chartTotal > 0 ? Math.round((Number(v) / chartTotal) * 100) : 0
                    return `€${Number(v).toFixed(2)}  ${pct}%`
                  }}
                  style={{ fontSize: 12, fill: '#86868b', fontWeight: 500 }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </section>
      )}

      {/* ── Upload panel ── */}
      {showUpload && (
        <section className="card upload-card">
          <h3>Upload Receipt</h3>
          <div className="upload-zone" onClick={() => fileInputRef.current?.click()}>
            <input
              type="file" ref={fileInputRef} onChange={handleUpload}
              style={{ display: 'none' }} accept="image/*" multiple
            />
            {loading ? (
              <div className="upload-loading">
                <div className="loading-spinner" />
                <p>{uploadStatus || 'Gemini AI is analyzing your receipt…'}</p>
              </div>
            ) : (
              <>
                <div className="upload-icon">↑</div>
                <p className="upload-title">Select receipt images</p>
                <p className="upload-hint">Supports German &amp; English · Hold ⌘ to select multiple</p>
              </>
            )}
          </div>
        </section>
      )}

      {/* ── Transactions ── */}
      <section className="card transactions-card" style={{ animationDelay: '0.3s' }}>
        <div className="section-header">
          <h3>Transactions</h3>
          <span className="tx-count">
            {data && data.receipt_count > 0 && (
              isFiltered
                ? `${displayedReceipts.length} of ${data.receipt_count}`
                : `${data.receipt_count} total`
            )}
          </span>
        </div>

        {/* ── Toolbar ── */}
        {data && data.receipt_count > 0 && (
          <div className="table-toolbar">
            <div className="toolbar-left">
              <div className="search-box">
                <span className="search-icon">⌕</span>
                <input
                  ref={searchRef}
                  className="search-input"
                  type="text"
                  placeholder="Search merchants…"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                />
                {searchQuery && (
                  <button className="search-clear" onClick={() => { setSearchQuery(''); searchRef.current?.focus() }}>×</button>
                )}
              </div>
              <select className="select-ctrl" value={filterCategory} onChange={e => setFilterCategory(e.target.value)}>
                <option value="">All Categories</option>
                {data.category_spend.map(c => (
                  <option key={c.name} value={c.name}>{c.name}</option>
                ))}
              </select>
              <select className="select-ctrl" value={sortBy} onChange={e => setSortBy(e.target.value as SortOption)}>
                <option value="date-desc">Newest first</option>
                <option value="date-asc">Oldest first</option>
                <option value="amount-desc">Highest amount</option>
                <option value="amount-asc">Lowest amount</option>
                <option value="merchant">Merchant A→Z</option>
              </select>
              {isFiltered && (
                <button className="btn-clear" onClick={() => { setSearchQuery(''); setFilterCategory('') }}>
                  Clear filters
                </button>
              )}
            </div>
            <div className="toolbar-right">
              <button className="btn btn-icon" title="Print / Save as PDF" onClick={() => window.print()}>
                ⎙
              </button>
              <button
                className="btn btn-export"
                onClick={exportCSV}
                disabled={displayedReceipts.length === 0}
              >
                ↓ Export CSV
              </button>
            </div>
          </div>
        )}

        <table>
          <thead>
            <tr>
              <th>Merchant</th>
              <th>Category</th>
              <th>Date</th>
              <th>Amount</th>
              <th style={{ width: 44 }} />
            </tr>
          </thead>
          <tbody>
            {displayedReceipts.map((r, i) => (
              <tr
                key={r.id}
                style={{ animationDelay: `${0.05 + i * 0.03}s` }}
                className="tx-row"
                onClick={() => handleRowClick(r.id)}
                title="View receipt details"
              >
                <td className="tx-merchant">
                  <span className="tx-cat-dot" style={{ background: categoryColor(r.category) }} />
                  {r.merchant}
                </td>
                <td>
                  <span className="tx-badge" style={{ background: categoryColor(r.category) + '22', color: categoryColor(r.category) }}>
                    {r.category}
                  </span>
                </td>
                <td className="tx-date">{formatDate(r.date)}</td>
                <td className="tx-amount">€{r.total_amount.toFixed(2)}</td>
                <td>
                  <button className="delete-btn" onClick={e => handleDelete(e, r.id)}>✕</button>
                </td>
              </tr>
            ))}

            {/* Empty: no data at all */}
            {(!data || data.recent_receipts.length === 0) && (
              <tr>
                <td colSpan={5} className="empty-state">
                  <div className="empty-icon">🧾</div>
                  <p>No receipts yet</p>
                  <p className="empty-hint">Click "+ New Receipt" to get started</p>
                </td>
              </tr>
            )}

            {/* Empty: filtered but no matches */}
            {data && data.recent_receipts.length > 0 && displayedReceipts.length === 0 && (
              <tr>
                <td colSpan={5} className="empty-state">
                  <div className="empty-icon">🔍</div>
                  <p>No matching receipts</p>
                  <p className="empty-hint">Try adjusting your search or filters</p>
                </td>
              </tr>
            )}
          </tbody>

          {/* Filtered total footer */}
          {displayedReceipts.length > 0 && (
            <tfoot>
              <tr className="tx-footer">
                <td colSpan={3}>
                  {isFiltered ? `Showing ${displayedReceipts.length} of ${data?.receipt_count}` : `${displayedReceipts.length} receipt${displayedReceipts.length !== 1 ? 's' : ''}`}
                </td>
                <td className="tx-amount tx-footer-total">€{filteredTotal.toFixed(2)}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </section>

      {/* ── Receipt detail modal ── */}
      {(loadingDetail || detailReceipt) && (
        <div className="modal-overlay" onClick={() => { setDetailReceipt(null); setLoadingDetail(false) }}>
          <div className="modal detail-modal" onClick={e => e.stopPropagation()}>
            {loadingDetail ? (
              <div className="detail-loading">
                <div className="loading-spinner" />
                <p>Loading receipt…</p>
              </div>
            ) : detailReceipt && (
              <>
                <div className="detail-header">
                  <div className="detail-header-info">
                    <h2 className="modal-title">{detailReceipt.merchant}</h2>
                    {detailReceipt.location && (
                      <p className="detail-location">{detailReceipt.location}</p>
                    )}
                    <p className="detail-meta">{formatDate(detailReceipt.date)}</p>
                  </div>
                  <button className="detail-close" onClick={() => setDetailReceipt(null)}>✕</button>
                </div>

                <div className="detail-items">
                  {detailReceipt.items.length === 0 ? (
                    <p className="detail-no-items">No item breakdown available</p>
                  ) : detailReceipt.items.map((item, i) => (
                    <div key={i} className="detail-item">
                      <div className="detail-item-left">
                        <span className="tx-cat-dot" style={{ background: categoryColor(item.category), width: 8, height: 8, flexShrink: 0 }} />
                        <span className="detail-item-name">{item.product_name}</span>
                      </div>
                      <div className="detail-item-right">
                        <span className="tx-badge" style={{ background: categoryColor(item.category) + '22', color: categoryColor(item.category) }}>
                          {item.category}
                        </span>
                        <span className="detail-item-price">€{item.price.toFixed(2)}</span>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="detail-footer">
                  <span>Total paid</span>
                  <strong>€{detailReceipt.total_amount.toFixed(2)}</strong>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Reset confirm modal ── */}
      {showResetModal && (
        <div className="modal-overlay" onClick={() => setShowResetModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-icon">⚠️</div>
            <h2 className="modal-title">Clear all data?</h2>
            <p className="modal-body">This will permanently delete all receipts and cannot be undone.</p>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setShowResetModal(false)}>Cancel</button>
              <button className="btn btn-danger" onClick={doReset}>Clear All</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Toast ── */}
      {toast && (
        <div className="toast">
          <span>{toast.message}</span>
          {toast.onUndo && (
            <button className="undo-btn" onClick={toast.onUndo}>Undo</button>
          )}
        </div>
      )}
    </div>
  )
}

export default App
