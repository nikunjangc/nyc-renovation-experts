# 🔒 Secure Backend API for AI Quote Assistant

This backend server keeps your OpenAI API key **completely safe** and never exposes it to the frontend.

## ⚡ Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
```bash
cp .env.example .env
```

Edit `.env` and add your OpenAI API key:
```env
OPENAI_API_KEY=sk-your-actual-api-key-here
ALLOWED_ORIGIN=http://localhost:3000
PORT=3001
```

### 3. Start Server
```bash
npm start
```

For development with auto-reload:
```bash
npm run dev
```

## 📋 API Endpoints

### Health Check
```bash
GET /health
```

### Analyze Project
```bash
POST /api/analyze-project
Content-Type: application/json

{
  "projectType": "kitchen",
  "borough": "manhattan",
  "squareFootage": "500",
  "budgetRange": "25k-50k",
  "description": "I want a luxury kitchen renovation..."
}
```

### Estimate Cost
```bash
POST /api/estimate-cost
Content-Type: application/json

{
  "projectType": "kitchen",
  "borough": "manhattan",
  "squareFootage": "500",
  "budgetRange": "25k-50k",
  "timeline": "3-6months",
  "description": "I want a luxury kitchen renovation...",
  "baseEstimate": { "min": 25000, "max": 40000 }
}
```

## 🔐 Security Features

- ✅ API key stored server-side only (never in frontend)
- ✅ Rate limiting (5 requests/minute per IP)
- ✅ CORS protection (only your domain)
- ✅ Input validation
- ✅ Error handling (no key leakage)

## 🌐 Deployment

See `SECURITY-SETUP.md` in the root directory for full deployment instructions.

### Quick Deploy Options:

**Heroku:**
```bash
heroku create
heroku config:set OPENAI_API_KEY=sk-your-key
heroku config:set ALLOWED_ORIGIN=https://yourdomain.com
git push heroku main
```

**Railway/Render:**
- Connect GitHub repo
- Add environment variables
- Deploy!

## ✅ Testing

Test the server is running:
```bash
curl http://localhost:3001/health
```

## 📝 Notes

- Never commit `.env` file (it's in `.gitignore`)
- Always use HTTPS in production
- Monitor your OpenAI usage regularly

