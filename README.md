# Rezet

**AI-powered receipt scanner and expense dashboard for macOS.**

Snap a photo of any receipt (German or English), and Rezet extracts the merchant, date, items, and totals — all locally, no cloud, no API key.

---

## Download

**[⬇ Download Rezet for macOS (Apple Silicon)](https://github.com/Viswas-Vinayakumar/receipt-dashboard/releases/latest)**

> Requires macOS 12+ on Apple Silicon (M1/M2/M3/M4)

---

## Setup (3 steps, ~5 min)

### 1. Install Ollama
```bash
brew install ollama
```
Or download directly from [ollama.com](https://ollama.com)

### 2. Pull the AI model
```bash
ollama pull gemma4:e4b
```
This downloads ~10 GB once. Ollama runs silently in the background after that.

### 3. Open Rezet
- Download the `.dmg` from the [Releases page](https://github.com/Viswas-Vinayakumar/receipt-dashboard/releases/latest)
- Open it and drag **Rezet** to Applications
- Launch Rezet — the ENGINE indicator turns **green** when ready

That's it. No account, no API key, no internet required after setup.

---

## Features

| Feature | Details |
|---|---|
| 📷 **AI Receipt Scan** | Drag-and-drop a photo — merchant, date, items and total extracted automatically |
| ✏️ **Manual Entry** | Add receipts by hand with a clean form |
| 📊 **Spending Dashboard** | Category bar chart + monthly trend line |
| 🔍 **Search & Filter** | Filter by merchant name or category, sort 5 ways |
| 📥 **Export CSV** | One click exports all transactions |
| ↩️ **Undo Delete** | Accidental delete? Undo toast restores it |
| 🔒 **Fully Local** | AI runs on your Mac via Ollama — nothing leaves your machine |

---

## How It Works

```
Receipt photo → Rezet sidecar (FastAPI) → Ollama gemma4:e4b (local) → SQLite → Dashboard
```

The app bundles a Python sidecar that starts automatically. It sends receipt images to your local Ollama instance and stores results in a SQLite database at `~/receipt-dashboard/app_data/`.

---

## Tech Stack

- **Frontend:** React + TypeScript + Vite
- **Desktop shell:** Tauri v2
- **Backend sidecar:** FastAPI + SQLAlchemy (bundled via PyInstaller)
- **AI:** Ollama `gemma4:e4b` (local vision model)
- **Database:** SQLite

---

## Build From Source

<details>
<summary>Click to expand</summary>

**Prerequisites:** Node 18+, Rust, Python 3.11+, Ollama

```bash
git clone https://github.com/Viswas-Vinayakumar/receipt-dashboard.git
cd receipt-dashboard

# Build the Python sidecar
cd backend
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
pyinstaller main.spec --noconfirm
cp dist/main ../frontend/src-tauri/backend-aarch64-apple-darwin

# Build the Tauri app
cd ../frontend
npm install
npm run tauri build
```

The `.dmg` will be at `frontend/src-tauri/target/release/bundle/dmg/`.

</details>

---

## License

MIT
