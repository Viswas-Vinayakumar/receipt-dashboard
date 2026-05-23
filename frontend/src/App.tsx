import { useState, useEffect, useRef } from 'react'
import { Command } from '@tauri-apps/plugin-shell'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, Cell, LabelList,
} from 'recharts'
import './App.css'

interface DashboardData {
  total_spent: number;
  receipt_count: number;
  top_category: string;
  category_spend: { name: string; value: number }[];
  recent_receipts: { id: number; merchant: string; date: string; total_amount: number }[];
}

interface Toast {
  message: string;
  onUndo?: () => void;
  id: number;
}

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

function App() {
  const [data, setData]               = useState<DashboardData | null>(null)
  const [loading, setLoading]         = useState(false)
  const [error, setError]             = useState<string | null>(null)
  const [toast, setToast]             = useState<Toast | null>(null)
  const [showUpload, setShowUpload]   = useState(false)
  const [uploadStatus, setUploadStatus] = useState('')
  const [connectionStatus, setConnectionStatus] = useState('Initializing...')
  const fileInputRef   = useRef<HTMLInputElement>(null)
  const undoTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Data fetching ──────────────────────────────────────────────────────────
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

  // ── Sidecar lifecycle ──────────────────────────────────────────────────────
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

  // ── Toast ──────────────────────────────────────────────────────────────────
  const showToast = (message: string, onUndo?: () => void) => {
    setToast({ message, onUndo, id: Date.now() })
    if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current)
    undoTimeoutRef.current = setTimeout(() => setToast(null), 5000)
  }

  // ── Upload ─────────────────────────────────────────────────────────────────
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (!files.length) return
    setLoading(true); setError(null)
    let ok = 0
    const errs: string[] = []
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
            const detail = await res.text().catch(() => res.statusText)
            throw new Error(`${file.name}: ${res.status} — ${detail}`)
          }
          ok++
        } catch (err) {
          errs.push(err instanceof Error ? err.message : `${file.name}: upload failed`)
        }
      }
      await fetchData()
      if (!errs.length) {
        setShowUpload(false)
        showToast(ok === 1 ? 'Receipt processed successfully' : `${ok} receipts processed`)
      } else {
        setError(errs.length === 1 ? errs[0] : `${errs.length} of ${files.length} failed — ${errs.join('; ')}`)
        if (ok > 0) showToast(`${ok} of ${files.length} receipts processed`)
      }
    } finally {
      setLoading(false); setUploadStatus('')
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // ── Delete with undo ───────────────────────────────────────────────────────
  const handleDelete = async (id: number) => {
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

  // ── Reset ──────────────────────────────────────────────────────────────────
  const handleReset = async () => {
    if (!window.confirm('Clear all receipts? This cannot be undone.')) return
    try {
      const res = await tauriFetch('http://127.0.0.1:8888/api/reset', { method: 'POST' })
      if (!res.ok) throw new Error()
      await fetchData(); showToast('All data cleared')
    } catch { showToast('Failed to reset data') }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  const formatDate = (s: string) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const [y, m, d] = s.split('-'); return `${d}.${m}.${y}`
    }
    const sh = s.match(/^(\d{2})\.(\d{2})\.(\d{2})$/)
    if (sh) return `${sh[1]}.${sh[2]}.20${sh[3]}`
    return s
  }

  const isActive  = connectionStatus === 'Active'
  const isError   = connectionStatus.includes('Failed') || connectionStatus.includes('Blocked') || connectionStatus.includes('Stopped')
  const dotClass  = isActive ? 'dot-active' : isError ? 'dot-error' : 'dot-warn'
  const statusColor = isActive ? '#10b981' : isError ? '#ef4444' : '#f59e0b'

  // ── Chart tooltip ──────────────────────────────────────────────────────────
  const ChartTooltip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null
    const d = payload[0].payload
    return (
      <div className="chart-tip">
        <span style={{ color: categoryColor(d.name) }}>■</span>
        {d.name} <strong>€{d.value.toFixed(2)}</strong>
      </div>
    )
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="app-container">

      {/* ── Header ── */}
      <header>
        <div>
          <h1>Receipt Dashboard</h1>
          <p className="subtitle">Your spending at a glance</p>
        </div>
        <div className="action-bar">
          <button className="btn btn-secondary" onClick={handleReset}>Reset</button>
          <button className="btn btn-primary" onClick={() => setShowUpload(s => !s)}>
            {showUpload ? 'Cancel' : '+ New Receipt'}
          </button>
        </div>
      </header>

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
        </div>
        <div className="card stat-card" style={{ animationDelay: '0.1s' }}>
          <h3>Receipts</h3>
          <div className="stat-value">{data?.receipt_count ?? 0}</div>
        </div>
        <div className="card stat-card" style={{ animationDelay: '0.15s' }}>
          <h3>Top Category</h3>
          <div className="stat-value category-badge" style={{ fontSize: '20px' }}>
            {data?.top_category && data.top_category !== 'N/A' && (
              <span className="cat-dot" style={{ background: categoryColor(data.top_category) }} />
            )}
            {data?.top_category || 'N/A'}
          </div>
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
          <h3>Spending by Category</h3>
          <ResponsiveContainer width="100%" height={Math.max(100, data.category_spend.length * 52)}>
            <BarChart
              data={data.category_spend}
              layout="vertical"
              margin={{ top: 4, right: 70, left: 0, bottom: 4 }}
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
                  formatter={(v: unknown) => `€${Number(v).toFixed(2)}`}
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
          {data && data.receipt_count > 0 && (
            <span className="tx-count">{data.receipt_count} total</span>
          )}
        </div>
        <table>
          <thead>
            <tr>
              <th>Merchant</th>
              <th>Date</th>
              <th>Amount</th>
              <th style={{ width: 60 }} />
            </tr>
          </thead>
          <tbody>
            {data?.recent_receipts.map((r, i) => (
              <tr key={r.id} style={{ animationDelay: `${0.35 + i * 0.04}s` }} className="tx-row">
                <td>
                  <span className="tx-cat-dot" style={{ background: categoryColor('Others') }} />
                  {r.merchant}
                </td>
                <td className="tx-date">{formatDate(r.date)}</td>
                <td className="tx-amount">€{r.total_amount.toFixed(2)}</td>
                <td>
                  <button className="delete-btn" onClick={() => handleDelete(r.id)}>✕</button>
                </td>
              </tr>
            ))}
            {(!data || data.recent_receipts.length === 0) && (
              <tr>
                <td colSpan={4} className="empty-state">
                  <div className="empty-icon">🧾</div>
                  <p>No receipts yet</p>
                  <p className="empty-hint">Click "+ New Receipt" to get started</p>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

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
