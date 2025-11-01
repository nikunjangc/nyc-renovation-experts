# 🚂 Railway Setup Guide - Step by Step

## ✅ Pre-Deployment Checklist

Before we start, make sure:
- [x] Backend folder has `package.json` ✅
- [x] Backend folder has `server.js` ✅
- [x] `.env` file exists (for local testing)
- [x] `.gitignore` excludes `.env` ✅

## 🚀 Step-by-Step Railway Setup

### Step 1: Push Code to GitHub

First, make sure your code is on GitHub:

```bash
# Navigate to your project root
cd /Users/nikunjangc/Desktop/apex-1.0.0/nyc-renovation-experts

# Check git status
git status

# If not yet a git repo:
git init
git add .
git commit -m "Add AI quote backend and frontend"

# Create repository on GitHub, then:
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git branch -M main
git push -u origin main
```

**IMPORTANT:** Make sure `.env` is NOT in the commit:
```bash
git status
# You should NOT see backend/.env in the list
```

### Step 2: Create Railway Account

1. Go to **https://railway.app**
2. Click **"Start a New Project"** or **"Login"**
3. Choose **"Login with GitHub"** (recommended - easiest)
   - Authorizes Railway to access your GitHub repos
   - One-click deployment later

### Step 3: Create New Project

1. In Railway dashboard, click **"New Project"**
2. Select **"Deploy from GitHub repo"**
3. You'll see your GitHub repositories
4. Click on your repository
5. Railway will start analyzing your project

### Step 4: Configure Deployment

Railway will auto-detect:
- ✅ It's a Node.js project (sees `package.json`)
- ✅ Root directory (but we need to change this)

**IMPORTANT:** Set the root directory to `backend`:

1. Click on your service
2. Go to **"Settings"** tab
3. Find **"Root Directory"**
4. Change from `/` to `/backend`
5. Click **"Update"**

### Step 5: Add Environment Variables

**This is where your secrets go - NOT in code!**

1. In Railway project, click on your service
2. Go to **"Variables"** tab
3. Click **"New Variable"**
4. Add each variable one by one:

```
Variable Name: DEEPSEEK_API_KEY
Value: sk-8e40edda6c7f48388f75e8df7e74c29e
```

```
Variable Name: ADMIN_PASSWORD
Value: Nycrenovationexperts8o5thave@
```

```
Variable Name: NODE_ENV
Value: production
```

```
Variable Name: ALLOWED_ORIGIN
Value: https://your-frontend-domain.com
```

For now, use a placeholder for ALLOWED_ORIGIN - we'll update it after getting the Railway URL.

### Step 6: Get Your Backend URL

1. After deployment, Railway gives you a URL like:
   ```
   https://your-app-name.up.railway.app
   ```

2. Click on your service → **"Settings"** → **"Domains"**
3. You'll see the Railway-generated domain
4. Copy this URL - you'll need it for your frontend

### Step 7: Update ALLOWED_ORIGIN

1. Go back to **"Variables"**
2. Update `ALLOWED_ORIGIN` with your frontend URL:
   ```
   ALLOWED_ORIGIN = https://your-frontend-domain.com
   ```
   
   OR if testing locally first:
   ```
   ALLOWED_ORIGIN = http://localhost:3000
   ```

### Step 8: Test Your Backend

Once deployed, test the health endpoint:

```bash
curl https://your-app-name.up.railway.app/health
```

Should return:
```json
{"status":"ok","message":"AI Quote API is running"}
```

### Step 9: Update Frontend

Update your frontend to use the Railway backend:

**In `quote.html`, find:**
```html
<script>
  // Update this line:
  window.BACKEND_API_URL = 'https://your-app-name.up.railway.app';
</script>
```

## 🔍 Troubleshooting

### Deployment Fails:

**Error: "Module not found"**
- Make sure `Root Directory` is set to `/backend`
- Check `package.json` has all dependencies

**Error: "Port already in use"**
- Railway auto-assigns PORT - use `process.env.PORT` (already done ✅)

**Backend won't start:**
- Check Railway logs: Service → **"Deployments"** → Click on latest → View logs
- Make sure environment variables are set
- Check `server.js` uses environment variables correctly

### API Not Working:

**CORS Errors:**
- Update `ALLOWED_ORIGIN` in Railway variables
- Make sure it matches your frontend URL exactly

**404 Not Found:**
- Check Railway URL is correct
- Verify the service is running (not crashed)

## 📋 Quick Reference

### Railway Dashboard Locations:

```
Railway Dashboard
├── Projects
│   └── Your Project
│       └── Services
│           └── Your Backend Service
│               ├── Variables (environment variables)
│               ├── Settings (root directory, etc.)
│               ├── Deployments (view logs)
│               └── Metrics (usage stats)
```

### Environment Variables Checklist:

- [ ] `DEEPSEEK_API_KEY` = your actual key
- [ ] `ADMIN_PASSWORD` = your password
- [ ] `NODE_ENV` = production
- [ ] `ALLOWED_ORIGIN` = your frontend URL
- [ ] `PORT` = (Railway auto-assigns, optional)

### Test Commands:

```bash
# Health check
curl https://your-app.railway.app/health

# Test API (after adding auth)
curl -X POST https://your-app.railway.app/api/analyze-project \
  -H "Content-Type: application/json" \
  -d '{"description":"test"}'
```

## 🎉 Success Checklist

After setup, verify:

- [ ] Backend deploys successfully on Railway
- [ ] Health endpoint returns OK: `/health`
- [ ] Environment variables are set correctly
- [ ] Frontend can connect to backend
- [ ] Admin dashboard accessible
- [ ] API calls work from frontend

## 📞 Need Help?

**Railway Support:**
- Docs: https://docs.railway.app
- Discord: https://discord.gg/railway

**Common Issues:**
- Check logs in Railway dashboard
- Verify environment variables
- Make sure root directory is `/backend`

---

**Ready to deploy?** Follow the steps above! 🚀

