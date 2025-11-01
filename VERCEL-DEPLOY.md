# ⚡ Deploy to Vercel - Simple Guide

## ✅ Quick Steps (5 Minutes)

### Step 1: Go to Vercel
Open: **https://vercel.com/new**

### Step 2: Sign In
Click **"Continue with GitHub"** (recommended - connects automatically)

### Step 3: Import Repository
1. Click **"Import Git Repository"**
2. Find: `nikunjangc/nyc-renovation-experts`
3. Click **"Import"**

### Step 4: Configure Project

**Vercel will auto-detect most settings. Just verify:**

- **Project Name:** nyc-renovation-experts (or your choice)
- **Framework Preset:** Other (or leave default)
- **Root Directory:** `./` (leave as is)
- **Build Command:** (leave empty)
- **Output Directory:** (leave empty)

### Step 5: Add Environment Variables

**BEFORE clicking Deploy**, click **"Environment Variables"** and add:

```
Name: DEEPSEEK_API_KEY
Value: [Your new rotated API key here]
```

```
Name: ADMIN_PASSWORD
Value: [Your admin password]
```

```
Name: NODE_ENV
Value: production
```

```
Name: ALLOWED_ORIGIN
Value: https://your-project.vercel.app
```
*(Update this after first deployment with your actual Vercel URL)*

### Step 6: Deploy!

1. Click **"Deploy"**
2. Wait 1-2 minutes
3. Get your URL: `https://your-project.vercel.app`

### Step 7: Update ALLOWED_ORIGIN

After deployment:
1. Go to **Project Settings** → **Environment Variables**
2. Update `ALLOWED_ORIGIN` with your actual URL:
   ```
   ALLOWED_ORIGIN = https://your-project.vercel.app
   ```
3. Redeploy (or it auto-updates on next git push)

### Step 8: Test

Open: `https://your-project.vercel.app/health`

Should see: `{"status":"ok","message":"AI Quote API is running"}`

### Step 9: Update Frontend

In `quote.html` and `admin.html`, update:

```javascript
window.BACKEND_API_URL = 'https://your-project.vercel.app';
```

## 🎉 Done!

Your site is live:
- **Frontend:** `https://your-project.vercel.app`
- **Backend API:** `https://your-project.vercel.app/api/...`
- **Admin:** `https://your-project.vercel.app/admin.html`

## 🔍 Troubleshooting

### Backend not working?
- Check Vercel logs: Project → Deployments → Click deployment → Logs
- Verify environment variables are set
- Check `/health` endpoint first

### CORS errors?
- Make sure `ALLOWED_ORIGIN` matches your frontend URL exactly

### Need help?
- Vercel Docs: https://vercel.com/docs
- Check deployment logs in Vercel dashboard

---

**That's it! Simple and free! 🚀**

