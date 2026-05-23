import { useState, useEffect, useRef } from 'react'
import { Command } from '@tauri-apps/plugin-shell'
import './App.css'

interface DashboardData {
  total_spent: number;
  top_category: string;
  category_spend: { name: string; value: number }[];
  recent_receipts: { id: number; merchant: string; date: string; total_amount: number }[];
}

interface Toast {
  message: string;
  onUndo?: () => void;
  id: number;
}

function App() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const undoTimeoutRef = useRef<any>(null);

  const fetchData = async () => {
    try {
      const response = await fetch('http://localhost:8000/api/dashboard');
      if (!response.ok) throw new Error('Failed to fetch dashboard data');
      const result = await response.json();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    }
  };

  useEffect(() => {
    const startBackend = async () => {
      try {
        const command = Command.sidecar('bin/backend');
        await command.spawn();
        console.log('Backend sidecar started');
      } catch (err) {
        console.error('Failed to start backend sidecar:', err);
      }
    };

    startBackend().then(() => {
      // Wait a bit for backend to initialize
      setTimeout(fetchData, 1000);
    });
  }, []);

  const showToast = (message: string, onUndo?: () => void) => {
    const id = Date.now();
    setToast({ message, onUndo, id });
    if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current);
    undoTimeoutRef.current = setTimeout(() => setToast(null), 5000);
  };

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setError(null);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch('http://localhost:8000/api/upload', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) throw new Error('Failed to upload receipt');
      
      await fetchData();
      setShowUpload(false);
      showToast('Receipt processed successfully');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDelete = async (id: number) => {
    const originalData = data;
    if (!data) return;

    // Optimistic UI update
    setData({
      ...data,
      recent_receipts: data.recent_receipts.filter(r => r.id !== id)
    });

    const performDelete = async () => {
      try {
        const response = await fetch(`http://localhost:8000/api/receipts/${id}`, { method: 'DELETE' });
        if (!response.ok) throw new Error('Delete failed');
        await fetchData();
      } catch (err) {
        setData(originalData); // Rollback
        showToast('Failed to delete receipt');
      }
    };

    showToast('Receipt deleted', () => {
      setData(originalData); // Undo: Restore UI
      if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current);
      setToast(null);
    });

    // Actually delete after 5s if not undone
    undoTimeoutRef.current = setTimeout(performDelete, 5000);
  };

  const handleReset = async () => {
    if (!window.confirm('Are you sure you want to clear all data? This cannot be undone.')) return;
    
    try {
      const response = await fetch('http://localhost:8000/api/reset', { method: 'POST' });
      if (!response.ok) throw new Error('Reset failed');
      await fetchData();
      showToast('All data cleared');
    } catch (err) {
      showToast('Failed to reset data');
    }
  };

  return (
    <div className="app-container">
      <header>
        <h1>Dashboard</h1>
        <div className="action-bar">
          <button className="btn btn-secondary" onClick={handleReset}>Reset</button>
          <button className="btn btn-primary" onClick={() => setShowUpload(!showUpload)}>
            {showUpload ? 'Cancel' : '+ New Receipt'}
          </button>
        </div>
      </header>

      {error && <div className="card" style={{color: '#dc2626', background: '#fee2e2'}}>{error}</div>}

      <div className="dashboard-grid">
        <div className="card">
          <h3>Total Spent</h3>
          <div className="stat-value">€{data?.total_spent.toLocaleString() || '0'}</div>
        </div>
        <div className="card">
          <h3>Top Category</h3>
          <div className="stat-value" style={{fontSize: '20px'}}>{data?.top_category || 'N/A'}</div>
        </div>
        <div className="card">
          <h3>Status</h3>
          <div className="stat-value" style={{fontSize: '20px', color: '#10b981'}}>Active</div>
        </div>
      </div>

      {showUpload && (
        <section className="card" style={{animation: 'slideUp 0.3s ease-out'}}>
          <h3>Upload Receipt</h3>
          <div className="upload-zone" onClick={() => fileInputRef.current?.click()}>
            <input 
              type="file" 
              ref={fileInputRef} 
              onChange={handleUpload} 
              style={{display: 'none'}} 
              accept="image/*"
            />
            {loading ? (
              <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px'}}>
                <div className="loading-spinner"></div>
                <p>Gemini AI is analyzing your receipt...</p>
              </div>
            ) : (
              <>
                <p style={{fontSize: '16px', fontWeight: 500}}>Select a receipt image</p>
                <p style={{fontSize: '13px', color: '#86868b', marginTop: '4px'}}>Supports German & English</p>
              </>
            )}
          </div>
        </section>
      )}

      <section className="card">
        <h3>Transactions</h3>
        <table>
          <thead>
            <tr>
              <th>Merchant</th>
              <th>Date</th>
              <th>Amount</th>
              <th style={{width: '50px'}}></th>
            </tr>
          </thead>
          <tbody>
            {data?.recent_receipts.map((r) => (
              <tr key={r.id}>
                <td>{r.merchant}</td>
                <td>{r.date}</td>
                <td style={{fontWeight: 600}}>€{r.total_amount.toFixed(2)}</td>
                <td>
                  <button className="delete-btn" onClick={() => handleDelete(r.id)}>Delete</button>
                </td>
              </tr>
            ))}
            {data?.recent_receipts.length === 0 && (
              <tr>
                <td colSpan={4} style={{textAlign: 'center', padding: '40px', color: '#86868b'}}>
                  No receipts yet. Click "+ New Receipt" to start.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

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
