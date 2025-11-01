# 🗄️ Database Setup Guide

## Current Status: JSON File Logging

Your current setup uses a JSON file (`logs/api-usage.json`) for logging:
- ✅ Works for small scale
- ✅ No database setup needed
- ❌ Not ideal for production at scale
- ❌ Single-file can have concurrency issues

## Option 1: SQLite (Recommended for Start)

**Best for:** Small to medium applications, up to 1000s of requests/day

### Setup:

1. **Install SQLite package:**
```bash
npm install better-sqlite3
```

2. **Create database schema file:**
Create `backend/db-schema.js`:
```javascript
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'logs', 'api-usage.db');
const db = new Database(dbPath);

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS api_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    ip TEXT,
    project_type TEXT,
    tokens_used INTEGER DEFAULT 0,
    cost REAL DEFAULT 0,
    model TEXT,
    success INTEGER DEFAULT 1,
    error TEXT,
    response_time INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_timestamp ON api_logs(timestamp);
  CREATE INDEX IF NOT EXISTS idx_endpoint ON api_logs(endpoint);
`);

module.exports = db;
```

3. **Update usage-logger.js to use SQLite:**
Replace the file-based logging with database calls.

**Pros:**
- ✅ File-based (no server needed)
- ✅ Free, no hosting required
- ✅ Fast for small/medium scale
- ✅ Easy to backup (just copy the .db file)

**Cons:**
- ❌ Can't handle high concurrent writes (but fine for your use case)
- ❌ Limited to single server

## Option 2: PostgreSQL (Production Ready)

**Best for:** Production, multiple servers, large scale

### Free Hosting Options:

#### A. Supabase (Recommended)
1. Go to https://supabase.com
2. Sign up (free tier: 500MB database)
3. Create new project
4. Get connection string from Settings → Database

**Setup:**
```bash
npm install pg
```

Connection string format:
```
postgresql://postgres:[PASSWORD]@[HOST]:5432/postgres
```

#### B. Neon (Serverless PostgreSQL)
1. Go to https://neon.tech
2. Sign up (free tier: 512MB)
3. Create database
4. Get connection string

#### C. Railway (Included with App Hosting)
- If you host your backend on Railway, you can add PostgreSQL as a service
- Free tier includes database

### Database Schema for PostgreSQL:

```sql
CREATE TABLE api_logs (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    endpoint VARCHAR(255) NOT NULL,
    ip VARCHAR(45),
    project_type VARCHAR(100),
    tokens_used INTEGER DEFAULT 0,
    cost DECIMAL(10, 6) DEFAULT 0,
    model VARCHAR(50),
    success BOOLEAN DEFAULT TRUE,
    error TEXT,
    response_time INTEGER DEFAULT 0
);

CREATE INDEX idx_timestamp ON api_logs(timestamp);
CREATE INDEX idx_endpoint ON api_logs(endpoint);
```

## Option 3: MongoDB Atlas (NoSQL)

**Best for:** Flexible schema, document-based data

### Setup:
1. Go to https://mongodb.com/cloud/atlas
2. Sign up (free tier: 512MB)
3. Create cluster
4. Get connection string

**Install:**
```bash
npm install mongodb
```

## 🎯 Recommendation for Your Project

### Phase 1: Start with SQLite (Now)
- ✅ Quick setup (5 minutes)
- ✅ No external dependencies
- ✅ Works perfectly for your scale
- ✅ Easy to migrate later

### Phase 2: Upgrade to PostgreSQL (When needed)
- When you have >1000 requests/day
- When you need multiple servers
- When you want better analytics

### Phase 3: Add Caching/Redis (Optional)
- For high traffic
- For real-time analytics
- Not needed initially

## 📝 Quick SQLite Migration Guide

If you want to switch to SQLite now:

1. Install package
2. Create schema file (see above)
3. Update `usage-logger.js` to use database
4. Migrate existing JSON logs (optional)

Would you like me to create the SQLite implementation for you?

