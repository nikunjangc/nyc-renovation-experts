# AI-Powered Quote Assistant Setup Guide

## Overview
The AI Quote Assistant is a multi-step interactive form that helps visitors get instant renovation quotes using AI analysis. It combines project information, natural language descriptions, and photo uploads to provide comprehensive cost estimates.

## Features

### ✅ Implemented Features:
1. **5-Step Wizard Interface**
   - Step 1: Project Type Selection (Kitchen, Bathroom, Full Home, etc.)
   - Step 2: Location & Basic Info (Borough, Square Footage, Budget, Timeline)
   - Step 3: AI-Powered Project Description Chat
   - Step 4: Photo Upload (Optional)
   - Step 5: Results & Contact Information

2. **AI Integration**
   - Natural language project description
   - OpenAI API integration for intelligent analysis
   - Fallback analysis if API is unavailable
   - Real-time chat interface with typing indicators

3. **Smart Cost Estimation**
   - Dynamic cost calculation based on:
     - Project type
     - Square footage
     - Borough location (NYC pricing multipliers)
     - Budget range
   - Displayed in user-friendly format

4. **Photo Upload**
   - Drag & drop interface
   - Multiple file support
   - Image preview
   - File size validation (10MB max)

5. **Form Submission**
   - Integrates with Formspree
   - Sends all collected data including AI analysis
   - Success/error handling

## Setup Instructions

### 1. OpenAI API Configuration

**Important:** For production use, you should create a backend API endpoint to securely handle OpenAI API calls. Exposing API keys in frontend JavaScript is a security risk.

#### Option A: Frontend Setup (Development Only)
1. Open `js/ai-quote.js`
2. Find line with `const OPENAI_API_KEY = 'YOUR_OPENAI_API_KEY_HERE';`
3. Replace with your OpenAI API key (⚠️ Not recommended for production)

#### Option B: Backend Setup (Recommended)
1. Create a backend endpoint (e.g., `/api/analyze-project`)
2. Store your OpenAI API key securely on the server
3. Update the `callOpenAI()` function in `ai-quote.js` to call your backend endpoint instead

Example backend endpoint structure:
```javascript
// In ai-quote.js, update callOpenAI function:
async function callOpenAI(userDescription) {
  const response = await fetch('/api/analyze-project', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      projectType: quoteData.projectType,
      borough: quoteData.borough,
      squareFootage: quoteData.squareFootage,
      budgetRange: quoteData.budgetRange,
      description: userDescription
    })
  });
  
  const data = await response.json();
  return data.analysis;
}
```

### 2. Formspree Configuration
1. Sign up at [Formspree.io](https://formspree.io)
2. Create a new form and get the form ID
3. The form ID is already configured in `quote.html`:
   ```html
   <form id="quoteForm" action="https://formspree.io/f/mvgaqvdy" method="POST">
   ```
4. Replace `mvgaqvdy` with your Formspree form ID

### 3. Customize Cost Estimates
Edit the `calculateCostEstimate()` function in `js/ai-quote.js` to adjust:
- Base costs for each project type
- Borough-specific multipliers
- Budget range multipliers
- Square footage calculations

### 4. Customize AI Prompts
Modify the system prompt in `callOpenAI()` function to change how the AI analyzes projects.

## Cost Estimation Logic

The system calculates estimates based on:

1. **Base Costs** (per project type):
   - Kitchen: $15K-$75K, $150/sqft
   - Bathroom: $8K-$35K, $200/sqft
   - Full Home: $50K-$200K, $100/sqft
   - Basement: $20K-$80K, $80/sqft
   - Office: $25K-$100K, $120/sqft

2. **Borough Multipliers**:
   - Manhattan: 1.3x
   - Brooklyn: 1.1x
   - Queens: 1.0x (base)
   - Bronx: 0.9x
   - Staten Island: 0.9x

3. **Budget Range Multipliers**:
   - Under $10K: 0.8x
   - $10K-$25K: 1.0x
   - $25K-$50K: 1.2x
   - $50K-$100K: 1.5x
   - $100K+: 2.0x

## File Structure

```
nyc-renovation-experts/
├── quote.html          # Main quote page
├── js/
│   └── ai-quote.js     # AI quote functionality
└── AI-QUOTE-SETUP.md   # This file
```

## Testing

1. **Without OpenAI API**:
   - The system will automatically use fallback analysis
   - All features work except AI-generated responses
   - Cost estimation still functions

2. **With OpenAI API**:
   - Enable API key (see Setup Instructions)
   - Test with various project descriptions
   - Verify cost estimates are reasonable

## Security Considerations

1. **Never expose API keys in frontend code for production**
2. **Validate all user inputs on the backend**
3. **Sanitize photo uploads**
4. **Rate limit API calls to prevent abuse**
5. **Use HTTPS for all API communications**

## Future Enhancements

- [ ] Backend API for secure OpenAI integration
- [ ] Image analysis using Vision API for uploaded photos
- [ ] Save quote drafts for users
- [ ] Email quote summaries automatically
- [ ] Integration with CRM systems
- [ ] A/B testing for different AI prompts
- [ ] Multi-language support

## Troubleshooting

### AI not responding:
- Check OpenAI API key is configured
- Verify API key has sufficient credits
- Check browser console for errors
- Fallback analysis should still work

### Cost estimates seem off:
- Adjust multipliers in `calculateCostEstimate()`
- Update base costs per project type
- Test with different input combinations

### Photos not uploading:
- Check file size (max 10MB)
- Verify file type is image (JPG, PNG, HEIC)
- Check browser console for errors

### Form submission failing:
- Verify Formspree form ID is correct
- Check Formspree account status
- Verify form email configuration

## Support

For issues or questions:
- Email: info@nycrenovationexperts.com
- Phone: +1 (646) 444-2434

