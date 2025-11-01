# ⚡ Vercel Deployment Guide (FREE!)

## ✅ Why Vercel?

- ✅ **Completely FREE** for hobby projects
- ✅ **Unlimited deployments**
- ✅ **Automatic HTTPS**
- ✅ **Free custom domain**
- ✅ **Great for frontend + backend**
- ✅ **Fast global CDN**

## 🚀 Quick Setup (5 Minutes)

### Step 1: Push Code to GitHub

Make sure your code is on GitHub:

```bash
cd /Users/nikunjangc/Desktop/apex-1.0.0/nyc-renovation-experts

# If not already pushed:
git add .
git commit -m "Ready for Vercel deployment"
git push origin main
```

### Step 2: Go to Vercel

1. **Open https://vercel.com/new**
2. Click **"Sign Up"** or **"Login"**
3. Choose **"Continue with GitHub"** (easiest)
4. Authorize Vercel to access your repositories

### Step 3: Import Your Repository

1. On Vercel dashboard, click **"Add New..."** → **"Project"**
2. You'll see **"Import Git Repository"**
3. Find and select your repository
4. Click **"Import"**

### Step 4: Configure Project Settings

Vercel will auto-detect your setup. Configure:

**Project Settings:**
- **Project Name:** nyc-renovation-experts (or your choice)
- **Framework Preset:** Other (or leave auto-detected)
- **Root Directory:** `./` (root of repo)

**Build Settings:**
- **Build Command:** Leave empty (or `npm install` if needed)
- **Output Directory:** Leave empty (for frontend) OR set to `./` 
- **Install Command:** Leave empty

**Advanced Settings:**
- Click **"Environment Variables"**
- Add these variables:

```
DEEPSEEK_API_KEY = sk-8e40edda6c7f48388f75e8df7e74c29e
ADMIN_PASSWORD = Nycrenovationexperts8o5thave@
ALLOWED_ORIGIN = https://your-project.vercel.app
NODE_ENV = production
```

**Note:** Update `ALLOWED_ORIGIN` after first deployment with your actual Vercel URL.

### Step 5: Deploy!

1. Click **"Deploy"**
2. Vercel will:
   - Install dependencies
   - Build your project
   - Deploy to global CDN
3. Wait ~1-2 minutes
4. You'll get a URL like: `https://your-project.vercel.app`

### Step 6: Update Environment Variables

After first deployment:

1. Go to **Project Settings** → **Environment Variables**
2. Update `ALLOWED_ORIGIN` with your actual Vercel URL:
   ```
   ALLOWED_ORIGIN = https://your-project.vercel.app
   ```
3. Redeploy (happens automatically on git push, or trigger manually)

### Step 7: Test Your Backend

Test the health endpoint:
```
https://your-project.vercel.app/health
```

Should return:
```json
{"status":"ok","message":"AI Quote API is running"}
```

### Step 8: Update Frontend

In `quote.html`, update the backend URL:

```html
<script>
  window.BACKEND_API_URL = 'https://your-project.vercel.app';
</script>
```

## 📁 Project Structure for Vercel

Vercel works best with this structure:

```
nyc-renovation-experts/
├── vercel.json          ← Vercel config (created)
├── backend/
│   ├── server.js        ← Express server (Vercel-compatible)
│   ├── vercel.json      ← Backend config
│   └── ...
├── index.html           ← Frontend
├── quote.html           ← Frontend
└── ...
```

## ⚙️ How Vercel Works with Express

Vercel converts your Express app into **serverless functions**:
- ✅ Your API routes work automatically
- ✅ `/api/*` routes → handled by Express
- ✅ Frontend files → served as static files
- ✅ Automatic scaling

## 🔧 Configuration Files

### `vercel.json` (Root)
Routes requests to your Express backend.

### `backend/vercel.json`
Configures the serverless function runtime.

## 🆓 Vercel Free Tier Includes:

- ✅ Unlimited deployments
- ✅ 100GB bandwidth/month
- ✅ Serverless function execution
- ✅ Automatic HTTPS
- ✅ Custom domain support
- ✅ Git integration (auto-deploy on push)

**Limits:**
- Functions: 10 second timeout (upgrade for longer)
- **This is fine for your API calls!**

## 🎯 Deployment Checklist

Before deploying:

- [ ] Code pushed to GitHub
- [ ] `.env` is NOT in repository (checked with `git status`)
- [ ] `vercel.json` exists in root
- [ ] `backend/vercel.json` exists
- [ ] Environment variables ready to add

After deploying:

- [ ] Backend URL obtained: `https://your-project.vercel.app`
- [ ] Health check works: `/health`
- [ ] Environment variables added in Vercel dashboard
- [ ] Frontend updated with backend URL
- [ ] API calls working

## 🔍 Testing

### Test Backend:
```bash
curl https://your-project.vercel.app/health
```

### Test API:
```bash
curl -X POST https://your-project.vercel.app/api/analyze-project \
  -H "Content-Type: application/json" \
  -d '{"description":"test project"}'
```

### Test Frontend:
1. Open `https://your-project.vercel.app/quote.html`
2. Try the quote wizard
3. Check browser console for errors

## 🐛 Troubleshooting

### "Function timeout"
- Vercel free tier: 10 second limit
- Your API calls should finish faster
- If not, check DeepSeek API response time

### "Module not found"
- Make sure all dependencies are in `backend/package.json`
- Vercel auto-runs `npm install`

### "404 Not Found" for API routes
- Check `vercel.json` routes are correct
- Make sure routes match your Express routes

### CORS Errors
- Update `ALLOWED_ORIGIN` in Vercel environment variables
- Make sure it matches your frontend URL exactly

### View Logs:
1. Vercel dashboard → Your project
2. Click **"Deployments"**
3. Click on a deployment
4. View **"Function Logs"**

## 📊 Vercel Dashboard Features

- **Deployments:** See all deployments
- **Settings:** Environment variables, domains
- **Analytics:** Usage stats (on Pro plan)
- **Logs:** Real-time function logs
- **Domains:** Add custom domain

## 🔒 Security Reminders

1. ✅ Never commit `.env` (already protected)
2. ✅ Add secrets in Vercel dashboard (not code)
3. ✅ Use HTTPS (automatic on Vercel)
4. ✅ Update `ALLOWED_ORIGIN` correctly

## 🎉 Success!

Once deployed:
- ✅ Frontend: `https://your-project.vercel.app`
- ✅ Backend API: `https://your-project.vercel.app/api/...`
- ✅ Admin: `https://your-project.vercel.app/admin.html`

Everything works on one domain! 🚀

## 📝 Next Steps

1. Add custom domain (optional, free)
2. Set up auto-deploy on git push (automatic)
3. Monitor usage in Vercel dashboard
4. Check admin dashboard for API stats

---

**Vercel Docs:** https://vercel.com/docs  
**Support:** https://vercel.com/support

