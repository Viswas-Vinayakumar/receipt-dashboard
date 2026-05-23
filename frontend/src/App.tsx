import { useState, useEffect, useRef, useMemo } from 'react'
import { Command } from '@tauri-apps/plugin-shell'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, Cell, LabelList,
  LineChart, Line, CartesianGrid,
} from 'recharts'
import './App.css'

// ── Types ──────────────────────────────────────────────────────────────────
interface DashboardData {
  total_spent: number
  receipt_count: number
  top_category: string
  category_spend: { name: string; value: number; count: number }[]
  monthly_trend:  { month: string; total: number }[]
  recent_receipts: { id: number; merchant: string; date: string; total_amount: number; category: string }[]
}

interface DetailReceipt {
  id: number
  merchant: string
  location: string
  date: string
  total_amount: number
  items: { product_name: string; category: string; price: number }[]
}

interface ManualItem { product_name: string; category: string; price: string }

interface Toast { message: string; onUndo?: () => void; id: number }

type SortOption = 'date-desc' | 'date-asc' | 'amount-desc' | 'amount-asc' | 'merchant'
type ChartTab   = 'category' | 'monthly'
type UploadMode = 'scan' | 'manual'

// ── Constants ──────────────────────────────────────────────────────────────
const CATEGORIES = ['Groceries','Bakery','Beverages','Electronics','Dining','Transport','Health','Deposit','Others']

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

const catColor = (name: string) => CATEGORY_COLORS[name] ?? '#94a3b8'

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

const formatMonth = (m: string) => {
  const [y, mo] = m.split('-')
  return `${MONTH_NAMES[parseInt(mo) - 1]} ${y}`
}

const emptyManualItem = (): ManualItem => ({ product_name: '', category: 'Groceries', price: '' })
const todayISO = () => new Date().toISOString().split('T')[0]

// ── Logo — V5 refined mark ────────────────────────────────────────────────
const LogoIcon = ({ size = 40 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 84 84" fill="none" xmlns="http://www.w3.org/2000/svg">
    {/* Side bars — soft blue-gray, slightly recessed */}
    <line x1="29.5" y1="21"   x2="29.5" y2="63"   stroke="#c0cce0" strokeWidth="2.2" strokeLinecap="round"/>
    <line x1="54.5" y1="21"   x2="54.5" y2="63"   stroke="#c0cce0" strokeWidth="2.2" strokeLinecap="round"/>
    {/* Oval — deep navy */}
    <ellipse cx="42" cy="42" rx="17.5" ry="22.5" stroke="#0e1b42" strokeWidth="3" strokeLinecap="round"/>
    {/* Center bar — brand blue, crosses oval */}
    <line x1="42" y1="17.5" x2="42" y2="66.5" stroke="#0071e3" strokeWidth="3" strokeLinecap="round"/>
  </svg>
)

// ── Component ──────────────────────────────────────────────────────────────
function App() {
  // ── Core state ─────────────────────────────────────────────────────────
  const [data, setData]                       = useState<DashboardData | null>(null)
  const [loading, setLoading]                 = useState(false)
  const [loadingElapsed, setLoadingElapsed]   = useState(0)
  const [error, setError]                     = useState<string | null>(null)
  const [rateLimitWarn, setRateLimitWarn]     = useState<string | null>(null)
  const [toast, setToast]                     = useState<Toast | null>(null)
  const [connectionStatus, setConnectionStatus] = useState('Initializing...')

  // ── Upload panel ────────────────────────────────────────────────────────
  const [showUpload, setShowUpload]           = useState(false)
  const [uploadMode, setUploadMode]           = useState<UploadMode>('scan')
  const [uploadStatus, setUploadStatus]       = useState('')
  const [uploadErr, setUploadErr]             = useState<{ msg: string; isNotReceipt: boolean } | null>(null)

  // ── Manual entry form ───────────────────────────────────────────────────
  const [manualMerchant, setManualMerchant]   = useState('')
  const [manualLocation, setManualLocation]   = useState('')
  const [manualDate, setManualDate]           = useState(todayISO())
  const [manualTotal, setManualTotal]         = useState('')
  const [manualItems, setManualItems]         = useState<ManualItem[]>([emptyManualItem()])
  const [submittingManual, setSubmittingManual] = useState(false)
  const [editingId, setEditingId]             = useState<number | null>(null)   // null = new entry

  // ── Detail / modals ─────────────────────────────────────────────────────
  const [detailReceipt, setDetailReceipt]     = useState<DetailReceipt | null>(null)
  const [loadingDetail, setLoadingDetail]     = useState(false)
  const [showResetModal, setShowResetModal]   = useState(false)

  // ── Table controls ──────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery]         = useState('')
  const [sortBy, setSortBy]                   = useState<SortOption>('date-desc')
  const [filterCategory, setFilterCategory]   = useState('')

  // ── Chart tab ───────────────────────────────────────────────────────────
  const [chartTab, setChartTab]               = useState<ChartTab>('category')

  const fileInputRef   = useRef<HTMLInputElement>(null)
  const undoTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchRef      = useRef<HTMLInputElement>(null)

  // ── Helpers ─────────────────────────────────────────────────────────────
  const formatDate = (s: string) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const [y, m, d] = s.split('-'); return `${d}.${m}.${y}`
    }
    return s
  }

  const showToast = (message: string, onUndo?: () => void) => {
    setToast({ message, onUndo, id: Date.now() })
    if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current)
    undoTimeoutRef.current = setTimeout(() => setToast(null), 5000)
  }

  // ── Fetch dashboard data ─────────────────────────────────────────────────
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

        command.on('error', (_err: string) => {
          if (cancelled) return
          setError(`macOS blocked the AI engine. Open Terminal and run:\n  xattr -dr com.apple.quarantine "/Applications/ReceiptDashboard.app"\nthen relaunch the app.`)
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
          setError('AI engine not responding. Check ~/receipt-dashboard/app_data/backend.log for details.')
          setConnectionStatus('Connection Failed')
        }
      } catch (err) {
        started = false
        setError(`macOS blocked the AI engine. Open Terminal and run:\n  xattr -dr com.apple.quarantine "/Applications/ReceiptDashboard.app"\nthen relaunch.`)
        setConnectionStatus('Security Blocked')
      }
    }

    startBackend()
    return () => { cancelled = true; started = false }
  }, [])

  // ── Parse backend error ──────────────────────────────────────────────────
  const parseErrDetail = async (res: Response): Promise<{ msg: string; status: number }> => {
    const raw = await res.text().catch(() => res.statusText)
    let msg = raw
    try { const p = JSON.parse(raw); msg = p.detail ?? p.message ?? raw } catch {}
    return { msg, status: res.status }
  }

  // ── AI Upload ────────────────────────────────────────────────────────────
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (!files.length) return
    setLoading(true); setLoadingElapsed(0); setError(null); setRateLimitWarn(null); setUploadErr(null)

    // Elapsed-time ticker so the user knows the AI is still working
    const ticker = setInterval(() => setLoadingElapsed(s => s + 1), 1000)

    let ok = 0
    const errs: string[] = []
    const rateLimitMsgs: string[] = []
    let hasUploadErr = false   // local flag — avoids stale React-closure bug

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        setUploadStatus(files.length > 1 ? `Analyzing ${i + 1} of ${files.length}…` : '')
        try {
          const buf  = await file.arrayBuffer()
          const form = new FormData()
          form.append('file', new Blob([buf], { type: file.type || 'image/jpeg' }), file.name)
          const res = await tauriFetch('http://127.0.0.1:8888/api/upload', { method: 'POST', body: form })
          if (!res.ok) {
            const { msg, status } = await parseErrDetail(res)
            if (status === 400 && msg === 'not_a_receipt') {
              hasUploadErr = true
              setUploadErr({
                msg: "This image doesn't look like a receipt. Try a clearer photo, or enter the details manually.",
                isNotReceipt: true
              })
            } else if (status === 429) {
              rateLimitMsgs.push(msg)
            } else if (status === 401 || status === 503) {
              // Auth / config errors — show banner AND keep panel open
              setError(msg)
              errs.push(msg)
            } else {
              throw new Error(msg)
            }
          } else {
            ok++
          }
        } catch (err) {
          errs.push(err instanceof Error ? err.message : `${file.name}: upload failed`)
        }
      }

      await fetchData()

      if (rateLimitMsgs.length) setRateLimitWarn(rateLimitMsgs[0])

      // Only close the panel when at least one receipt was actually saved
      if (ok > 0 && !errs.length && !rateLimitMsgs.length && !hasUploadErr) {
        setShowUpload(false)
        showToast(ok === 1 ? 'Receipt scanned successfully' : `${ok} receipts scanned`)
      } else if (errs.length && !rateLimitMsgs.length) {
        if (!error) setError(errs.length === 1 ? errs[0] : `${errs.length} of ${files.length} failed — ${errs.join('; ')}`)
        if (ok > 0) showToast(`${ok} of ${files.length} receipts processed`)
      } else if (ok > 0) {
        showToast(`${ok} of ${files.length} receipts processed`)
      }
    } finally {
      clearInterval(ticker)
      setLoading(false); setLoadingElapsed(0); setUploadStatus('')
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // ── Manual entry helpers ─────────────────────────────────────────────────
  const resetManualForm = () => {
    setManualMerchant(''); setManualLocation('')
    setManualDate(todayISO()); setManualTotal('')
    setManualItems([emptyManualItem()])
    setEditingId(null)
  }

  const openEdit = (receipt: DetailReceipt) => {
    setManualMerchant(receipt.merchant)
    setManualLocation(receipt.location ?? '')
    setManualDate(receipt.date)
    setManualTotal(String(receipt.total_amount))
    setManualItems(
      receipt.items.length > 0
        ? receipt.items.map(i => ({ product_name: i.product_name, category: i.category, price: String(i.price) }))
        : [emptyManualItem()]
    )
    setEditingId(receipt.id)
    setDetailReceipt(null)
    setShowUpload(true)
    setUploadMode('manual')
  }

  const updateManualItem = (i: number, field: keyof ManualItem, val: string) => {
    setManualItems(prev => prev.map((item, idx) => idx === i ? { ...item, [field]: val } : item))
  }

  const addManualItem = () => setManualItems(prev => [...prev, emptyManualItem()])

  const removeManualItem = (i: number) =>
    setManualItems(prev => prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev)

  // Compute total from items if total field empty
  const computedTotal = manualItems.reduce((s, it) => s + (parseFloat(it.price) || 0), 0)

  const handleManualSubmit = async () => {
    if (!manualMerchant.trim() || !manualDate) return
    setSubmittingManual(true)
    try {
      const validItems = manualItems.filter(i => i.product_name.trim() && i.price)
      const total = parseFloat(manualTotal) || computedTotal
      const payload = {
        merchant:     manualMerchant.trim(),
        location:     manualLocation.trim(),
        date:         manualDate,
        total_amount: total,
        items:        validItems.map(i => ({
          product_name: i.product_name.trim(),
          category:     i.category,
          price:        parseFloat(i.price)
        }))
      }
      const url    = editingId !== null ? `http://127.0.0.1:8888/api/receipts/${editingId}` : 'http://127.0.0.1:8888/api/receipts/manual'
      const method = editingId !== null ? 'PUT' : 'POST'
      const res    = await tauriFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      if (!res.ok) throw new Error('Save failed')
      await fetchData()
      setShowUpload(false)
      resetManualForm()
      showToast(editingId !== null ? 'Receipt updated' : 'Receipt added manually')
    } catch {
      showToast('Failed to save — please try again')
    } finally {
      setSubmittingManual(false)
    }
  }

  // ── Delete with undo ─────────────────────────────────────────────────────
  const handleDelete = async (e: React.MouseEvent, id: number) => {
    e.stopPropagation()
    if (!data) return
    const snapshot = data
    setData({ ...data, recent_receipts: data.recent_receipts.filter(r => r.id !== id) })
    const timer = setTimeout(async () => {
      try {
        const res = await tauriFetch(`http://127.0.0.1:8888/api/receipts/${id}`, { method: 'DELETE' })
        if (!res.ok) throw new Error()
        await fetchData()
      } catch {
        setData(snapshot)
        showToast('Failed to delete receipt')
      }
    }, 5000)
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
    setLoadingDetail(true); setDetailReceipt(null)
    try {
      for (const base of ['http://127.0.0.1:8888', 'http://localhost:8888']) {
        try {
          const res = await tauriFetch(`${base}/api/receipts`)
          if (res.ok) {
            const all: DetailReceipt[] = await res.json()
            const found = all.find(r => r.id === id)
            if (found) { setDetailReceipt(found); return }
          }
        } catch {}
      }
      showToast('Could not load receipt details')
    } finally { setLoadingDetail(false) }
  }

  // ── Export CSV ───────────────────────────────────────────────────────────
  const exportCSV = () => {
    if (!displayedReceipts.length) return
    const header = ['Merchant','Category','Date','Amount (€)']
    const rows   = displayedReceipts.map(r => [
      r.merchant, r.category, formatDate(r.date), r.total_amount.toFixed(2)
    ])
    const csv = [header, ...rows]
      .map(row => row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))
      .join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }))
    Object.assign(document.createElement('a'), {
      href: url,
      download: `receipts-${new Date().toISOString().split('T')[0]}.csv`
    }).click()
    URL.revokeObjectURL(url)
    showToast(`Exported ${displayedReceipts.length} receipt${displayedReceipts.length !== 1 ? 's' : ''}`)
  }

  // ── Derived values ───────────────────────────────────────────────────────
  const isActive    = connectionStatus === 'Active'
  const isConnErr   = connectionStatus.includes('Failed') || connectionStatus.includes('Blocked') || connectionStatus.includes('Stopped')
  const dotClass    = isActive ? 'dot-active' : isConnErr ? 'dot-error' : 'dot-warn'
  const statusColor = isActive ? '#10b981' : isConnErr ? '#ef4444' : '#f59e0b'
  const chartTotal  = data?.category_spend.reduce((s, e) => s + e.value, 0) ?? 0
  const isFiltered  = !!(searchQuery.trim() || filterCategory)

  const displayedReceipts = useMemo(() => {
    if (!data) return []
    let list = [...data.recent_receipts]
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      list = list.filter(r => r.merchant.toLowerCase().includes(q) || r.category.toLowerCase().includes(q))
    }
    if (filterCategory) list = list.filter(r => r.category === filterCategory)
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

  const hasChart = data && (data.category_spend.length > 0 || data.monthly_trend.length > 0)

  // ── Custom tooltips ──────────────────────────────────────────────────────
  const CategoryTooltip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null
    const d   = payload[0].payload
    const pct = chartTotal > 0 ? Math.round((d.value / chartTotal) * 100) : 0
    return (
      <div className="chart-tip">
        <span className="chart-tip-dot" style={{ background: catColor(d.name) }} />
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

  const MonthlyTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null
    return (
      <div className="chart-tip">
        <div>
          <div className="chart-tip-name">{label}</div>
          <div className="chart-tip-meta"><strong>€{payload[0].value.toFixed(2)}</strong></div>
        </div>
      </div>
    )
  }

  // ── Manual form validity ─────────────────────────────────────────────────
  const manualValid = manualMerchant.trim().length > 0 && manualDate.length === 10

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="app-container">

      {/* ── Header ── */}
      <header>
        <div className="brand">
          <LogoIcon size={42} />
          <div>
            <h1>Receipt Dashboard</h1>
            <p className="subtitle">Your spending at a glance</p>
          </div>
        </div>
        <div className="action-bar">
          <button className="btn btn-secondary" onClick={() => setShowResetModal(true)}>Reset</button>
          <button className="btn btn-primary" onClick={() => {
            if (showUpload) { setShowUpload(false); resetManualForm() }
            else { setUploadMode('scan'); setUploadErr(null); setShowUpload(true) }
          }}>
            {showUpload ? 'Cancel' : '+ New Receipt'}
          </button>
        </div>
      </header>

      {/* ── Banners ── */}
      {rateLimitWarn && (
        <div className="rate-limit-banner" onClick={() => setRateLimitWarn(null)}>
          <span className="banner-icon">⏱</span>
          <span className="banner-msg">{rateLimitWarn}</span>
          <span className="banner-close">✕</span>
        </div>
      )}
      {error && (
        <div className="error-banner" onClick={() => setError(null)}>
          <span className="banner-icon">⚠</span>
          <pre className="banner-msg banner-pre">{error}</pre>
          <span className="banner-close">✕</span>
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
              <span className="cat-dot" style={{ background: catColor(data.top_category) }} />
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

      {/* ── Charts ── */}
      {hasChart && (
        <section className="card chart-card" style={{ animationDelay: '0.25s' }}>
          <div className="chart-header">
            <h3>{chartTab === 'category' ? 'Spending by Category' : 'Monthly Spending'}</h3>
            <div className="chart-tabs">
              <button
                className={`chart-tab${chartTab === 'category' ? ' active' : ''}`}
                onClick={() => setChartTab('category')}
              >Category</button>
              <button
                className={`chart-tab${chartTab === 'monthly' ? ' active' : ''}`}
                onClick={() => setChartTab('monthly')}
                disabled={!data?.monthly_trend.length}
              >Monthly</button>
            </div>
          </div>

          {chartTab === 'category' && data && data.category_spend.length > 0 && (
            <>
              <p className="chart-subtitle">{data.category_spend.length} categories · €{chartTotal.toFixed(2)} total</p>
              <ResponsiveContainer width="100%" height={Math.max(100, data.category_spend.length * 56)}>
                <BarChart data={data.category_spend} layout="vertical" margin={{ top: 4, right: 120, left: 0, bottom: 4 }}>
                  <XAxis type="number" hide domain={[0, 'dataMax']} />
                  <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 13, fill: '#86868b' }} axisLine={false} tickLine={false} />
                  <Tooltip content={<CategoryTooltip />} cursor={{ fill: 'rgba(0,0,0,0.03)' }} />
                  <Bar dataKey="value" radius={[0, 6, 6, 0]} isAnimationActive animationDuration={900} animationEasing="ease-out">
                    {data.category_spend.map(e => <Cell key={e.name} fill={catColor(e.name)} />)}
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
            </>
          )}

          {chartTab === 'monthly' && data && data.monthly_trend.length > 0 && (
            <>
              <p className="chart-subtitle">
                {data.monthly_trend.length} month{data.monthly_trend.length !== 1 ? 's' : ''} · €{data.monthly_trend.reduce((s, m) => s + m.total, 0).toFixed(2)} total
              </p>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={data.monthly_trend.map(m => ({ ...m, label: formatMonth(m.month) }))} margin={{ top: 8, right: 24, left: 0, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.05)" />
                  <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#86868b' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 12, fill: '#86868b' }} axisLine={false} tickLine={false} tickFormatter={v => `€${v}`} width={52} />
                  <Tooltip content={<MonthlyTooltip />} cursor={{ stroke: 'rgba(0,0,0,0.06)', strokeWidth: 2 }} />
                  <Line
                    type="monotone" dataKey="total" stroke="#3b82f6" strokeWidth={2.5}
                    dot={{ fill: '#3b82f6', r: 4, strokeWidth: 0 }}
                    activeDot={{ r: 6, fill: '#3b82f6', strokeWidth: 0 }}
                    isAnimationActive animationDuration={900}
                  />
                </LineChart>
              </ResponsiveContainer>
            </>
          )}
        </section>
      )}

      {/* ── Upload / Add panel ── */}
      {showUpload && (
        <section className="card upload-card" style={{ animationDelay: '0s' }}>
          {/* Mode switcher tabs */}
          <div className="upload-mode-tabs">
            <button
              className={`upload-mode-tab${uploadMode === 'scan' ? ' active' : ''}`}
              onClick={() => { setUploadMode('scan'); setUploadErr(null) }}
            >📷  Scan Receipt</button>
            <button
              className={`upload-mode-tab${uploadMode === 'manual' ? ' active' : ''}`}
              onClick={() => { setUploadMode('manual'); setUploadErr(null) }}
            >✏️  Enter Manually</button>
          </div>

          {/* ── Scan mode ── */}
          {uploadMode === 'scan' && (
            <div className="upload-scan-area">
              <input type="file" ref={fileInputRef} onChange={handleUpload}
                style={{ display: 'none' }} accept="image/*" multiple />
              <div
                className={`upload-zone${loading ? ' loading' : ''}`}
                onClick={() => !loading && fileInputRef.current?.click()}
              >
                {loading ? (
                  <div className="upload-loading">
                    <div className="loading-spinner" />
                    <p>{uploadStatus || (loadingElapsed > 12 ? 'AI is busy — retrying automatically…' : 'AI is reading your receipt…')}</p>
                    {loadingElapsed > 5 && (
                      <p className="upload-loading-sub">{loadingElapsed}s — please wait, do not close</p>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="upload-icon">↑</div>
                    <p className="upload-title">Select receipt images</p>
                    <p className="upload-hint">German &amp; English · Hold ⌘ for multiple</p>
                  </>
                )}
              </div>

              {/* Upload error (non-receipt or other) */}
              {uploadErr && (
                <div className="upload-err-block">
                  <p className="upload-err-msg">
                    {uploadErr.isNotReceipt ? '🖼 ' : '⚠ '}{uploadErr.msg}
                  </p>
                  {uploadErr.isNotReceipt && (
                    <button
                      className="btn btn-secondary"
                      onClick={() => { setUploadErr(null); setUploadMode('manual') }}
                    >
                      Enter details manually →
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Manual entry mode ── */}
          {uploadMode === 'manual' && (
            <div className="manual-form">
              <div className="form-row">
                <div className="form-group" style={{ flex: 2 }}>
                  <label className="form-label">Merchant *</label>
                  <input className="form-input" placeholder="e.g. Rewe, Kaufland…"
                    value={manualMerchant} onChange={e => setManualMerchant(e.target.value)} />
                </div>
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">Date *</label>
                  <input className="form-input" type="date"
                    value={manualDate} onChange={e => setManualDate(e.target.value)} />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group" style={{ flex: 2 }}>
                  <label className="form-label">Location</label>
                  <input className="form-input" placeholder="Store address (optional)"
                    value={manualLocation} onChange={e => setManualLocation(e.target.value)} />
                </div>
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">Total (€){computedTotal > 0 && !manualTotal && <span className="form-hint"> auto</span>}</label>
                  <input className="form-input" type="number" step="0.01" min="0" placeholder={computedTotal > 0 ? computedTotal.toFixed(2) : '0.00'}
                    value={manualTotal} onChange={e => setManualTotal(e.target.value)} />
                </div>
              </div>

              {/* Items */}
              <div className="form-items-header">
                <span className="form-label">Items <span className="form-hint">(optional)</span></span>
              </div>
              <div className="form-items-list">
                {manualItems.map((item, i) => (
                  <div key={i} className="form-item-row">
                    <input
                      className="form-input item-name"
                      placeholder="Product name"
                      value={item.product_name}
                      onChange={e => updateManualItem(i, 'product_name', e.target.value)}
                    />
                    <select
                      className="form-input item-cat"
                      value={item.category}
                      onChange={e => updateManualItem(i, 'category', e.target.value)}
                    >
                      {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <div className="item-price-wrap">
                      <span className="item-price-prefix">€</span>
                      <input
                        className="form-input item-price"
                        type="number" step="0.01" min="0" placeholder="0.00"
                        value={item.price}
                        onChange={e => updateManualItem(i, 'price', e.target.value)}
                      />
                    </div>
                    <button className="item-remove-btn" onClick={() => removeManualItem(i)} title="Remove">✕</button>
                  </div>
                ))}
              </div>
              <button className="add-item-btn" onClick={addManualItem}>+ Add Item</button>

              <div className="manual-form-footer">
                <button className="btn btn-secondary" onClick={() => { setShowUpload(false); resetManualForm() }}>Cancel</button>
                <button
                  className="btn btn-primary"
                  disabled={!manualValid || submittingManual}
                  onClick={handleManualSubmit}
                >
                  {submittingManual ? 'Saving…' : editingId !== null ? 'Save Changes' : 'Add Receipt'}
                </button>
              </div>
            </div>
          )}
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
                {data.category_spend.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
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
              <button className="btn btn-icon" title="Print / Save as PDF" onClick={() => window.print()}>⎙</button>
              <button className="btn btn-export" onClick={exportCSV} disabled={!displayedReceipts.length}>↓ Export CSV</button>
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
              <tr key={r.id} style={{ animationDelay: `${0.05 + i * 0.03}s` }}
                className="tx-row" onClick={() => handleRowClick(r.id)} title="Click to view details">
                <td className="tx-merchant">
                  <span className="tx-cat-dot" style={{ background: catColor(r.category) }} />
                  {r.merchant}
                </td>
                <td>
                  <span className="tx-badge" style={{ background: catColor(r.category) + '22', color: catColor(r.category) }}>
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

            {(!data || data.recent_receipts.length === 0) && (
              <tr><td colSpan={5} className="empty-state">
                <div className="empty-icon">🧾</div>
                <p>No receipts yet</p>
                <p className="empty-hint">Scan a receipt or enter one manually</p>
              </td></tr>
            )}

            {data && data.recent_receipts.length > 0 && displayedReceipts.length === 0 && (
              <tr><td colSpan={5} className="empty-state">
                <div className="empty-icon">🔍</div>
                <p>No matching receipts</p>
                <p className="empty-hint">Try adjusting your search or filters</p>
              </td></tr>
            )}
          </tbody>

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
              <div className="detail-loading"><div className="loading-spinner" /><p>Loading receipt…</p></div>
            ) : detailReceipt && (
              <>
                <div className="detail-header">
                  <div className="detail-header-info">
                    <h2 className="modal-title">{detailReceipt.merchant}</h2>
                    {detailReceipt.location && <p className="detail-location">{detailReceipt.location}</p>}
                    <p className="detail-meta">{formatDate(detailReceipt.date)}</p>
                  </div>
                  <div className="detail-header-actions">
                    <button className="btn btn-secondary btn-sm" onClick={() => openEdit(detailReceipt)}>Edit</button>
                    <button className="detail-close" onClick={() => setDetailReceipt(null)}>✕</button>
                  </div>
                </div>

                <div className="detail-items">
                  {detailReceipt.items.length === 0 ? (
                    <p className="detail-no-items">No item breakdown available</p>
                  ) : detailReceipt.items.map((item, i) => (
                    <div key={i} className="detail-item">
                      <div className="detail-item-left">
                        <span className="tx-cat-dot" style={{ background: catColor(item.category), width: 8, height: 8, flexShrink: 0 }} />
                        <span className="detail-item-name">{item.product_name}</span>
                      </div>
                      <div className="detail-item-right">
                        <span className="tx-badge" style={{ background: catColor(item.category) + '22', color: catColor(item.category) }}>
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
          {toast.onUndo && <button className="undo-btn" onClick={toast.onUndo}>Undo</button>}
        </div>
      )}
    </div>
  )
}

export default App
