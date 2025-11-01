# 🚀 Deployment Guide - Step by Step

## Prerequisites

Before deploying, you need accounts on:
1. **GitHub** (free) - to store your code
2. **Railway/Render/Vercel** (free) - to host your app
3. **DeepSeek** (free tier) - you already have API key

## Option 1: Railway (Recommended - Easiest)

### Step 1: Create Railway Account
1. Go to https://railway.app
2. Click **"Start a New Project"** or **"Login"**
3. Sign up with:
   - GitHub (easiest - connects automatically)
   - OR Email (manual setup)
4. **Free tier includes:** $5 credit/month (enough for small projects)

### Step 2: Create GitHub Repository
If you don't have one yet:

```bash
# In your project directory
git init
git add .
git commit -m "Initial commit - NYC Renovation Experts website"

# Create repo on GitHub, then:
git remote add origin https://github.com/yourusername/your-repo.git
git branch -M main
git push -u origin main
```

### Step 3: Deploy on Railway
1. In Railway dashboard, click **"New Project"**
2. Select **"Deploy from GitHub repo"**
3. Choose your repository
4. Railway automatically detects Node.js and starts building

### Step 4: Add Environment Variables (Secrets)
1. In Railway project, click on your service
2. Go to **"Variables"** tab
3. Click **"New Variable"**
4. Add each of these:
   ```
   DEEPSEEK_API_KEY = sk-8e40edda6c7f48388f75e8df7e74c29e
   ADMIN_PASSWORD = Nycrenovationexperts8o5thave@
   ALLOWED_ORIGIN = https://your-domain.railway.app
   PORT = 3001
   NODE_ENV = production
   ```
5. Railway automatically restarts with new variables

### Step 5: Get Your Backend URL
Railway gives you a URL like:
```
https://your-app-name.up.railway.app
```

Update your frontend `quote.html`:
```javascript
// In quote.html, find the script section and update:
window.BACKEND_API_URL = 'https://your-app-name.up.railway.app';
```

## Option 2: Render (Alternative)

### Step 1: Create Render Account
1. Go to https://render.com
2. Click **"Get Started"**
3. Sign up with GitHub (recommended) or Email

### Step 2: Deploy
1. Click **"New +"** → **"Web Service"**
2. Connect GitHub repository
3. Render auto-detects Node.js
4. Settings:
   - **Name**: nyc-renovation-backend
   - **Start Command**: `npm start`
   - **Environment**: Node

### Step 3: Add Environment Variables
1. Go to **"Environment"** tab
2. Add each variable:
   - `DEEPSEEK_API_KEY`
   - `ADMIN_PASSWORD`
   - `ALLOWED_ORIGIN`
   - `PORT=3001`

### Step 4: Get URL
Render gives you: `https://your-app.onrender.com`

## Option 3: Vercel (For Frontend + Backend)

### Step 1: Create Vercel Account
1. Go to https://vercel.com
2. Sign up with GitHub

### Step 2: Deploy
1. Click **"New Project"**
2. Import GitHub repository
3. Vercel auto-detects and deploys

### Step 3: Add Environment Variables
1. Project Settings → **Environment Variables**
2. Add all your secrets

## 📋 Complete Checklist

Before deploying:

### ✅ Code Ready:
- [ ] Code pushed to GitHub
- [ ] `.env` file is NOT in repository (check with `git status`)
- [ ] `env-template.txt` is in repository (safe template)
- [ ] `.gitignore` includes `.env` and `logs/`

### ✅ Accounts Created:
- [ ] GitHub account (if using GitHub hosting)
- [ ] Railway/Render/Vercel account
- [ ] DeepSeek account (you have this)

### ✅ Environment Variables Setup:
In your hosting platform, add:
- [ ] `DEEPSEEK_API_KEY` = your actual key
- [ ] `ADMIN_PASSWORD` = your password
- [ ] `ALLOWED_ORIGIN` = your frontend URL
- [ ] `PORT` = 3001 (or let platform assign)
- [ ] `NODE_ENV` = production

### ✅ Testing:
- [ ] Backend health check works: `https://your-backend.railway.app/health`
- [ ] Frontend connects to backend
- [ ] Admin dashboard accessible
- [ ] API calls working

## 🔒 Security Reminders

**IMPORTANT:**
1. ✅ Never commit `.env` to Git (already protected)
2. ✅ Never share API keys in screenshots/emails
3. ✅ Use platform's environment variables (not code)
4. ✅ Rotate keys if accidentally exposed

## 🆓 Free Tier Limits

### Railway:
- $5 credit/month
- ~500 hours runtime (free tier)
- Auto-sleeps after inactivity
- Environment variables: Unlimited

### Render:
- Free tier: Auto-sleeps after 15 min inactivity
- Wakes up on first request (slow first load)
- Environment variables: Unlimited

### Vercel:
- Unlimited deployments
- Free tier has bandwidth limits
- Environment variables: Unlimited

## 🎯 Quick Start (Railway)

```bash
# 1. Push to GitHub
git add .
git commit -m "Ready for deployment"
git push origin main

# 2. Go to railway.app
# 3. New Project → Deploy from GitHub
# 4. Select your repo
# 5. Add environment variables in dashboard
# 6. Done! Get your URL
```

## 🔍 Verify Deployment

After deploying, test:

1. **Health Check:**
   ```bash
   curl https://your-app.railway.app/health
   ```
   Should return: `{"status":"ok","message":"AI Quote API is running"}`

2. **Frontend Connection:**
   - Update `BACKEND_API_URL` in `quote.html`
   - Test the quote wizard
   - Should connect to backend

3. **Admin Dashboard:**
   - Open `admin.html`
   - Update backend URL in script
   - Login and view stats

## 🆘 Troubleshooting

### Backend won't start:
- Check environment variables are set correctly
- Check logs in Railway dashboard
- Verify Node.js version (use 18+)

### Frontend can't connect:
- Verify `BACKEND_API_URL` is correct
- Check CORS settings in backend
- Verify `ALLOWED_ORIGIN` includes your frontend URL

### Environment variables not working:
- Make sure variables are added in platform dashboard
- Restart the service after adding variables
- Check variable names match exactly (case-sensitive)

## 💡 Pro Tips

1. **Railway is easiest** - Best for beginners, great docs
2. **Start with free tier** - Upgrade only if needed
3. **Use GitHub integration** - Auto-deploys on push
4. **Monitor usage** - Check your admin dashboard regularly
5. **Backup your `.env`** - Keep a secure copy (password manager)

## 📞 Need Help?

- Railway Docs: https://docs.railway.app
- Render Docs: https://render.com/docs
- Vercel Docs: https://vercel.com/docs

---

**TL;DR:**
1. Create GitHub account (if needed)
2. Create Railway account
3. Push code to GitHub
4. Deploy from Railway dashboard
5. Add environment variables in Railway
6. Done! 🎉

