# 🚀 Next Steps - Deployment Checklist

## ✅ Completed
- ✅ Backend code structure ready
- ✅ Vercel configuration (`vercel.json`) set up
- ✅ Frontend files updated with backend URL
- ✅ All changes committed and pushed

## 📋 Next Steps

### 1. **Commit & Push Changes** (DONE ✅)
- ✅ Updated `quote.html` and `admin.html` with Vercel backend URL
- ✅ Created backend checklist

### 2. **Set Environment Variables in Vercel** 🔴 IMPORTANT

Go to Vercel Dashboard → Your Project → Settings → Environment Variables

Add these variables:

```
DEEPSEEK_API_KEY=sk-your-deepseek-key-here
ALLOWED_ORIGIN=https://nycrenovationexperts.com,https://www.nycrenovationexperts.com
ADMIN_PASSWORD=your-strong-password-here
NODE_ENV=production
```

**Steps:**
1. Open Vercel Dashboard: https://vercel.com/nikunjan-gcs-projects/nyc-renovation-experts
2. Click **Settings** tab
3. Click **Environment Variables** (left sidebar)
4. Add each variable:
   - Click **Add New**
   - Enter variable name
   - Enter value
   - Select environment: **Production** (and Preview/Development if needed)
   - Click **Save**
5. After adding all variables, Vercel will auto-redeploy

### 3. **Configure DNS for Vercel Domain** 🔴 IMPORTANT

You've already started this with `www.nycrenovationexperts.com`

**For www subdomain (Vercel):**
- ✅ CNAME record already configured in Vercel dashboard
- Add CNAME at your DNS provider:
  - **Type**: CNAME
  - **Name**: `www`
  - **Value**: `21ce34ed06b988d7.vercel-dns-017.com.`

**For root domain (optional - if you want root domain on Vercel):**
- In Vercel: Add domain `nycrenovationexperts.com` (without www)
- Follow DNS instructions in Vercel dashboard

**Current Setup (Recommended):**
- Frontend: GitHub Pages → `nycrenovationexperts.com` (or GitHub Pages URL)
- Backend: Vercel → `www.nycrenovationexperts.com`

### 4. **Deploy to Vercel** (If Not Already Done)

**If project not yet connected:**
1. Go to Vercel Dashboard
2. Click **Add New Project**
3. Import your GitHub repository: `nyc-renovation-experts`
4. Configure:
   - **Framework Preset**: Other
   - **Root Directory**: Leave as is (Vercel will detect files)
   - **Build Command**: Leave empty (static site)
   - **Output Directory**: Leave empty
5. Click **Deploy**

**If already connected:**
- ✅ Vercel auto-deploys on git push
- Check deployment status in Vercel dashboard

### 5. **Test Your Backend** ✅

After deployment and DNS propagation (5-60 minutes):

**Test Health Endpoint:**
```
https://www.nycrenovationexperts.com/health
```

**Expected Response:**
```json
{
  "status": "ok",
  "message": "AI Quote API is running"
}
```

**Test API Endpoint (requires API key):**
```bash
curl -X POST https://www.nycrenovationexperts.com/api/analyze-project \
  -H "Content-Type: application/json" \
  -d '{"description":"test renovation"}'
```

### 6. **Test Frontend Connection**

1. Visit your frontend (GitHub Pages or Vercel)
2. Go to `/quote.html`
3. Try the AI quote wizard
4. Open browser console (F12) to check for errors
5. Verify API calls are going to `www.nycrenovationexperts.com`

### 7. **Test Admin Dashboard**

1. Visit `/admin.html`
2. Login with your `ADMIN_PASSWORD`
3. Check if stats and logs load correctly

## 🎯 Priority Actions (Do These First)

1. ⚠️ **Set Environment Variables** - Critical for backend to work
2. ⚠️ **Wait for DNS Propagation** - After adding CNAME (5-60 minutes)
3. ✅ **Test `/health` endpoint** - Verify backend is working
4. ✅ **Test quote wizard** - Verify frontend-backend connection

## 🐛 Troubleshooting

### Backend returns 404
- Check Vercel deployment logs
- Verify environment variables are set
- Check DNS propagation status

### CORS errors
- Verify `ALLOWED_ORIGIN` includes your frontend domain
- Check browser console for exact error

### API key errors
- Verify `DEEPSEEK_API_KEY` is set in Vercel
- Check Vercel function logs for authentication errors

## 📞 Support

If issues persist:
1. Check Vercel deployment logs
2. Check Vercel function logs
3. Verify environment variables are correctly set
4. Test endpoints directly with curl/Postman

