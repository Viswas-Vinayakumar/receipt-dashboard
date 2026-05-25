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
  daily_trend:    { date: string; total: number }[]
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
interface DuplicateInfo { merchant: string; date: string; amount: number; existing_id: number }

interface InsightsData {
  by_store:   { merchant: string; total: number; visits: number }[]
  by_product: { name: string; total: number; count: number }[]
  by_month:   { month: string; month_total: number; products: { name: string; total: number }[] }[]
}

type SortOption  = 'date-desc' | 'date-asc' | 'amount-desc' | 'amount-asc' | 'merchant'
type ChartTab    = 'category' | 'monthly'
type UploadMode  = 'scan' | 'manual'
type InsightTab  = 'store' | 'product' | 'month'

// ── Constants ──────────────────────────────────────────────────────────────
const CATEGORIES = ['Groceries','Bakery','Beverages','Electronics','Dining','Transport','Health','Accommodation','Deposit','Others']

const CATEGORY_COLORS: Record<string, string> = {
  Groceries:     '#34d399',
  Bakery:        '#fb923c',
  Beverages:     '#60a5fa',
  Electronics:   '#a78bfa',
  Dining:        '#f472b6',
  Transport:     '#38bdf8',
  Health:        '#f87171',
  Accommodation: '#818cf8',
  Deposit:       '#94a3b8',
  Others:        '#fbbf24',
}

const catColor = (name: string) => CATEGORY_COLORS[name] ?? '#94a3b8'

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

const formatMonth = (m: string) => {
  const [y, mo] = m.split('-')
  return `${MONTH_NAMES[parseInt(mo) - 1]} ${y}`
}

const formatDay = (d: string) => {
  // d = "2026-05-21" → "May 21"
  const [, mo, dd] = d.split('-')
  return `${MONTH_NAMES[parseInt(mo) - 1]} ${parseInt(dd)}`
}

const emptyManualItem = (): ManualItem => ({ product_name: '', category: 'Groceries', price: '' })
const todayISO = () => new Date().toISOString().split('T')[0]

// ── Product emoji map ─────────────────────────────────────────────────────
const PRODUCT_EMOJI_MAP: [string, string][] = [
  ['banana','🍌'],['banane','🍌'],['apple','🍎'],['apfel','🍎'],
  ['orange','🍊'],['lemon','🍋'],['zitrone','🍋'],['grape','🍇'],
  ['weintraub','🍇'],['strawberry','🍓'],['erdbeere','🍓'],
  ['tomato','🍅'],['tomate','🍅'],['carrot','🥕'],['karotte','🥕'],
  ['möhre','🥕'],['potato','🥔'],['kartoffel','🥔'],['onion','🧅'],
  ['zwiebel','🧅'],['garlic','🧄'],['knoblauch','🧄'],
  ['paprika','🫑'],['cucumber','🥒'],['gurke','🥒'],
  ['lettuce','🥬'],['salat','🥬'],['broccoli','🥦'],
  ['mushroom','🍄'],['pilz','🍄'],
  ['milk','🥛'],['milch','🥛'],['cheese','🧀'],['käse','🧀'],
  ['butter','🧈'],['yogurt','🥛'],['joghurt','🥛'],['sahne','🫙'],
  ['egg','🥚'],['ei ','🥚'],['eier','🥚'],
  ['chicken','🍗'],['hähnchen','🍗'],['hühnchen','🍗'],
  ['beef','🥩'],['rindfleisch','🥩'],['pork','🥩'],
  ['sausage','🌭'],['wurst','🌭'],['bratwurst','🌭'],
  ['schinken','🥩'],['fish','🐟'],['fisch','🐟'],
  ['salmon','🐟'],['lachs','🐟'],['shrimp','🦐'],
  ['bread','🍞'],['brot','🍞'],['brötchen','🥖'],
  ['cake','🎂'],['kuchen','🎂'],['croissant','🥐'],
  ['muffin','🧁'],['pretzel','🥨'],['brezel','🥨'],
  ['cookie','🍪'],['keks','🍪'],
  ['coffee','☕'],['kaffee','☕'],['tea','🍵'],['tee','🍵'],
  ['water','💧'],['wasser','💧'],['juice','🧃'],['saft','🧃'],
  ['beer','🍺'],['bier','🍺'],['wine','🍷'],['wein','🍷'],
  ['cola','🥤'],['soda','🥤'],
  ['chocolate','🍫'],['schokolade','🍫'],['schoko','🍫'],
  ['candy','🍬'],['bonbon','🍬'],['chips','🍟'],
  ['nuts','🥜'],['nüsse','🥜'],['eis','🍦'],
  ['pasta','🍝'],['rice','🍚'],['reis','🍚'],
  ['flour','🌾'],['mehl','🌾'],['sugar','🍬'],['zucker','🍬'],
  ['salt','🧂'],['salz','🧂'],['oil','🫙'],['öl','🫙'],
  ['shampoo','🧴'],['soap','🧼'],['seife','🧼'],
  ['tissue','🧻'],['toilettenp','🧻'],
  ['medicine','💊'],['medizin','💊'],['tabletten','💊'],
  ['phone','📱'],['handy','📱'],['laptop','💻'],
  ['cable','🔌'],['kabel','🔌'],['battery','🔋'],['batterie','🔋'],
  ['pen','✏️'],['stift','✏️'],['book','📚'],['buch','📚'],
]
const getProductEmoji = (name: string): string => {
  const lower = name.toLowerCase()
  for (const [kw, emoji] of PRODUCT_EMOJI_MAP) {
    if (lower.includes(kw)) return emoji
  }
  return '🛍️'
}

// ── Logo — receipt scroll in gradient ring ────────────────────────────────
const LogoIcon = ({ size = 40 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 84 84" fill="none" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="rzGrad" x1="4" y1="4" x2="80" y2="80" gradientUnits="userSpaceOnUse">
        <stop stopColor="#6366f1"/>
        <stop offset="1" stopColor="#0071e3"/>
      </linearGradient>
    </defs>
    {/* Gradient ring */}
    <circle cx="42" cy="42" r="37" stroke="url(#rzGrad)" strokeWidth="2.5" fill="rgba(245,248,255,0.4)"/>
    {/* Receipt body */}
    <rect x="25" y="14" width="34" height="52" rx="5" fill="white" stroke="#e0eaf8" strokeWidth="1.5"/>
    {/* Merchant bar — bold blue */}
    <rect x="32" y="22" width="20" height="3.5" rx="1.75" fill="#0071e3"/>
    {/* Item lines */}
    <rect x="32" y="31" width="14" height="2" rx="1" fill="#ccd8ee"/>
    <rect x="32" y="36.5" width="18" height="2" rx="1" fill="#ccd8ee"/>
    <rect x="32" y="42" width="11" height="2" rx="1" fill="#ccd8ee"/>
    {/* Separator */}
    <line x1="32" y1="48" x2="51" y2="48" stroke="#e0eaf8" strokeWidth="1"/>
    {/* Total row — gradient */}
    <rect x="32" y="53" width="9" height="3" rx="1.5" fill="#6366f1"/>
    <rect x="43" y="52.5" width="8" height="3.5" rx="1.75" fill="#0071e3"/>
  </svg>
)

// ── Component ──────────────────────────────────────────────────────────────
function App() {
  // ── Core state ─────────────────────────────────────────────────────────
  const [data, setData]                       = useState<DashboardData | null>(null)
  const [loading, setLoading]                 = useState(false)
  const [error, setError]                     = useState<string | null>(null)
  const [rateLimitWarn, setRateLimitWarn]     = useState<string | null>(null)
  const [retryAfter, setRetryAfter]           = useState<number | null>(null)
  const [toast, setToast]                     = useState<Toast | null>(null)
  const [, setConnectionStatus] = useState('Initializing...')

  const retryFilesRef = useRef<File[]>([])
  const retryTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── Upload panel ────────────────────────────────────────────────────────
  const [showUpload, setShowUpload]           = useState(false)
  const [uploadMode, setUploadMode]           = useState<UploadMode>('scan')
  const [, setUploadStatus]                   = useState('')
  const [uploadErr, setUploadErr]             = useState<{ msg: string; isNotReceipt: boolean; isDuplicate?: boolean; dupInfo?: DuplicateInfo } | null>(null)
  const [isDragging, setIsDragging]           = useState(false)

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

  // ── Insights ─────────────────────────────────────────────────────────────
  const [insights, setInsights]               = useState<InsightsData | null>(null)
  const [insightTab, setInsightTab]           = useState<InsightTab>('store')
  const [expandedMonths, setExpandedMonths]   = useState<Set<string>>(new Set())
  const [insightShowAll, setInsightShowAll]   = useState({ store: false, product: false, month: false })
  const [showEnginePopup, setShowEnginePopup] = useState(false)
  const engineShownRef                        = useRef(false)

  // ── Scan animation phases ─────────────────────────────────────────────────
  const SCAN_PHASES = ['Reading receipt…', 'Detecting items…', 'Extracting totals…', 'Finalising…']
  const [scanPhase, setScanPhase]             = useState(0)
  useEffect(() => {
    if (!loading) { setScanPhase(0); return }
    const t = setInterval(() => setScanPhase(p => (p + 1) % SCAN_PHASES.length), 2200)
    return () => clearInterval(t)
  }, [loading])

  // ── Dark mode ─────────────────────────────────────────────────────────────
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('darkMode') === 'true')
  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode)
    localStorage.setItem('darkMode', String(darkMode))
  }, [darkMode])

  // ── AI badge (fades in then disappears) ──────────────────────────────────
  const [showAiBadge, setShowAiBadge] = useState(true)
  useEffect(() => {
    const t = setTimeout(() => setShowAiBadge(false), 5000)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    if (!showEnginePopup) return
    const t = setTimeout(() => setShowEnginePopup(false), 4000)
    return () => clearTimeout(t)
  }, [showEnginePopup])

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

  // ── Retry helpers ────────────────────────────────────────────────────────
  const stopRetry = () => {
    if (retryTimerRef.current) { clearInterval(retryTimerRef.current); retryTimerRef.current = null }
    setRetryAfter(null)
    retryFilesRef.current = []
  }

  // Forward declaration — doUploadFiles is defined below; the interval callback
  // only fires after all declarations complete, so the closure is safe.
  const startRetryCountdown = (seconds: number, files: File[]) => {
    stopRetry()
    retryFilesRef.current = files
    setRetryAfter(seconds)
    retryTimerRef.current = setInterval(() => {
      setRetryAfter(prev => {
        if (prev === null || prev <= 1) {
          clearInterval(retryTimerRef.current!)
          retryTimerRef.current = null
          doUploadFiles(retryFilesRef.current)
          retryFilesRef.current = []
          return null
        }
        return prev - 1
      })
    }, 1000)
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
          if (!engineShownRef.current) {
            engineShownRef.current = true
            setShowEnginePopup(true)
          }
          try {
            const insRes = await tauriFetch(`${base}/api/insights`)
            if (insRes.ok) setInsights(await insRes.json())
          } catch {}
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
          setError(`macOS blocked the AI engine. Open Terminal and run:\n  xattr -dr com.apple.quarantine "/Applications/Rezet.app"\nthen relaunch the app.`)
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
        setError(`macOS blocked the AI engine. Open Terminal and run:\n  xattr -dr com.apple.quarantine "/Applications/Rezet.app"\nthen relaunch.`)
        setConnectionStatus('Security Blocked')
      }
    }

    startBackend()
    return () => { cancelled = true; started = false }
  }, [])

  // ── Parse backend response (reads body once, returns for both success and error) ──
  const parseResponse = async (res: Response): Promise<{ msg: string; status: number; json: any }> => {
    const raw = await res.text().catch(() => '')
    let parsed: any = null
    try { parsed = JSON.parse(raw) } catch {}
    const msg = parsed?.detail ?? parsed?.message ?? raw ?? res.statusText
    return { msg, status: res.status, json: parsed }
  }

  // ── AI Upload ────────────────────────────────────────────────────────────
  const doUploadFiles = async (files: File[]) => {
    if (!files.length) return
    stopRetry()
    setLoading(true); setError(null); setRateLimitWarn(null); setUploadErr(null)
    let ok = 0
    const errs: string[] = []

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        setUploadStatus(files.length > 1 ? `Analyzing ${i + 1} of ${files.length}…` : 'Analyzing your receipt…')
        try {
          const buf  = await file.arrayBuffer()
          const form = new FormData()
          form.append('file', new Blob([buf], { type: file.type || 'image/jpeg' }), file.name)
          const res = await tauriFetch('http://127.0.0.1:8888/api/upload', { method: 'POST', body: form })
          const { msg, status, json: respJson } = await parseResponse(res)

          if (!res.ok) {
            if (status === 400 && msg === 'not_a_receipt') {
              setUploadErr({
                msg: "This image doesn't look like a receipt. Try a clearer photo, or enter the details manually.",
                isNotReceipt: true
              })
              errs.push('not_a_receipt')
            } else if (status === 409) {
              // Exact image duplicate — blocked before AI scan
              const dup = respJson ? (typeof respJson.detail === 'string' ? JSON.parse(respJson.detail) : respJson.detail) : null
              if (dup) {
                const dateStr = dup.date ? new Date(dup.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''
                setUploadErr({
                  msg: `Already uploaded — ${dup.merchant}${dateStr ? `, ${dateStr}` : ''} (€${(dup.amount as number).toFixed(2)})`,
                  isNotReceipt: false,
                  isDuplicate: true,
                  dupInfo: { merchant: dup.merchant, date: dup.date, amount: dup.amount, existing_id: dup.existing_id }
                })
              } else {
                setUploadErr({ msg: 'This receipt was already uploaded.', isNotReceipt: false, isDuplicate: true })
              }
              errs.push('duplicate')
            } else if (status === 429) {
              const m = msg.match(/rate_limit:(\d+)/)
              const wait = m ? parseInt(m[1]) : 62
              setLoading(false); setUploadStatus('')
              if (fileInputRef.current) fileInputRef.current.value = ''
              startRetryCountdown(wait, files.slice(i))
              return
            } else if (status === 401 || status === 503) {
              setError(msg); errs.push(msg)
            } else {
              errs.push(msg || 'Upload failed')
            }
          } else {
            ok++
            // Check for possible semantic duplicate warning (same merchant+date+amount)
            if (respJson?.warning === 'possible_duplicate' && respJson?.existing) {
              const e = respJson.existing
              const dateStr = e.date ? new Date(e.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''
              setUploadErr({
                msg: `Possible duplicate — a ${e.merchant}${dateStr ? ` receipt from ${dateStr}` : ' receipt'} for €${(e.amount as number).toFixed(2)} already exists.`,
                isNotReceipt: false,
                isDuplicate: true,
                dupInfo: { merchant: e.merchant, date: e.date, amount: e.amount, existing_id: e.id }
              })
            }
          }
        } catch (err) {
          errs.push(err instanceof Error ? err.message : `${file.name}: upload failed`)
        }
      }

      await fetchData()

      const realErrs = errs.filter(e => e !== 'not_a_receipt')
      if (!realErrs.length && !uploadErr) {
        setShowUpload(false)
        showToast(ok === 1 ? 'Receipt scanned successfully' : `${ok} receipts scanned`)
      } else if (ok > 0) {
        showToast(`${ok} of ${files.length} receipts processed`)
      } else if (realErrs.length) {
        setError(realErrs.length === 1 ? realErrs[0] : `${realErrs.length} of ${files.length} failed — ${realErrs.join('; ')}`)
      }
    } finally {
      setLoading(false); setUploadStatus('')
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (!files.length) return
    await doUploadFiles(files)
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
            <h1>Rezet</h1>
            <div className="subtitle-row">
              <p className="subtitle">Your spending at a glance</p>
              {showAiBadge && <span className="ai-badge">✦ AI powered</span>}
            </div>
          </div>
        </div>
        <div className="action-bar">
          <button
            className="btn btn-icon dark-toggle"
            onClick={() => setDarkMode(d => !d)}
            title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          >{darkMode ? '☀' : '⏾'}</button>
          <button className="btn btn-secondary" onClick={() => setShowResetModal(true)}>Reset</button>
          <button className="btn btn-primary" onClick={() => {
            setUploadMode('scan'); setUploadErr(null); setShowUpload(true)
          }}>+ New Receipt</button>
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
      <div className={`dashboard-grid${insights?.by_product?.length ? ' grid-4' : ''}`}>
        <div className="card stat-card stat-card--blue" style={{ animationDelay: '0.05s' }}>
          <h3>Total Spent</h3>
          <div className="stat-value">€{data?.total_spent.toFixed(2) ?? '0.00'}</div>
          {data && data.receipt_count > 0 && (
            <div className="stat-sub">avg €{(data.total_spent / data.receipt_count).toFixed(2)} / receipt</div>
          )}
        </div>
        <div className="card stat-card stat-card--purple" style={{ animationDelay: '0.1s' }}>
          <h3>Receipts</h3>
          <div className="stat-value">{data?.receipt_count ?? 0}</div>
          {data && data.category_spend.length > 0 && (
            <div className="stat-sub">{data.category_spend.length} categories</div>
          )}
        </div>
        <div className="card stat-card stat-card--green" style={{ animationDelay: '0.15s' }}>
          <h3>Top Category</h3>
          <div className="stat-value category-badge" style={{ fontSize: '22px' }}>
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

        {/* ── Top Product stat card ── */}
        {insights?.by_product?.length ? (
          <div className="card stat-card stat-card--orange" style={{ animationDelay: '0.2s' }}>
            <h3>Top Product</h3>
            <div className="top-product-stat">
              <span className="top-product-emoji">{getProductEmoji(insights.by_product[0].name)}</span>
              <span className="top-product-stat-name">{insights.by_product[0].name}</span>
            </div>
            <div className="stat-sub">€{insights.by_product[0].total.toFixed(2)} · ×{insights.by_product[0].count}</div>
          </div>
        ) : null}
      </div>

      {/* ── Charts ── */}
      {hasChart && (
        <section className="card chart-card" style={{ animationDelay: '0.25s' }}>
          <div className="chart-header">
            <h3>{chartTab === 'category' ? 'Spending by Category' : (data && data.monthly_trend.length <= 1 && (data.daily_trend?.length ?? 0) > 0 ? 'Daily Spending' : 'Monthly Spending')}</h3>
            <div className="chart-tabs">
              <button
                className={`chart-tab${chartTab === 'category' ? ' active' : ''}`}
                onClick={() => setChartTab('category')}
              >Category</button>
              <button
                className={`chart-tab${chartTab === 'monthly' ? ' active' : ''}`}
                onClick={() => setChartTab('monthly')}
                disabled={!data?.monthly_trend.length && !data?.daily_trend?.length}
              >{data && data.monthly_trend.length <= 1 && (data.daily_trend?.length ?? 0) > 0 ? 'Daily' : 'Monthly'}</button>
            </div>
          </div>

          {chartTab === 'category' && data && data.category_spend.filter(c => c.value > 0).length > 0 && (() => {
            const rows = data.category_spend.filter(c => c.value > 0)
            return (
            <>
              <p className="chart-subtitle">{rows.length} categor{rows.length !== 1 ? 'ies' : 'y'} · €{chartTotal.toFixed(2)} total</p>
              <ResponsiveContainer width="100%" height={Math.max(100, rows.length * 58)}>
                <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 90, left: 0, bottom: 4 }}>
                  <defs>
                    {rows.map(e => (
                      <linearGradient key={e.name} id={`grad-${e.name}`} x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0%" stopColor={catColor(e.name)} stopOpacity={0.72} />
                        <stop offset="100%" stopColor={catColor(e.name)} stopOpacity={1} />
                      </linearGradient>
                    ))}
                  </defs>
                  <XAxis type="number" hide domain={[0, 'dataMax']} />
                  <YAxis type="category" dataKey="name" width={116} tick={{ fontSize: 13, fill: darkMode ? '#a0a0ab' : '#86868b' }} axisLine={false} tickLine={false} />
                  <Tooltip content={<CategoryTooltip />} cursor={{ fill: 'rgba(0,0,0,0.03)' }} />
                  <Bar dataKey="value" radius={[0, 7, 7, 0]} isAnimationActive animationDuration={900} animationEasing="ease-out">
                    {rows.map(e => <Cell key={e.name} fill={`url(#grad-${e.name})`} />)}
                    <LabelList
                      dataKey="value"
                      position="insideLeft"
                      offset={9}
                      formatter={(v: unknown) => {
                        const pct = chartTotal > 0 ? Math.round((Number(v) / chartTotal) * 100) : 0
                        return pct >= 5 ? `${pct}%` : ''
                      }}
                      style={{ fontSize: 11, fill: 'rgba(255,255,255,0.92)', fontWeight: 700 }}
                    />
                    <LabelList
                      dataKey="value"
                      position="right"
                      formatter={(v: unknown) => `€${Number(v).toFixed(2)}`}
                      style={{ fontSize: 12, fill: darkMode ? '#8e8e93' : '#86868b', fontWeight: 500 }}
                    />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </>
            )
          })()}

          {chartTab === 'monthly' && data && (data.monthly_trend.length > 0 || data.daily_trend?.length > 0) && (() => {
            const useDaily = data.monthly_trend.length <= 1 && (data.daily_trend?.length ?? 0) > 0
            const totalSpend = useDaily
              ? data.daily_trend.reduce((s, d) => s + d.total, 0)
              : data.monthly_trend.reduce((s, m) => s + m.total, 0)
            return (
              <>
                <p className="chart-subtitle">
                  {useDaily
                    ? `${data.daily_trend.length} day${data.daily_trend.length !== 1 ? 's' : ''} · €${totalSpend.toFixed(2)} total`
                    : `${data.monthly_trend.length} month${data.monthly_trend.length !== 1 ? 's' : ''} · €${totalSpend.toFixed(2)} total`
                  }
                </p>
                <ResponsiveContainer width="100%" height={220}>
                  {useDaily ? (
                    <BarChart data={data.daily_trend.map(d => ({ ...d, label: formatDay(d.date) }))} margin={{ top: 8, right: 24, left: 0, bottom: 8 }} barCategoryGap="32%">
                      <CartesianGrid strokeDasharray="3 3" stroke={darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'} vertical={false} />
                      <XAxis dataKey="label" tick={{ fontSize: 11, fill: darkMode ? '#a0a0ab' : '#86868b' }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 12, fill: darkMode ? '#a0a0ab' : '#86868b' }} axisLine={false} tickLine={false} tickFormatter={v => `€${v}`} width={52} />
                      <Tooltip content={<MonthlyTooltip />} cursor={{ fill: darkMode ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)' }} />
                      <Bar dataKey="total" radius={[6, 6, 0, 0]} isAnimationActive animationDuration={900}>
                        {data.daily_trend.map((_, i) => (
                          <Cell key={i} fill={darkMode ? '#3b82f6' : '#2563eb'} fillOpacity={0.85} />
                        ))}
                      </Bar>
                    </BarChart>
                  ) : (
                    <LineChart data={data.monthly_trend.map(m => ({ ...m, label: formatMonth(m.month) }))} margin={{ top: 8, right: 24, left: 0, bottom: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'} />
                      <XAxis dataKey="label" tick={{ fontSize: 12, fill: darkMode ? '#a0a0ab' : '#86868b' }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 12, fill: darkMode ? '#a0a0ab' : '#86868b' }} axisLine={false} tickLine={false} tickFormatter={v => `€${v}`} width={52} />
                      <Tooltip content={<MonthlyTooltip />} cursor={{ stroke: darkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)', strokeWidth: 2 }} />
                      <Line
                        type="monotone" dataKey="total" stroke="#3b82f6" strokeWidth={2.5}
                        dot={{ fill: '#3b82f6', r: 4, strokeWidth: 0 }}
                        activeDot={{ r: 6, fill: '#3b82f6', strokeWidth: 0 }}
                        isAnimationActive animationDuration={900}
                      />
                    </LineChart>
                  )}
                </ResponsiveContainer>
              </>
            )
          })()}
        </section>
      )}

      {/* ── Upload modal ── */}
      {showUpload && (
        <div className="upload-overlay" onClick={e => { if (e.target === e.currentTarget) { setShowUpload(false); resetManualForm() } }}>
          <div className="upload-modal">

            {/* Modal header */}
            <div className="upload-modal-header">
              <h2 className="upload-modal-title">
                {editingId !== null ? 'Edit Receipt' : 'New Receipt'}
              </h2>
              <button className="upload-close-btn" onClick={() => { setShowUpload(false); resetManualForm() }}>✕</button>
            </div>

            {/* Mode tabs */}
            <div className="upload-mode-tabs">
              <button
                className={`upload-mode-tab${uploadMode === 'scan' ? ' active' : ''}`}
                onClick={() => { setUploadMode('scan'); setUploadErr(null) }}
              >📷  Scan</button>
              <button
                className={`upload-mode-tab${uploadMode === 'manual' ? ' active' : ''}`}
                onClick={() => { setUploadMode('manual'); setUploadErr(null) }}
              >✏️  Manual</button>
            </div>

            {/* ── Scan mode ── */}
            {uploadMode === 'scan' && (
              <div className="upload-scan-area">
                <input type="file" ref={fileInputRef} onChange={handleUpload}
                  style={{ display: 'none' }} accept="image/*" multiple />
                <div
                  className={`upload-zone${loading ? ' loading' : ''}${retryAfter !== null ? ' retrying' : ''}${isDragging ? ' drag-over' : ''}`}
                  onClick={() => !loading && retryAfter === null && fileInputRef.current?.click()}
                  onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
                  onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragging(false) }}
                  onDrop={e => {
                    e.preventDefault(); setIsDragging(false)
                    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'))
                    if (files.length) doUploadFiles(files)
                  }}
                >
                  {retryAfter !== null ? (
                    <div className="upload-loading">
                      <div className="retry-ring"><span className="retry-num">{retryAfter}</span></div>
                      <p className="retry-label">Rate limit — retrying in {retryAfter}s</p>
                      <button className="btn btn-secondary" style={{ marginTop: 8 }}
                        onClick={e => { e.stopPropagation(); stopRetry() }}>Cancel</button>
                    </div>
                  ) : loading ? (
                    <div className="scan-wrapper">
                      <div className="scan-receipt">
                        <div className="scan-receipt-lines">
                          <div className="scan-rline l" /><div className="scan-rline m" />
                          <div className="scan-rline l" /><div className="scan-rline s" />
                          <div className="scan-rline m" /><div className="scan-rline l" />
                          <div className="scan-rline s" />
                        </div>
                        <div className="scan-beam" />
                      </div>
                      <div className="scan-status">
                        <p className="scan-phase" key={scanPhase}>{SCAN_PHASES[scanPhase]}</p>
                        <p className="upload-hint-sub">Local AI · stays on your Mac</p>
                      </div>
                    </div>
                  ) : (
                    <div className="upload-idle">
                      <div className="upload-icon-circle">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/>
                          <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>
                        </svg>
                      </div>
                      <p className="upload-title">{isDragging ? 'Release to scan' : 'Drop your receipt'}</p>
                      <p className="upload-hint">or <span className="upload-browse-link">click to browse</span></p>
                      <p className="upload-hint-sub">German & English · JPG, PNG · ⌘ multi-select</p>
                    </div>
                  )}
                </div>

                {uploadErr && (
                  <div className={`upload-err-block${uploadErr.isDuplicate ? ' upload-err-dup' : ''}`}>
                    <p className="upload-err-msg">
                      {uploadErr.isDuplicate ? '🔁 ' : uploadErr.isNotReceipt ? '🖼 ' : '⚠ '}{uploadErr.msg}
                    </p>
                    {uploadErr.isNotReceipt && (
                      <button className="btn btn-secondary" onClick={() => { setUploadErr(null); setUploadMode('manual') }}>
                        Enter manually →
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
                    <input className="form-input" type="number" step="0.01" min="0"
                      placeholder={computedTotal > 0 ? computedTotal.toFixed(2) : '0.00'}
                      value={manualTotal} onChange={e => setManualTotal(e.target.value)} />
                  </div>
                </div>

                <div className="form-items-header">
                  <span className="form-label">Items <span className="form-hint">(optional)</span></span>
                </div>
                <div className="form-items-list">
                  {manualItems.map((item, i) => (
                    <div key={i} className="form-item-row">
                      <input className="form-input item-name" placeholder="Product name"
                        value={item.product_name} onChange={e => updateManualItem(i, 'product_name', e.target.value)} />
                      <select className="form-input item-cat" value={item.category}
                        onChange={e => updateManualItem(i, 'category', e.target.value)}>
                        {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <div className="item-price-wrap">
                        <span className="item-price-prefix">€</span>
                        <input className="form-input item-price" type="number" step="0.01" min="0" placeholder="0.00"
                          value={item.price} onChange={e => updateManualItem(i, 'price', e.target.value)} />
                      </div>
                      <button className="item-remove-btn" onClick={() => removeManualItem(i)} title="Remove">✕</button>
                    </div>
                  ))}
                </div>
                <button className="add-item-btn" onClick={addManualItem}>+ Add Item</button>

                <div className="manual-form-footer">
                  <button className="btn btn-secondary" onClick={() => { setShowUpload(false); resetManualForm() }}>Cancel</button>
                  <button className="btn btn-primary" disabled={!manualValid || submittingManual} onClick={handleManualSubmit}>
                    {submittingManual ? 'Saving…' : editingId !== null ? 'Save Changes' : 'Add Receipt'}
                  </button>
                </div>
              </div>
            )}

          </div>
        </div>
      )}

      {/* ── Insights ── */}
      {insights && (insights.by_store.length > 0 || insights.by_product.length > 0 || insights.by_month.length > 0) && (() => {
        const LIMIT = 5
        return (
        <section className="card insights-card" style={{ animationDelay: '0.28s' }}>
          <div className="chart-header">
            <h3>Insights</h3>
            <div className="chart-tabs">
              <button className={`chart-tab${insightTab === 'store' ? ' active' : ''}`}
                onClick={() => { setInsightTab('store'); setInsightShowAll(p => ({...p, store: false})) }}>By Store</button>
              <button className={`chart-tab${insightTab === 'product' ? ' active' : ''}`}
                onClick={() => { setInsightTab('product'); setInsightShowAll(p => ({...p, product: false})) }}
                disabled={insights.by_product.length === 0}>By Product</button>
              <button className={`chart-tab${insightTab === 'month' ? ' active' : ''}`}
                onClick={() => { setInsightTab('month'); setInsightShowAll(p => ({...p, month: false})) }}
                disabled={insights.by_month.length === 0}>By Month</button>
            </div>
          </div>

          {/* ── By Store ── */}
          {insightTab === 'store' && (
            <div className="insights-list">
              {(insightShowAll.store ? insights.by_store : insights.by_store.slice(0, LIMIT)).map((s, i) => {
                const maxTotal = insights.by_store[0]?.total || 1
                const pct = Math.round((s.total / maxTotal) * 100)
                return (
                  <div key={s.merchant} className="insight-row" style={{ animationDelay: `${i * 0.05}s` }}>
                    <div className="insight-row-header">
                      <span className="insight-name">{s.merchant}</span>
                      <div className="insight-row-right">
                        <span className="insight-badge">{s.visits} visit{s.visits !== 1 ? 's' : ''}</span>
                        <span className="insight-amount">€{s.total.toFixed(2)}</span>
                      </div>
                    </div>
                    <div className="insight-bar-track">
                      <div className="insight-bar-fill insight-bar-store" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                )
              })}
              {insights.by_store.length > LIMIT && (
                <button className="insight-expand-btn" onClick={() => setInsightShowAll(p => ({...p, store: !p.store}))}>
                  {insightShowAll.store ? '↑ Show less' : `↓ Show ${insights.by_store.length - LIMIT} more`}
                </button>
              )}
            </div>
          )}

          {/* ── By Product ── */}
          {insightTab === 'product' && (
            <div className="insights-list">
              {insights.by_product.length === 0 ? (
                <p className="insights-empty">No item data yet — scan receipts with item breakdowns to see product insights</p>
              ) : (
                <>
                  <p className="chart-subtitle">{insights.by_product.length} unique product{insights.by_product.length !== 1 ? 's' : ''} tracked</p>
                  {(insightShowAll.product ? insights.by_product : insights.by_product.slice(0, LIMIT)).map((p, i) => {
                    const maxTotal = insights.by_product[0]?.total || 1
                    const pct = Math.round((p.total / maxTotal) * 100)
                    return (
                      <div key={p.name} className="insight-row" style={{ animationDelay: `${i * 0.04}s` }}>
                        <div className="insight-row-header">
                          <span className="insight-name">{p.name}</span>
                          <div className="insight-row-right">
                            <span className="insight-badge">×{p.count}</span>
                            <span className="insight-amount">€{p.total.toFixed(2)}</span>
                          </div>
                        </div>
                        <div className="insight-bar-track">
                          <div className="insight-bar-fill insight-bar-product" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    )
                  })}
                  {insights.by_product.length > LIMIT && (
                    <button className="insight-expand-btn" onClick={() => setInsightShowAll(p => ({...p, product: !p.product}))}>
                      {insightShowAll.product ? '↑ Show less' : `↓ Show ${insights.by_product.length - LIMIT} more`}
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          {/* ── By Month ── */}
          {insightTab === 'month' && (
            <div className="insights-month-list">
              {insights.by_month.length === 0 ? (
                <p className="insights-empty">No monthly data yet</p>
              ) : (insightShowAll.month ? insights.by_month : insights.by_month.slice(0, LIMIT)).map(m => {
                const isOpen = expandedMonths.has(m.month)
                const toggle = () => setExpandedMonths(prev => {
                  const next = new Set(prev)
                  isOpen ? next.delete(m.month) : next.add(m.month)
                  return next
                })
                return (
                  <div key={m.month} className="month-accordion">
                    <button className={`month-accordion-header${isOpen ? ' open' : ''}`} onClick={toggle}>
                      <span className="month-label">{formatMonth(m.month)}</span>
                      <div className="month-header-right">
                        {m.products.length > 0 && (
                          <span className="insight-badge">{m.products.length} product{m.products.length !== 1 ? 's' : ''}</span>
                        )}
                        <span className="insight-amount">€{m.month_total.toFixed(2)}</span>
                        <span className={`month-chevron${isOpen ? ' open' : ''}`}>›</span>
                      </div>
                    </button>
                    {isOpen && (
                      <div className="month-accordion-body">
                        {m.products.length === 0 ? (
                          <p className="insights-empty" style={{ padding: '8px 0' }}>No item data for this month</p>
                        ) : m.products.map((p, i) => {
                          const maxTotal = m.products[0]?.total || 1
                          const pct = Math.round((p.total / maxTotal) * 100)
                          return (
                            <div key={p.name} className="insight-row sub-row" style={{ animationDelay: `${i * 0.03}s` }}>
                              <div className="insight-row-header">
                                <span className="insight-name">{p.name}</span>
                                <span className="insight-amount">€{p.total.toFixed(2)}</span>
                              </div>
                              <div className="insight-bar-track">
                                <div className="insight-bar-fill insight-bar-month" style={{ width: `${pct}%` }} />
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
              {insights.by_month.length > LIMIT && (
                <button className="insight-expand-btn" onClick={() => setInsightShowAll(p => ({...p, month: !p.month}))}>
                  {insightShowAll.month ? '↑ Show less' : `↓ Show ${insights.by_month.length - LIMIT} more`}
                </button>
              )}
            </div>
          )}
        </section>
        )
      })()}

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

      {/* ── Engine ready popup ── */}
      {showEnginePopup && (
        <div className="engine-popup">
          <span className="engine-popup-dot" />
          <span>AI Engine Ready</span>
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
