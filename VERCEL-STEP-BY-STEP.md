# 🚀 Vercel Deployment - Detailed Step-by-Step Guide

## ✅ You're Already Logged In!

Since you're logged into Vercel with your GitHub account, let's continue!

---

## Step 1: Create New Project

### What You'll See:
- Vercel dashboard with your projects (if any)
- A button or link that says **"Add New..."** or **"New Project"** or **"Create"**

### What To Do:
1. Click **"Add New..."** (usually top right, or a big button)
2. Select **"Project"** from the dropdown menu
3. You'll see: **"Import Git Repository"**

---

## Step 2: Import Your GitHub Repository

### What You'll See:
- A list of your GitHub repositories
- Search bar to find repositories
- Each repo shows: Name, Description, Last updated

### What To Do:
1. **Look for:** `nikunjangc/nyc-renovation-experts`
   - Or type "nyc-renovation" in the search bar to find it
2. **Click on the repository name** or the **"Import"** button next to it
3. You'll be taken to the **"Configure Project"** page

---

## Step 3: Configure Project Settings

### What You'll See:
A page with several sections:
- **Project Name** (at the top)
- **Framework Preset** (dropdown)
- **Root Directory** (input field)
- **Build and Output Settings** (collapsed by default)
- **Environment Variables** (collapsed by default)

### What To Do:

#### A. Project Name
- **Default:** `nyc-renovation-experts`
- **Action:** Leave it as is, or change if you want
- **Example:** `nyc-renovation-experts` or `nyc-reno-website`

#### B. Framework Preset
- **What You'll See:** Dropdown with options like "Next.js", "Vite", "Other", etc.
- **Action:** Select **"Other"** or leave on "Auto" (Vercel will detect it)
- **Why:** Your project doesn't use a specific framework preset

#### C. Root Directory
- **What You'll See:** Input field (usually empty or shows `./`)
- **Action:** Leave it as `./` (this means root of repository)
- **Don't change this** - your project structure expects root directory

#### D. Build Settings (Click to expand if needed)
- **Build Command:** Leave **EMPTY** (no build needed)
- **Output Directory:** Leave **EMPTY** (frontend files are in root)
- **Install Command:** Leave **EMPTY** (auto-detected)

---

## Step 4: Add Environment Variables (CRITICAL!)

### What You'll See:
- Section called **"Environment Variables"**
- Button: **"Add"** or **"Add Variable"** or **"New Variable"**
- Or it might be collapsed - click to expand it

### What To Do:

**Before clicking "Deploy", add these 4 environment variables:**

#### Variable 1: DEEPSEEK_API_KEY
1. Click **"Add"** or **"New Variable"**
2. **Key/Name field:** Type exactly: `DEEPSEEK_API_KEY`
3. **Value field:** Enter your **NEW rotated API key** from DeepSeek
   - ⚠️ **IMPORTANT:** Use your NEW key (after rotating the exposed one)
   - Format: `sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
4. **Environment:** Select **Production** (or all environments)
5. Click **"Save"** or **"Add"**

#### Variable 2: ADMIN_PASSWORD
1. Click **"Add"** again
2. **Key/Name:** `ADMIN_PASSWORD`
3. **Value:** Your admin dashboard password
   - Example: `Nycrenovationexperts8o5thave@` (or your new one)
4. **Environment:** Select **Production**
5. Click **"Save"**

#### Variable 3: NODE_ENV
1. Click **"Add"** again
2. **Key/Name:** `NODE_ENV`
3. **Value:** `production`
4. **Environment:** Select **Production**
5. Click **"Save"**

#### Variable 4: ALLOWED_ORIGIN
1. Click **"Add"** again
2. **Key/Name:** `ALLOWED_ORIGIN`
3. **Value:** For now, use: `https://your-project-name.vercel.app`
   - ⚠️ **Note:** Replace `your-project-name` with what you see in the URL preview
   - Or wait until after deployment to update this
4. **Environment:** Select **Production**
5. Click **"Save"**

### How It Looks:
You should see a list like:
```
DEEPSEEK_API_KEY = sk-... (hidden)
ADMIN_PASSWORD = ******** (hidden)
NODE_ENV = production
ALLOWED_ORIGIN = https://your-project.vercel.app
```

---

## Step 5: Deploy!

### What You'll See:
- Bottom of the page: **"Deploy"** button (usually blue/green)
- Might say "Deploy Project" or just "Deploy"

### What To Do:
1. **Review** your settings one more time
2. **Click "Deploy"**
3. **Wait** - You'll see a loading/deployment screen

### What Happens:
- Vercel starts building your project
- You'll see logs scrolling:
  - "Installing dependencies..."
  - "Building..."
  - "Deploying..."
- This takes **1-3 minutes**

---

## Step 6: Deployment Success!

### What You'll See:
- ✅ Success message
- Your project URL: `https://your-project-name.vercel.app`
- Link to view your site
- Dashboard with deployment details

### What To Do:
1. **Copy your URL** (you'll need it!)
   - Example: `https://nyc-renovation-experts.vercel.app`
2. **Click "Visit"** or open the URL to see your site

---

## Step 7: Update ALLOWED_ORIGIN

### What To Do:
1. In Vercel dashboard, click on your **project name**
2. Go to **"Settings"** tab (top navigation)
3. Click **"Environment Variables"** (left sidebar)
4. Find `ALLOWED_ORIGIN`
5. Click **"Edit"** (or three dots → Edit)
6. Update the value to your **actual Vercel URL**:
   ```
   https://your-actual-project-name.vercel.app
   ```
7. Click **"Save"**
8. Vercel will automatically redeploy

---

## Step 8: Test Your Backend

### Test Health Endpoint:
Open in browser:
```
https://your-project-name.vercel.app/health
```

### Expected Result:
```json
{"status":"ok","message":"AI Quote API is running"}
```

### If You See This:
✅ **Success!** Your backend is working!

### If You See Error:
- Check Vercel logs (see Step 9)
- Verify environment variables are set correctly

---

## Step 9: Check Logs (If Issues)

### How to View Logs:
1. In Vercel dashboard → Your project
2. Click **"Deployments"** tab
3. Click on the **latest deployment** (top of list)
4. You'll see:
   - **Build Logs** - Installation and build process
   - **Function Logs** - Runtime logs from your server

### What to Look For:
- ✅ "Build completed successfully"
- ✅ "Function ready"
- ❌ Any red error messages

---

## Step 10: Update Frontend Files

### Update Backend URL in Frontend:

#### In `quote.html`:
1. Find this section (near the end, before `</body>`):
```html
<script>
  // Update this to your production backend URL when deploying
  // window.BACKEND_API_URL = 'https://your-backend-domain.com';
</script>
```

2. **Uncomment and update:**
```html
<script>
  window.BACKEND_API_URL = 'https://your-project-name.vercel.app';
</script>
```

#### In `admin.html`:
1. Find similar script section
2. Update:
```javascript
const BACKEND_API_URL = 'https://your-project-name.vercel.app';
```

### Commit and Push:
```bash
git add quote.html admin.html
git commit -m "Update backend URL for Vercel deployment"
git push origin gh-pages
```

Vercel will auto-redeploy!

---

## Step 11: Test Everything

### Test Checklist:

1. **Frontend Homepage:**
   - Visit: `https://your-project.vercel.app`
   - Should show your homepage

2. **Quote Wizard:**
   - Visit: `https://your-project.vercel.app/quote.html`
   - Click through the wizard
   - Test AI chat (Step 3)
   - Verify it connects to backend

3. **Admin Dashboard:**
   - Visit: `https://your-project.vercel.app/admin.html`
   - Login with your admin password
   - Should see usage stats

4. **API Endpoints:**
   - Test: `https://your-project.vercel.app/health`
   - Should return JSON

---

## 🎯 Quick Reference

### Your URLs After Deployment:
- **Homepage:** `https://your-project.vercel.app`
- **Quote Page:** `https://your-project.vercel.app/quote.html`
- **Admin:** `https://your-project.vercel.app/admin.html`
- **API Health:** `https://your-project.vercel.app/health`
- **API Analyze:** `https://your-project.vercel.app/api/analyze-project`
- **API Estimate:** `https://your-project.vercel.app/api/estimate-cost`

### Environment Variables You Need:
1. `DEEPSEEK_API_KEY` - Your DeepSeek API key
2. `ADMIN_PASSWORD` - Your admin password
3. `NODE_ENV` - Set to `production`
4. `ALLOWED_ORIGIN` - Your Vercel URL

---

## 🐛 Troubleshooting

### Issue: "Build Failed"
**Solution:**
- Check Build Logs in deployment
- Make sure `package.json` is in `backend/` folder
- Verify Node.js version (should be 18+)

### Issue: "Function Error"
**Solution:**
- Check Function Logs
- Verify environment variables are set
- Check `server.js` is in `backend/` folder

### Issue: "404 Not Found" for API
**Solution:**
- Verify `vercel.json` routes are correct
- Check backend is deployed (look for function logs)
- Make sure route starts with `/api/`

### Issue: CORS Error
**Solution:**
- Update `ALLOWED_ORIGIN` to match your frontend URL exactly
- Include `https://` and no trailing slash
- Redeploy after updating

---

## 📸 Visual Guide

### Step 4 - Environment Variables Screen:
```
┌─────────────────────────────────────┐
│ Environment Variables               │
├─────────────────────────────────────┤
│                                     │
│  [Add Variable] button             │
│                                     │
│  After adding, you'll see:         │
│  ┌─────────────────────────────┐   │
│  │ DEEPSEEK_API_KEY    [Edit]  │   │
│  │ ADMIN_PASSWORD      [Edit]  │   │
│  │ NODE_ENV            [Edit]  │   │
│  │ ALLOWED_ORIGIN      [Edit]  │   │
│  └─────────────────────────────┘   │
└─────────────────────────────────────┘
```

### Step 5 - Deploy Button:
```
┌─────────────────────────────────────┐
│                                     │
│  Project Settings...                │
│                                     │
│                                     │
│  ┌───────────────────────────────┐ │
│  │   [Deploy] button (big blue)  │ │
│  └───────────────────────────────┘ │
└─────────────────────────────────────┘
```

---

## ✅ Success Checklist

After following all steps, verify:

- [ ] Project deployed successfully
- [ ] Got your Vercel URL
- [ ] Environment variables added
- [ ] `/health` endpoint works
- [ ] Frontend connects to backend
- [ ] Quote wizard works
- [ ] Admin dashboard accessible

---

**You're ready! Follow these steps and your site will be live! 🚀**

If you get stuck at any step, check the logs or let me know which step you're on!

