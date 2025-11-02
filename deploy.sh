#!/bin/bash

# Helper script to merge gh-pages into main and trigger auto-deployment
# Usage: ./deploy.sh

set -e  # Exit on error

echo "🚀 Starting deployment process..."
echo ""

# Check if we're in a git repository
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    echo "❌ Error: Not in a git repository"
    exit 1
fi

# Get current branch
CURRENT_BRANCH=$(git branch --show-current)
echo "📍 Current branch: $CURRENT_BRANCH"
echo ""

# Ensure gh-pages has all local changes committed
if [ "$CURRENT_BRANCH" != "gh-pages" ]; then
    echo "⚠️  You're not on gh-pages branch. Switching to gh-pages..."
    git checkout gh-pages
fi

# Check for uncommitted changes
if ! git diff-index --quiet HEAD --; then
    echo "⚠️  You have uncommitted changes on gh-pages"
    echo "Please commit or stash them before deploying."
    exit 1
fi

# Ask if user wants to push gh-pages first (backup)
read -p "💾 Push gh-pages to remote first? (y/n) [y]: " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]] || [[ -z $REPLY ]]; then
    echo "📤 Pushing gh-pages to remote..."
    git push origin gh-pages
    echo "✅ gh-pages pushed successfully"
    echo ""
fi

# Switch to main branch
echo "🔄 Switching to main branch..."
git checkout main

# Pull latest main
echo "⬇️  Pulling latest changes from main..."
git pull origin main

# Merge gh-pages into main
echo "🔀 Merging gh-pages into main..."
git merge gh-pages --no-edit

# Push to main (this triggers auto-deployment)
echo ""
echo "🚀 Pushing to main (this will trigger auto-deployment)..."
git push origin main

echo ""
echo "✅ Deployment initiated!"
echo ""
echo "📊 Next steps:"
echo "   1. Check GitHub Actions: https://github.com/nikunjangc/nyc-renovation-experts/actions"
echo "   2. Your site will update at: https://nycrenovationexperts.com"
echo "   3. Deployment usually takes 1-2 minutes"
echo ""
echo "🔄 Switching back to gh-pages branch for continued development..."
git checkout gh-pages

echo ""
echo "✨ Done! Continue working on gh-pages branch."

