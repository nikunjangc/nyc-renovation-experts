# 🚀 Quick Start: Deploy to Railway (5 Minutes)

## ✅ Pre-Flight Check

Before starting, verify:
```bash
# Check .env is ignored
git check-ignore backend/.env
# Should output: backend/.env

# Check git status
git status
# Should NOT show backend/.env
```

## 📋 Step-by-Step

### 1. Push to GitHub (If Not Already)

```bash
cd /Users/nikunjangc/Desktop/apex-1.0.0/nyc-renovation-experts

# Check if already pushed
git remote -v

# If no remote, add one:
# git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
# git push -u origin main
```

### 2. Go to Railway

1. Open **https://railway.app**
2. Click **"Start a New Project"**
3. Choose **"Login with GitHub"**
4. Authorize Railway access

### 3. Deploy from GitHub

1. Click **"New Project"**
2. Select **"Deploy from GitHub repo"**
3. Find and select your repository
4. Railway will start deploying

### 4. Configure Settings

**IMPORTANT:** Set Root Directory:

1. Click on the service that was created
2. Go to **"Settings"** tab
3. Find **"Root Directory"**
4. Change from `/` to **`/backend`**
5. Click **"Update"**
6. Railway will redeploy

### 5. Add Environment Variables

In the same service:

1. Click **"Variables"** tab
2. Click **"New Variable"**
3. Add these one by one:

```
DEEPSEEK_API_KEY = sk-8e40edda6c7f48388f75e8df7e74c29e
ADMIN_PASSWORD = Nycrenovationexperts8o5thave@
NODE_ENV = production
ALLOWED_ORIGIN = http://localhost:3000
```

(Update ALLOWED_ORIGIN later with your frontend URL)

### 6. Get Your Backend URL

1. Click **"Settings"** tab
2. Find **"Domains"** section
3. Copy the Railway-generated URL:
   ```
   https://your-app-name.up.railway.app
   ```

### 7. Test It

Open in browser:
```
https://your-app-name.up.railway.app/health
```

Should see:
```json
{"status":"ok","message":"AI Quote API is running"}
```

### 8. Update Frontend

In `quote.html`, find:
```html
<script>
  // Change this:
  window.BACKEND_API_URL = 'https://your-app-name.up.railway.app';
</script>
```

## 🎯 That's It!

Your backend is now live! 🎉

## 🔍 If Something Goes Wrong

### Check Logs:
1. Railway dashboard → Your service
2. Click **"Deployments"** tab
3. Click on latest deployment
4. View logs to see errors

### Common Issues:

**"Module not found"**
- Make sure Root Directory = `/backend`

**"Port error"**
- Railway auto-assigns PORT - your code already handles this ✅

**"CORS error"**
- Update `ALLOWED_ORIGIN` to match your frontend URL exactly

## 📞 Next Steps

1. ✅ Backend deployed
2. 📝 Update frontend with Railway URL
3. 🧪 Test the quote wizard
4. 📊 Test admin dashboard

---

**Need detailed guide?** See `backend/RAILWAY-SETUP.md`

