# 🚀 Deployment Workflow Guide

This guide explains how to work with the `gh-pages` (development) and `main` (production) branches.

## 📋 Branch Strategy

- **`gh-pages`**: Your working branch for local development
- **`main`**: Production branch that auto-deploys to GitHub Pages

## 🔄 Daily Workflow

### 1. Work on `gh-pages` Branch

```bash
# Make sure you're on gh-pages
git checkout gh-pages

# Make your changes, edit files, etc.
# ...

# Commit your changes
git add .
git commit -m "Your commit message"
git push origin gh-pages  # Optional: backup your work
```

### 2. Deploy to Production

When you're ready to deploy your changes:

#### Option A: Use the Helper Script (Recommended) ⚡

```bash
./deploy.sh
```

The script will:
1. ✅ Check you're on `gh-pages` with committed changes
2. 💾 Optionally push `gh-pages` to remote (backup)
3. 🔄 Switch to `main` branch
4. ⬇️ Pull latest `main` changes
5. 🔀 Merge `gh-pages` into `main`
6. 🚀 Push to `main` (triggers auto-deployment)
7. 🔄 Switch back to `gh-pages` for continued work

#### Option B: Manual Deployment

```bash
# Switch to main
git checkout main

# Pull latest
git pull origin main

# Merge gh-pages
git merge gh-pages

# Push (triggers auto-deployment)
git push origin main

# Switch back to gh-pages
git checkout gh-pages
```

## ✅ After Deployment

1. **Check GitHub Actions**: 
   - Go to: https://github.com/nikunjangc/nyc-renovation-experts/actions
   - Watch the deployment workflow run

2. **Wait for Deployment**:
   - Usually takes 1-2 minutes
   - You'll see a green checkmark when complete

3. **Verify Your Site**:
   - Visit: https://nycrenovationexperts.com
   - Your changes should be live!

## 📝 Notes

- **Always work on `gh-pages`** - This keeps your development separate from production
- **Merge to `main`** only when ready to deploy
- The GitHub Actions workflow automatically deploys when you push to `main`
- If deployment fails, check the Actions tab for error messages

## 🐛 Troubleshooting

### Script says "uncommitted changes"
```bash
# Commit your changes first
git add .
git commit -m "Your changes"
# Then run deploy.sh again
```

### Merge conflicts
```bash
# Resolve conflicts manually
git merge --abort  # Start over
# Or resolve conflicts in your editor, then:
git add .
git commit
git push origin main
```

### Deployment not working
1. Check GitHub repository Settings → Pages
2. Ensure "Source" is set to "GitHub Actions" (not "Deploy from a branch")
3. Check the Actions tab for workflow errors

## 🎯 Quick Reference

```bash
# Daily development
git checkout gh-pages
# ... make changes ...
git add . && git commit -m "message" && git push origin gh-pages

# Deploy to production
./deploy.sh

# Or manually:
git checkout main && git pull && git merge gh-pages && git push origin main && git checkout gh-pages
```

