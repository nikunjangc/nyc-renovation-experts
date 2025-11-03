# Architecture Overview

## 🏗️ Deployment Strategy

### **Frontend: GitHub Pages** (Static HTML Files)
Most pages are **static** and work perfectly on GitHub Pages:

- ✅ `index.html` - Homepage
- ✅ `about.html` - About page
- ✅ `service.html` - Services page
- ✅ `contact.html` - Contact page
- ✅ `team.html` - Team page
- ✅ `testimonial.html` - Testimonials
- ✅ `feature.html` - Features
- ✅ `appointment.html` - Appointment
- ✅ `404.html` - Error page

**Why GitHub Pages?**
- Free hosting
- Automatic deployments from git
- Fast static file serving
- No backend needed for these pages

---

### **Backend: Vercel** (Serverless Functions)
Only **2 pages need backend integration**:

#### 1. **Quote Page** (`quote.html`)
- **Frontend**: Served from GitHub Pages
- **Backend**: API calls go to Vercel
- **Configuration**: 
  ```javascript
  window.BACKEND_API_URL = 'https://www.nycrenovationexperts.com';
  ```
- **API Calls**: 
  - `/api/analyze-project` - AI project analysis
  - `/api/estimate-cost` - AI cost estimation

#### 2. **Admin Page** (`admin.html`)
- **Frontend**: Served from GitHub Pages
- **Backend**: API calls go to Vercel
- **Configuration**:
  ```javascript
  const BACKEND_API_URL = 'https://www.nycrenovationexperts.com';
  ```
- **API Calls**:
  - `/admin/stats` - Usage statistics
  - `/admin/logs` - API usage logs
  - `/admin/clear-logs` - Clear logs

**Why Vercel for Backend?**
- GitHub Pages **cannot run serverless functions**
- Vercel supports serverless functions (Express app)
- Free tier available
- Automatic deployments

---

## 🔄 How It Works

```
┌─────────────────┐         ┌──────────────────┐
│  GitHub Pages   │         │     Vercel       │
│  (Frontend)     │         │    (Backend)    │
├─────────────────┤         ├──────────────────┤
│                 │         │                  │
│  index.html ✅  │         │  /api/index.js   │
│  about.html ✅  │         │  (Express app)   │
│  service.html ✅│         │                  │
│  contact.html ✅│         │  Endpoints:      │
│  ...            │         │  • /health       │
│                 │         │  • /api/analyze  │
│  quote.html ⚠️  │────────▶│  • /api/estimate│
│  (calls API)    │  HTTPS  │  • /admin/*      │
│                 │         │                  │
│  admin.html ⚠️  │────────▶│                  │
│  (calls API)    │  HTTPS  │                  │
└─────────────────┘         └──────────────────┘
```

---

## 📋 Current Configuration

### **Frontend Files** (GitHub Pages)
- All HTML files served from GitHub Pages
- `quote.html` and `admin.html` contain JavaScript that calls Vercel API

### **Backend Files** (Vercel)
- `/api/index.js` - Express app with all API endpoints
- `/api/package.json` - Backend dependencies
- `/vercel.json` - Vercel routing configuration

### **API Endpoints** (Vercel)
- `GET /health` - Health check
- `POST /api/analyze-project` - AI project analysis
- `POST /api/estimate-cost` - AI cost estimation
- `GET /admin/stats` - Admin statistics
- `GET /admin/logs` - Admin logs
- `POST /admin/clear-logs` - Clear logs

---

## 🎯 Summary

**Simple Rule:**
- **Static pages** → GitHub Pages ✅
- **Pages needing API** → GitHub Pages (frontend) + Vercel (backend) ⚠️

**Why This Works:**
1. Most pages don't need backend → GitHub Pages is perfect
2. Quote/Admin need AI API → Vercel provides serverless backend
3. Frontend makes fetch() calls to Vercel URL → Cross-origin requests work with CORS

**Result:**
- ✅ Free hosting for static files (GitHub Pages)
- ✅ Free backend API (Vercel)
- ✅ Best of both worlds!

