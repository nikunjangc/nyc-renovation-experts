# 🔒 Secure API Key Setup Guide

## ⚠️ CRITICAL: Your API Key Must Stay Secret!

Never expose your OpenAI API key in frontend JavaScript code. Anyone can view it and use it, potentially costing you money.

## ✅ Secure Solution: Backend API Server

We've created a secure backend server that:
- ✅ Stores your API key server-side (never exposed)
- ✅ Handles all OpenAI API calls securely
- ✅ Includes rate limiting to prevent abuse
- ✅ Validates requests
- ✅ Works with your frontend

## 🚀 Quick Setup

### Step 1: Install Dependencies

```bash
cd backend
npm install
```

### Step 2: Configure Environment Variables

1. Copy the example environment file:
```bash
cp .env.example .env
```

2. Edit `.env` and add your OpenAI API key:
```env
OPENAI_API_KEY=sk-your-actual-api-key-here
ALLOWED_ORIGIN=http://localhost:3000
PORT=3001
```

**Get your API key from:** https://platform.openai.com/api-keys

### Step 3: Start the Backend Server

```bash
npm start
```

You should see:
```
🚀 Secure AI Quote API Server running on port 3001
✅ API Key is safely stored server-side
🔒 CORS enabled for: http://localhost:3000
```

### Step 4: Update Frontend (Optional)

If your backend runs on a different URL (like in production), update `js/ai-quote.js`:

```javascript
// Change this line if needed:
const BACKEND_API_URL = 'https://your-backend-domain.com';
```

## 🌐 Production Deployment

### Option 1: Deploy Backend Separately (Recommended)

**Using Heroku:**
```bash
# Install Heroku CLI, then:
heroku create your-app-name
heroku config:set OPENAI_API_KEY=sk-your-key
heroku config:set ALLOWED_ORIGIN=https://nycrenovationexperts.com
git push heroku main
```

**Using Railway:**
- Connect your GitHub repo
- Add environment variables in Railway dashboard
- Deploy automatically

**Using Render:**
- Create new Web Service
- Connect GitHub repo
- Add environment variables
- Deploy

### Option 2: Same Server (Advanced)

If hosting on same server:
1. Deploy backend to `/api` subdirectory
2. Use reverse proxy (nginx/Apache) to route `/api/*` to backend
3. Frontend calls relative URLs: `/api/analyze-project`

### Environment Variables for Production

```env
OPENAI_API_KEY=sk-your-key-here
ALLOWED_ORIGIN=https://nycrenovationexperts.com,https://www.nycrenovationexperts.com
PORT=3001
NODE_ENV=production
```

## 🔐 Security Features Included

1. **Rate Limiting**: 5 requests per minute per IP
2. **CORS Protection**: Only allows requests from your domain
3. **Server-Side Key**: API key never exposed to clients
4. **Error Handling**: Secure error messages (no key leakage)
5. **Input Validation**: Validates all requests

## ✅ Verify It's Working

1. **Test Backend Health:**
```bash
curl http://localhost:3001/health
```
Should return: `{"status":"ok","message":"AI Quote API is running"}`

2. **Test Frontend:**
- Open `quote.html` in browser
- Go through the quote wizard
- Check browser console for errors
- AI should work if backend is running

## 🛡️ Additional Security Recommendations

### For Production:

1. **Add Authentication** (Optional):
   - Add API key/token system for extra protection
   - Only allow authenticated requests

2. **Use HTTPS:**
   - Always use HTTPS in production
   - Prevents man-in-the-middle attacks

3. **Monitor Usage:**
   - Set up OpenAI usage alerts
   - Monitor backend logs for suspicious activity

4. **Backup Plan:**
   - If backend fails, frontend uses fallback (algorithmic estimates)
   - Always test fallback behavior

## 🔍 How to Check Your API Key is Safe

1. ✅ View source of `quote.html` in browser
2. ✅ Search for "sk-" (your API key prefix)
3. ✅ Should NOT find it anywhere
4. ✅ Only in `.env` file (never committed to Git)

## 🚨 What NOT to Do

❌ **NEVER** put API key in:
- Frontend JavaScript files
- HTML files
- GitHub repository (even if private)
- Client-side code
- Environment variables in frontend build

✅ **ALWAYS** keep API key in:
- `.env` file (server-side only)
- Environment variables on hosting platform
- Never commit `.env` to Git (it's in `.gitignore`)

## 📝 Troubleshooting

### Backend won't start:
- Check `.env` file exists and has `OPENAI_API_KEY`
- Check port 3001 is not already in use
- Check Node.js is installed: `node --version`

### Frontend can't connect:
- Check backend is running: `curl http://localhost:3001/health`
- Check CORS settings in `.env` match your frontend URL
- Check browser console for errors

### API calls failing:
- Verify OpenAI API key is valid
- Check OpenAI account has credits
- Check rate limits haven't been exceeded

## 📞 Need Help?

If you encounter issues:
1. Check backend logs for errors
2. Check browser console for frontend errors
3. Verify `.env` file is correct
4. Test with `curl` commands above

---

**Remember:** Your API key is like a credit card - keep it secret, keep it safe! 🔐

