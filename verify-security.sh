#!/bin/bash
# Security Verification Script
# Run this before pushing to Git!

echo "🔒 Checking Git Security..."
echo ""

# Check if .env exists
if [ -f "backend/.env" ]; then
    echo "✅ .env file exists"
    
    # Check if .env is in .gitignore
    if git check-ignore -q backend/.env; then
        echo "✅ .env is properly ignored by Git"
    else
        echo "❌ WARNING: .env is NOT ignored! Add it to .gitignore immediately!"
    fi
    
    # Check if .env contains real secrets (not templates)
    if grep -q "sk-your\|your-actual\|your-key" backend/.env 2>/dev/null; then
        echo "⚠️  WARNING: .env still contains template values!"
        echo "   Make sure you've added your real API keys"
    else
        echo "✅ .env contains actual secrets (not templates)"
    fi
else
    echo "⚠️  .env file does NOT exist"
    echo "   Run: cp backend/env-template.txt backend/.env"
fi

echo ""
echo "📋 Files that WILL be pushed to Git:"
git ls-files backend/ | grep -E "(env-template|\.gitignore)" | head -5

echo ""
echo "📋 Files that will NOT be pushed (ignored):"
git check-ignore backend/.env backend/logs/ backend/node_modules/ 2>/dev/null | sed 's/^/   /'

echo ""
echo "🔍 Searching for hardcoded secrets in code..."
if grep -r "sk-[a-zA-Z0-9]\{20,\}" --exclude-dir=node_modules --exclude-dir=.git --exclude="*.md" . 2>/dev/null | grep -v "template\|example\|your-key"; then
    echo "❌ WARNING: Found potential hardcoded API keys!"
else
    echo "✅ No hardcoded secrets found"
fi

echo ""
echo "✅ Security check complete!"

