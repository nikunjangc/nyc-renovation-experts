# 🔍 Testing Backend on Vercel

## Issue: 404 Error on Health Endpoint

If you're getting a 404 error page, it means:
- ❌ Request is going to GitHub Pages (which shows 404.html)
- ❌ OR Vercel isn't deployed/configured correctly
- ❌ OR Domain isn't pointing to Vercel

## ✅ How to Test Backend

### Option 1: Test Direct Vercel URL

**Don't use your custom domain** - Use the Vercel deployment URL directly:

1. **Find your Vercel deployment URL:**
   - Go to Vercel Dashboard: https://vercel.com/nikunjan-gcs-projects/nyc-renovation-experts
   - Look for your deployment URL (format: `https://nyc-renovation-experts-xxxx.vercel.app`)

2. **Test the health endpoint:**
   ```
   https://your-vercel-url.vercel.app/health
   ```
   OR
   ```
   https://your-vercel-url.vercel.app/api/health
   ```

3. **Expected response:**
   ```json
   {
     "status": "ok",
     "message": "AI Quote API is running"
   }
   ```

### Option 2: Test with curl (command line)

```bash
curl https://your-vercel-url.vercel.app/health
```

### Option 3: Test in Browser

1. Open browser
2. Go to: `https://your-vercel-url.vercel.app/health`
3. Should see JSON response, NOT an HTML page

## ⚠️ Common Issues

### Issue 1: Domain Points to GitHub Pages

**Symptom:** Getting HTML 404 page instead of JSON

**Solution:** 
- Use Vercel URL directly (not custom domain)
- OR: Point custom domain to Vercel (not GitHub Pages)

### Issue 2: Backend Not Deployed

**Symptom:** 404 on Vercel URL too

**Check:**
1. Vercel Dashboard → Deployments
2. Is deployment successful?
3. Are there any build errors?
4. Check Function Logs in Vercel

### Issue 3: Environment Variables Missing

**Symptom:** Backend returns 500 error (not 404)

**Check:**
1. Vercel Dashboard → Settings → Environment Variables
2. Set: `DEEPSEEK_API_KEY`, `ALLOWED_ORIGIN`, `ADMIN_PASSWORD`

## 📋 Step-by-Step Testing

1. **Get Vercel URL from dashboard**
2. **Test `/health` endpoint** - Should return JSON
3. **If JSON works** → Backend is working! Issue is DNS/routing
4. **If 404** → Check Vercel deployment status
5. **If 500** → Check environment variables

## 🎯 Quick Test

**Replace `your-vercel-url` with actual Vercel URL:**

```
https://your-vercel-url.vercel.app/health
```

**If this works** → Backend is fine! Just need to fix domain/DNS.

