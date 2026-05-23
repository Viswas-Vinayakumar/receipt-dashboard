# Receipt Dashboard v1.0.0

An autonomous, AI-powered receipt processing and expense management desktop application.

## 🚀 Overview
Receipt Dashboard is a high-performance desktop app that automates expense tracking. Simply upload an image of a receipt (German or English), and the system uses **Gemini 1.5 Pro** to extract structured data, categorize items, and update a real-time financial dashboard.

## ✨ Features
*   **Multimodal AI Extraction:** Leverages Gemini 1.5 Pro to read complex receipt layouts in multiple languages.
*   **Native Desktop Experience:** Built with **Tauri** and **React** for a lightweight, professional macOS experience.
*   **Autonomous Backend:** Features a **FastAPI** sidecar that handles AI processing and SQLite data management.
*   **Advanced UI/UX:** Modern Apple-style aesthetic with optimistic UI updates, "Undo" functionality, and real-time toast notifications.
*   **Automated Categorization:** Smart mapping of items to categories (Groceries, Dining, Transport, etc.).

## 🛠 Tech Stack
*   **Frontend:** React, TypeScript, Vite, Tauri v2
*   **Backend:** Python 3, FastAPI, SQLAlchemy, PyInstaller (Sidecar)
*   **AI:** Google Gemini 1.5 Pro (Generative AI SDK)
*   **Database:** SQLite

## 📦 Installation & Setup
1. **Clone the repository:**
   ```bash
   git clone <your-repo-url>
   cd receipt-dashboard
   ```
2. **Setup Backend:**
   ```bash
   cd backend
   python3 -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   ```
3. **Configure API Key:**
   Create a `.env` file in the `backend/` directory:
   ```env
   GEMINI_API_KEY=your_api_key_here
   ```
4. **Run Development Mode:**
   ```bash
   ./run.sh
   ```

## 🖼 Screenshots
*(Place screenshots here for your CV/Portfolio)*

## 📄 License
MIT License
