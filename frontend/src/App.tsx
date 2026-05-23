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
  id: number; merchant: string; location: string; date: string
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
  Groceries: '#34d399', Bakery: '#fb923c', Beverages: '#60a5fa',
  Electronics: '#a78bfa', Dining: '#f472b6', Transport: '#38bdf8',
  Health: '#f87171', Deposit: '#94a3b8', Others: '#fbbf24',
}

const catColor = (name: string) => CATEGORY_COLORS[name] ?? '#94a3b8'
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const formatMonth = (m: string) => { const [y, mo] = m.split('-'); return `${MONTH_NAMES[parseInt(mo)-1]} ${y}` }
const emptyManualItem = (): ManualItem => ({ product_name: '', category: 'Groceries', price: '' })
const todayISO = () => new Date().toISOString().split('T')[0]

// ── Logo mark ─────────────────────────────────────────────────────────────
const LogoIcon = ({ size = 40 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 84 84" fill="none">
    <line x1="29.5" y1="21" x2="29.5" y2="63" stroke="#c0cce0" strokeWidth="2.2" strokeLinecap="round"/>
    <line x1="54.5" y1="21" x2="54.5" y2="63" stroke="#c0cce0" strokeWidth="2.2" strokeLinecap="round"/>
    <ellipse cx="42" cy="42" rx="17.5" ry="22.5" stroke="#0e1b42" strokeWidth="3"/>
    <line x1="42" y1="17.5" x2="42" y2="66.5" stroke="#0071e3" strokeWidth="3" strokeLinecap="round"/>
  </svg>
)

// ── App ────────────────────────────────────────────────────────────────────
export default function App() {

  // ── Core state ────────────────────────────────────────────────────────
  const [data,             setData]             = useState<DashboardData | null>(null)
  const [connStatus,       setConnStatus]       = useState('Initializing...')
  const [globalError,      setGlobalError]      = useState<string | null>(null)
  const [toast,            setToast]            = useState<Toast | null>(null)

  // ── Upload panel ──────────────────────────────────────────────────────
  const [showUpload,  setShowUpload]  = useState(false)
  const [uploadMode,  setUploadMode]  = useState<UploadMode>('scan')
  const [scanning,    setScanning]    = useState(false)
  const [scanStatus,  setScanStatus]  = useState('')
  const [scanElapsed, setScanElapsed] = useState(0)
  const [scanErr,     setScanErr]     = useState<{ msg: string; isNotReceipt: boolean } | null>(null)

  // ── Rate-limit countdown (auto-retry) ─────────────────────────────────
  const [retryAfter,  setRetryAfter]  = useState<number | null>(null)
  const retryFilesRef = useRef<File[]>([])
  const retryTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── Manual form ───────────────────────────────────────────────────────
  const [merchant,  setMerchant]  = useState('')
  const [location,  setLocation]  = useState('')
  const [mDate,     setMDate]     = useState(todayISO())
  const [mTotal,    setMTotal]    = useState('')
  const [mItems,    setMItems]    = useState<ManualItem[]>([emptyManualItem()])
  const [saving,    setSaving]    = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)

  // ── Detail / modals ───────────────────────────────────────────────────
  const [detail,         setDetail]         = useState<DetailReceipt | null>(null)
  const [loadingDetail,  setLoadingDetail]  = useState(false)
  const [showReset,      setShowReset]      = useState(false)

  // ── Table controls ────────────────────────────────────────────────────
  const [search,         setSearch]         = useState('')
  const [sortBy,         setSortBy]         = useState<SortOption>('date-desc')
  const [filterCat,      setFilterCat]      = useState('')
  const [chartTab,       setChartTab]       = useState<ChartTab>('category')

  const fileInputRef   = useRef<HTMLInputElement>(null)
  const undoTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchRef      = useRef<HTMLInputElement>(null)

  // ── Utilities ─────────────────────────────────────────────────────────
  const formatDate = (s: string) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const [y, m, d] = s.split('-'); return `${d}.${m}.${y}`
    }
    return s
  }

  const showToast = (message: string, onUndo?: () => void) => {
    setToast({ message, onUndo, id: Date.now() })
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
    undoTimerRef.current = setTimeout(() => setToast(null), 5000)
  }

  const parseDetail = async (res: Response): Promise<{ msg: string; status: number }> => {
    const raw = await res.text().catch(() => res.statusText)
    let msg = raw
    try { const p = JSON.parse(raw); msg = p.detail ?? p.message ?? raw } catch {}
    return { msg, status: res.status }
  }

  // ── Fetch dashboard ───────────────────────────────────────────────────
  const fetchData = async () => {
    try {
      const res = await tauriFetch('http://127.0.0.1:8888/api/dashboard')
      if (res.ok) {
        setData(await res.json())
        setGlobalError(null)
        setConnStatus('Active')
      }
    } catch { /* silent */ }
  }

  // ── Sidecar lifecycle ─────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    let started   = false

    const startBackend = async () => {
      if (started || cancelled) return
      started = true
      try {
        setConnStatus('Starting AI Engine...')
        const cmd = Command.sidecar('backend')
        cmd.stdout.on('data', (l: string) => console.log('[backend]', l))
        cmd.stderr.on('data', (l: string) => console.warn('[backend]', l))
        cmd.on('close', async ({ code }: { code: number | null }) => {
          if (cancelled) return
          console.log(`[sidecar] exited code=${code}`)
          started = false
          await new Promise(r => setTimeout(r, 1500))
          if (cancelled) return
          try {
            const res = await tauriFetch('http://127.0.0.1:8888/api/health')
            if (res.ok) { setConnStatus('Active'); fetchData(); return }
          } catch {}
          setConnStatus('Engine Stopped')
          setTimeout(() => { if (!cancelled) startBackend() }, 3000)
        })
        cmd.on('error', (_e: string) => {
          if (cancelled) return
          setGlobalError(`macOS blocked the AI engine. Open Terminal and run:\n  xattr -dr com.apple.quarantine "/Applications/ReceiptDashboard.app"\nthen relaunch the app.`)
          setConnStatus('Security Blocked')
        })
        await cmd.spawn()

        let ok = false
        for (let i = 0; i < 45 && !cancelled; i++) {
          setConnStatus(`Connecting (${i + 1}/45)…`)
          try {
            const res = await tauriFetch('http://127.0.0.1:8888/api/health')
            if (res.ok) { ok = true; break }
          } catch {}
          await new Promise(r => setTimeout(r, 1000))
        }
        if (cancelled) return
        if (ok) fetchData()
        else { started = false; setConnStatus('Connection Failed') }
      } catch {
        started = false
        setGlobalError(`macOS blocked the AI engine. Open Terminal and run:\n  xattr -dr com.apple.quarantine "/Applications/ReceiptDashboard.app"\nthen relaunch.`)
        setConnStatus('Security Blocked')
      }
    }

    startBackend()
    return () => { cancelled = true; started = false }
  }, [])

  // ── Rate-limit countdown ──────────────────────────────────────────────
  const stopRetry = () => {
    if (retryTimerRef.current) { clearInterval(retryTimerRef.current); retryTimerRef.current = null }
    retryFilesRef.current = []
    setRetryAfter(null)
  }

  const startRetryCountdown = (waitSec: number, files: File[]) => {
    stopRetry()
    retryFilesRef.current = files
    setRetryAfter(waitSec)

    let remaining = waitSec
    retryTimerRef.current = setInterval(() => {
      remaining -= 1
      if (remaining <= 0) {
        clearInterval(retryTimerRef.current!)
        retryTimerRef.current = null
        const toRetry = [...retryFilesRef.current]
        retryFilesRef.current = []
        setRetryAfter(null)
        doUploadFiles(toRetry)
      } else {
        setRetryAfter(remaining)
      }
    }, 1000)
  }

  // ── Core upload logic ─────────────────────────────────────────────────
  const doUploadFiles = async (files: File[]) => {
    if (!files.length) return
    setScanning(true)
    setScanElapsed(0)
    setScanErr(null)
    setGlobalError(null)

    const ticker = setInterval(() => setScanElapsed(s => s + 1), 1000)
    let ok = 0
    const errs: string[] = []
    let hasUploadErr = false

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        setScanStatus(files.length > 1 ? `Analyzing ${i + 1} of ${files.length}…` : '')

        try {
          const buf  = await file.arrayBuffer()
          const form = new FormData()
          form.append('file', new Blob([buf], { type: file.type || 'image/jpeg' }), file.name)

          const res = await tauriFetch('http://127.0.0.1:8888/api/upload', {
            method: 'POST', body: form
          })

          if (!res.ok) {
            const { msg, status } = await parseDetail(res)

            if (status === 400 && msg === 'not_a_receipt') {
              hasUploadErr = true
              setScanErr({ msg: "This image doesn't look like a receipt. Try a clearer photo, or enter the details manually.", isNotReceipt: true })

            } else if (status === 429) {
              // Backend returned instantly — parse wait time from "rate_limit:45"
              const m = msg.match(/rate_limit:(\d+)/)
              const waitSec = m ? parseInt(m[1]) : 62
              // Start countdown; remaining files will be retried automatically
              startRetryCountdown(waitSec, files.slice(i))
              break // stop processing — countdown will resume

            } else if (status === 401 || status === 503) {
              setGlobalError(msg)
              errs.push(msg)

            } else {
              throw new Error(msg)
            }
          } else {
            ok++
          }
        } catch (err) {
          if ((err as Error).message?.includes('rate_limit')) throw err
          errs.push(err instanceof Error ? err.message : `${file.name}: upload failed`)
        }
      }

      await fetchData()

      // Only close the panel when at least one receipt was actually saved with no errors
      if (ok > 0 && !errs.length && !hasUploadErr && retryAfter === null && !retryFilesRef.current.length) {
        setShowUpload(false)
        resetManualForm()
        showToast(ok === 1 ? 'Receipt scanned successfully ✓' : `${ok} receipts scanned ✓`)
      } else {
        if (errs.length) setGlobalError(errs.join(' · '))
        if (ok > 0) showToast(`${ok} of ${files.length} receipts saved`)
      }
    } finally {
      clearInterval(ticker)
      setScanning(false)
      setScanElapsed(0)
      setScanStatus('')
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (!files.length) return
    stopRetry() // cancel any pending retry when user manually selects a new file
    doUploadFiles(files)
  }

  // ── Manual form helpers ───────────────────────────────────────────────
  const resetManualForm = () => {
    setMerchant(''); setLocation(''); setMDate(todayISO())
    setMTotal(''); setMItems([emptyManualItem()]); setEditingId(null)
  }

  const openEdit = (r: DetailReceipt) => {
    setMerchant(r.merchant); setLocation(r.location ?? '')
    setMDate(r.date); setMTotal(String(r.total_amount))
    setMItems(r.items.length > 0
      ? r.items.map(i => ({ product_name: i.product_name, category: i.category, price: String(i.price) }))
      : [emptyManualItem()])
    setEditingId(r.id); setDetail(null)
    setShowUpload(true); setUploadMode('manual')
  }

  const updateItem = (i: number, field: keyof ManualItem, val: string) =>
    setMItems(prev => prev.map((it, idx) => idx === i ? { ...it, [field]: val } : it))
  const addItem    = () => setMItems(prev => [...prev, emptyManualItem()])
  const removeItem = (i: number) => setMItems(prev => prev.length > 1 ? prev.filter((_, x) => x !== i) : prev)

  const computedTotal = mItems.reduce((s, it) => s + (parseFloat(it.price) || 0), 0)
  const manualValid   = merchant.trim().length > 0 && mDate.length === 10

  const handleManualSubmit = async () => {
    if (!manualValid) return
    setSaving(true)
    try {
      const validItems = mItems.filter(i => i.product_name.trim() && i.price)
      const payload = {
        merchant: merchant.trim(), location: location.trim(), date: mDate,
        total_amount: parseFloat(mTotal) || computedTotal,
        items: validItems.map(i => ({ product_name: i.product_name.trim(), category: i.category, price: parseFloat(i.price) }))
      }
      const url    = editingId !== null ? `http://127.0.0.1:8888/api/receipts/${editingId}` : 'http://127.0.0.1:8888/api/receipts/manual'
      const method = editingId !== null ? 'PUT' : 'POST'
      const res    = await tauriFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (!res.ok) throw new Error('Save failed')
      await fetchData()
      setShowUpload(false); resetManualForm()
      showToast(editingId !== null ? 'Receipt updated ✓' : 'Receipt added ✓')
    } catch { showToast('Failed to save — please try again') }
    finally { setSaving(false) }
  }

  // ── Delete with undo ──────────────────────────────────────────────────
  const handleDelete = async (e: React.MouseEvent, id: number) => {
    e.stopPropagation()
    if (!data) return
    const snap = data
    setData({ ...data, recent_receipts: data.recent_receipts.filter(r => r.id !== id) })
    const timer = setTimeout(async () => {
      try {
        const res = await tauriFetch(`http://127.0.0.1:8888/api/receipts/${id}`, { method: 'DELETE' })
        if (!res.ok) throw new Error()
        await fetchData()
      } catch { setData(snap); showToast('Failed to delete receipt') }
    }, 5000)
    showToast('Receipt deleted', () => {
      clearTimeout(timer); setData(snap)
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
      setToast(null)
    })
  }

  // ── Reset ─────────────────────────────────────────────────────────────
  const doReset = async () => {
    setShowReset(false)
    try {
      const res = await tauriFetch('http://127.0.0.1:8888/api/reset', { method: 'POST' })
      if (!res.ok) throw new Error()
      setSearch(''); setFilterCat(''); await fetchData(); showToast('All data cleared')
    } catch { showToast('Failed to reset data') }
  }

  // ── Receipt detail ────────────────────────────────────────────────────
  const handleRowClick = async (id: number) => {
    setLoadingDetail(true); setDetail(null)
    try {
      const res = await tauriFetch('http://127.0.0.1:8888/api/receipts')
      if (res.ok) {
        const all: DetailReceipt[] = await res.json()
        const found = all.find(r => r.id === id)
        if (found) setDetail(found)
        else showToast('Could not load receipt details')
      }
    } catch { showToast('Could not load receipt details') }
    finally { setLoadingDetail(false) }
  }

  // ── CSV export ────────────────────────────────────────────────────────
  const exportCSV = () => {
    if (!displayed.length) return
    const rows = [['Merchant','Category','Date','Amount (€)'], ...displayed.map(r => [r.merchant, r.category, formatDate(r.date), r.total_amount.toFixed(2)])]
    const csv  = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n')
    const url  = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }))
    Object.assign(document.createElement('a'), { href: url, download: `receipts-${todayISO()}.csv` }).click()
    URL.revokeObjectURL(url)
    showToast(`Exported ${displayed.length} receipt${displayed.length !== 1 ? 's' : ''}`)
  }

  // ── Derived ───────────────────────────────────────────────────────────
  const isActive    = connStatus === 'Active'
  const isConnErr   = connStatus.includes('Failed') || connStatus.includes('Blocked') || connStatus.includes('Stopped')
  const statusColor = isActive ? '#10b981' : isConnErr ? '#ef4444' : '#f59e0b'
  const dotCls      = isActive ? 'dot-active' : isConnErr ? 'dot-error' : 'dot-warn'
  const chartTotal  = data?.category_spend.reduce((s, e) => s + e.value, 0) ?? 0
  const isFiltered  = !!(search.trim() || filterCat)

  const displayed = useMemo(() => {
    if (!data) return []
    let list = [...data.recent_receipts]
    if (search.trim()) { const q = search.toLowerCase(); list = list.filter(r => r.merchant.toLowerCase().includes(q) || r.category.toLowerCase().includes(q)) }
    if (filterCat) list = list.filter(r => r.category === filterCat)
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
  }, [data, search, sortBy, filterCat])

  const filteredTotal = displayed.reduce((s, r) => s + r.total_amount, 0)
  const hasChart      = data && (data.category_spend.length > 0 || data.monthly_trend.length > 0)

  // ── Tooltips ──────────────────────────────────────────────────────────
  const CatTip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null
    const d   = payload[0].payload
    const pct = chartTotal > 0 ? Math.round((d.value / chartTotal) * 100) : 0
    return (
      <div className="chart-tip">
        <span className="chart-tip-dot" style={{ background: catColor(d.name) }}/>
        <div>
          <div className="chart-tip-name">{d.name}</div>
          <div className="chart-tip-meta">
            <strong>€{d.value.toFixed(2)}</strong>
            <span className="chart-tip-sep">·</span><span>{pct}%</span>
            <span className="chart-tip-sep">·</span><span>{d.count} item{d.count !== 1 ? 's' : ''}</span>
          </div>
        </div>
      </div>
    )
  }

  const MonthTip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null
    return (
      <div className="chart-tip">
        <div className="chart-tip-name">{label}</div>
        <div className="chart-tip-meta"><strong>€{payload[0].value.toFixed(2)}</strong></div>
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="app-container">

      {/* ── Header ── */}
      <header>
        <div className="brand">
          <LogoIcon size={42}/>
          <div>
            <h1>Receipt Dashboard</h1>
            <p className="subtitle">Your spending at a glance</p>
          </div>
        </div>
        <div className="action-bar">
          <button className="btn btn-secondary" onClick={() => setShowReset(true)}>Reset</button>
          <button className="btn btn-primary" onClick={() => {
            if (showUpload) { setShowUpload(false); resetManualForm(); stopRetry() }
            else { setUploadMode('scan'); setScanErr(null); setShowUpload(true) }
          }}>
            {showUpload ? 'Cancel' : '+ New Receipt'}
          </button>
        </div>
      </header>

      {/* ── Error banner ── */}
      {globalError && (
        <div className="error-banner" onClick={() => setGlobalError(null)}>
          <span className="banner-icon">⚠</span>
          <pre className="banner-msg banner-pre">{globalError}</pre>
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
              <span className="cat-dot" style={{ background: catColor(data.top_category) }}/>
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
            <span className={`status-dot ${dotCls}`}/>{connStatus}
          </div>
        </div>
      </div>

      {/* ── Charts ── */}
      {hasChart && (
        <section className="card chart-card" style={{ animationDelay: '0.25s' }}>
          <div className="chart-header">
            <h3>{chartTab === 'category' ? 'Spending by Category' : 'Monthly Spending'}</h3>
            <div className="chart-tabs">
              <button className={`chart-tab${chartTab === 'category' ? ' active' : ''}`} onClick={() => setChartTab('category')}>Category</button>
              <button className={`chart-tab${chartTab === 'monthly' ? ' active' : ''}`} onClick={() => setChartTab('monthly')} disabled={!data?.monthly_trend.length}>Monthly</button>
            </div>
          </div>

          {chartTab === 'category' && data && data.category_spend.length > 0 && (
            <>
              <p className="chart-subtitle">{data.category_spend.length} categories · €{chartTotal.toFixed(2)} total</p>
              <ResponsiveContainer width="100%" height={Math.max(100, data.category_spend.length * 56)}>
                <BarChart data={data.category_spend} layout="vertical" margin={{ top: 4, right: 120, left: 0, bottom: 4 }}>
                  <XAxis type="number" hide domain={[0, 'dataMax']}/>
                  <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 13, fill: '#86868b' }} axisLine={false} tickLine={false}/>
                  <Tooltip content={<CatTip/>} cursor={{ fill: 'rgba(0,0,0,0.03)' }}/>
                  <Bar dataKey="value" radius={[0,6,6,0]} isAnimationActive animationDuration={900} animationEasing="ease-out">
                    {data.category_spend.map(e => <Cell key={e.name} fill={catColor(e.name)}/>)}
                    <LabelList dataKey="value" position="right"
                      formatter={(v: unknown) => { const pct = chartTotal > 0 ? Math.round((Number(v)/chartTotal)*100) : 0; return `€${Number(v).toFixed(2)}  ${pct}%` }}
                      style={{ fontSize: 12, fill: '#86868b', fontWeight: 500 }}/>
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </>
          )}

          {chartTab === 'monthly' && data && data.monthly_trend.length > 0 && (
            <>
              <p className="chart-subtitle">{data.monthly_trend.length} month{data.monthly_trend.length !== 1 ? 's' : ''} · €{data.monthly_trend.reduce((s,m) => s+m.total, 0).toFixed(2)} total</p>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={data.monthly_trend.map(m => ({ ...m, label: formatMonth(m.month) }))} margin={{ top: 8, right: 24, left: 0, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.05)"/>
                  <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#86868b' }} axisLine={false} tickLine={false}/>
                  <YAxis tick={{ fontSize: 12, fill: '#86868b' }} axisLine={false} tickLine={false} tickFormatter={v => `€${v}`} width={52}/>
                  <Tooltip content={<MonthTip/>} cursor={{ stroke: 'rgba(0,0,0,0.06)', strokeWidth: 2 }}/>
                  <Line type="monotone" dataKey="total" stroke="#3b82f6" strokeWidth={2.5}
                    dot={{ fill: '#3b82f6', r: 4, strokeWidth: 0 }}
                    activeDot={{ r: 6, fill: '#3b82f6', strokeWidth: 0 }}
                    isAnimationActive animationDuration={900}/>
                </LineChart>
              </ResponsiveContainer>
            </>
          )}
        </section>
      )}

      {/* ── Upload panel ── */}
      {showUpload && (
        <section className="card upload-card" style={{ animationDelay: '0s' }}>
          <div className="upload-mode-tabs">
            <button className={`upload-mode-tab${uploadMode === 'scan' ? ' active' : ''}`}
              onClick={() => { setUploadMode('scan'); setScanErr(null) }}>📷  Scan Receipt</button>
            <button className={`upload-mode-tab${uploadMode === 'manual' ? ' active' : ''}`}
              onClick={() => { setUploadMode('manual'); setScanErr(null) }}>✏️  Enter Manually</button>
          </div>

          {/* ── Scan mode ── */}
          {uploadMode === 'scan' && (
            <div className="upload-scan-area">
              <input type="file" ref={fileInputRef} onChange={handleUpload}
                style={{ display: 'none' }} accept="image/*" multiple/>

              <div className={`upload-zone${scanning ? ' loading' : ''}${retryAfter !== null ? ' retrying' : ''}`}
                onClick={() => { if (!scanning && retryAfter === null) fileInputRef.current?.click() }}>

                {/* ── Retry countdown view ── */}
                {retryAfter !== null ? (
                  <div className="upload-retry">
                    <div className="retry-ring">
                      <span className="retry-num">{retryAfter}</span>
                    </div>
                    <p className="retry-label">Rate limited — retrying automatically</p>
                    <p className="retry-hint">Gemini free tier: 15 requests / minute</p>
                    <button className="btn btn-secondary" style={{ marginTop: 8 }}
                      onClick={e => { e.stopPropagation(); stopRetry() }}>Cancel</button>
                  </div>

                /* ── Scanning view ── */
                ) : scanning ? (
                  <div className="upload-loading">
                    <div className="loading-spinner"/>
                    <p>{scanStatus || 'AI is reading your receipt…'}</p>
                    {scanElapsed > 4 && <p className="upload-loading-sub">{scanElapsed}s — please wait</p>}
                  </div>

                /* ── Idle view ── */
                ) : (
                  <>
                    <div className="upload-icon">↑</div>
                    <p className="upload-title">Select receipt images</p>
                    <p className="upload-hint">German &amp; English · Hold ⌘ for multiple</p>
                  </>
                )}
              </div>

              {/* Scan error */}
              {scanErr && (
                <div className="upload-err-block">
                  <p className="upload-err-msg">{scanErr.isNotReceipt ? '🖼 ' : '⚠ '}{scanErr.msg}</p>
                  {scanErr.isNotReceipt && (
                    <button className="btn btn-secondary" onClick={() => { setScanErr(null); setUploadMode('manual') }}>
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
                    value={merchant} onChange={e => setMerchant(e.target.value)}/>
                </div>
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">Date *</label>
                  <input className="form-input" type="date" value={mDate} onChange={e => setMDate(e.target.value)}/>
                </div>
              </div>
              <div className="form-row">
                <div className="form-group" style={{ flex: 2 }}>
                  <label className="form-label">Location</label>
                  <input className="form-input" placeholder="Store address (optional)"
                    value={location} onChange={e => setLocation(e.target.value)}/>
                </div>
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">Total (€){computedTotal > 0 && !mTotal && <span className="form-hint"> auto</span>}</label>
                  <input className="form-input" type="number" step="0.01" min="0"
                    placeholder={computedTotal > 0 ? computedTotal.toFixed(2) : '0.00'}
                    value={mTotal} onChange={e => setMTotal(e.target.value)}/>
                </div>
              </div>

              <div className="form-items-header">
                <span className="form-label">Items <span className="form-hint">(optional)</span></span>
              </div>
              <div className="form-items-list">
                {mItems.map((item, i) => (
                  <div key={i} className="form-item-row">
                    <input className="form-input item-name" placeholder="Product name"
                      value={item.product_name} onChange={e => updateItem(i, 'product_name', e.target.value)}/>
                    <select className="form-input item-cat" value={item.category} onChange={e => updateItem(i, 'category', e.target.value)}>
                      {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <div className="item-price-wrap">
                      <span className="item-price-prefix">€</span>
                      <input className="form-input item-price" type="number" step="0.01" min="0" placeholder="0.00"
                        value={item.price} onChange={e => updateItem(i, 'price', e.target.value)}/>
                    </div>
                    <button className="item-remove-btn" onClick={() => removeItem(i)}>✕</button>
                  </div>
                ))}
              </div>
              <button className="add-item-btn" onClick={addItem}>+ Add Item</button>

              <div className="manual-form-footer">
                <button className="btn btn-secondary" onClick={() => { setShowUpload(false); resetManualForm() }}>Cancel</button>
                <button className="btn btn-primary" disabled={!manualValid || saving} onClick={handleManualSubmit}>
                  {saving ? 'Saving…' : editingId !== null ? 'Save Changes' : 'Add Receipt'}
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
            {data && data.receipt_count > 0 && (isFiltered ? `${displayed.length} of ${data.receipt_count}` : `${data.receipt_count} total`)}
          </span>
        </div>

        {data && data.receipt_count > 0 && (
          <div className="table-toolbar">
            <div className="toolbar-left">
              <div className="search-box">
                <span className="search-icon">⌕</span>
                <input ref={searchRef} className="search-input" type="text" placeholder="Search merchants…"
                  value={search} onChange={e => setSearch(e.target.value)}/>
                {search && <button className="search-clear" onClick={() => { setSearch(''); searchRef.current?.focus() }}>×</button>}
              </div>
              <select className="select-ctrl" value={filterCat} onChange={e => setFilterCat(e.target.value)}>
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
              {isFiltered && <button className="btn-clear" onClick={() => { setSearch(''); setFilterCat('') }}>Clear filters</button>}
            </div>
            <div className="toolbar-right">
              <button className="btn btn-icon" title="Print" onClick={() => window.print()}>⎙</button>
              <button className="btn btn-export" onClick={exportCSV} disabled={!displayed.length}>↓ Export CSV</button>
            </div>
          </div>
        )}

        <table>
          <thead>
            <tr><th>Merchant</th><th>Category</th><th>Date</th><th>Amount</th><th style={{ width: 44 }}/></tr>
          </thead>
          <tbody>
            {displayed.map((r, i) => (
              <tr key={r.id} className="tx-row" style={{ animationDelay: `${0.05 + i * 0.03}s` }}
                onClick={() => handleRowClick(r.id)} title="Click to view details">
                <td className="tx-merchant">
                  <span className="tx-cat-dot" style={{ background: catColor(r.category) }}/>{r.merchant}
                </td>
                <td>
                  <span className="tx-badge" style={{ background: catColor(r.category) + '22', color: catColor(r.category) }}>{r.category}</span>
                </td>
                <td className="tx-date">{formatDate(r.date)}</td>
                <td className="tx-amount">€{r.total_amount.toFixed(2)}</td>
                <td><button className="delete-btn" onClick={e => handleDelete(e, r.id)}>✕</button></td>
              </tr>
            ))}

            {(!data || data.recent_receipts.length === 0) && (
              <tr><td colSpan={5} className="empty-state">
                <div className="empty-icon">🧾</div>
                <p>No receipts yet</p>
                <p className="empty-hint">Scan a receipt or enter one manually</p>
              </td></tr>
            )}

            {data && data.recent_receipts.length > 0 && displayed.length === 0 && (
              <tr><td colSpan={5} className="empty-state">
                <div className="empty-icon">🔍</div>
                <p>No matching receipts</p>
                <p className="empty-hint">Try adjusting your search or filters</p>
              </td></tr>
            )}
          </tbody>

          {displayed.length > 0 && (
            <tfoot>
              <tr className="tx-footer">
                <td colSpan={3}>{isFiltered ? `Showing ${displayed.length} of ${data?.receipt_count}` : `${displayed.length} receipt${displayed.length !== 1 ? 's' : ''}`}</td>
                <td className="tx-amount tx-footer-total">€{filteredTotal.toFixed(2)}</td>
                <td/>
              </tr>
            </tfoot>
          )}
        </table>
      </section>

      {/* ── Detail modal ── */}
      {(loadingDetail || detail) && (
        <div className="modal-overlay" onClick={() => { setDetail(null); setLoadingDetail(false) }}>
          <div className="modal detail-modal" onClick={e => e.stopPropagation()}>
            {loadingDetail ? (
              <div className="detail-loading"><div className="loading-spinner"/><p>Loading receipt…</p></div>
            ) : detail && (
              <>
                <div className="detail-header">
                  <div className="detail-header-info">
                    <h2 className="modal-title">{detail.merchant}</h2>
                    {detail.location && <p className="detail-location">{detail.location}</p>}
                    <p className="detail-meta">{formatDate(detail.date)}</p>
                  </div>
                  <div className="detail-header-actions">
                    <button className="btn btn-secondary btn-sm" onClick={() => openEdit(detail)}>Edit</button>
                    <button className="detail-close" onClick={() => setDetail(null)}>✕</button>
                  </div>
                </div>
                <div className="detail-items">
                  {detail.items.length === 0 ? (
                    <p className="detail-no-items">No item breakdown available</p>
                  ) : detail.items.map((item, i) => (
                    <div key={i} className="detail-item">
                      <div className="detail-item-left">
                        <span className="tx-cat-dot" style={{ background: catColor(item.category), width: 8, height: 8, flexShrink: 0 }}/>
                        <span className="detail-item-name">{item.product_name}</span>
                      </div>
                      <div className="detail-item-right">
                        <span className="tx-badge" style={{ background: catColor(item.category) + '22', color: catColor(item.category) }}>{item.category}</span>
                        <span className="detail-item-price">€{item.price.toFixed(2)}</span>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="detail-footer">
                  <span>Total paid</span>
                  <strong>€{detail.total_amount.toFixed(2)}</strong>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Reset modal ── */}
      {showReset && (
        <div className="modal-overlay" onClick={() => setShowReset(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-icon">⚠️</div>
            <h2 className="modal-title">Clear all data?</h2>
            <p className="modal-body">This will permanently delete all receipts and cannot be undone.</p>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setShowReset(false)}>Cancel</button>
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
