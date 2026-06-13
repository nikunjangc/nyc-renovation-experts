// AI Quote Wizard JavaScript
let currentStep = 1;
let quoteData = {
  projectType: '',
  borough: '',
  squareFootage: '',
  budgetRange: '',
  timeline: '',
  description: '',
  aiAnalysis: '',
  photos: [],
  // Clarification answers, e.g. { cabinet_style: 'Shaker', countertop: 'Quartz' }
  clarifications: {}
};

// Step Navigation
function nextStep() {
  if (validateStep(currentStep)) {
    if (currentStep < 5) {
      document.getElementById(`step${currentStep}`).classList.remove('active');
      updateStepIndicator(currentStep, false);
      currentStep++;
      document.getElementById(`step${currentStep}`).classList.add('active');
      updateStepIndicator(currentStep, true);
      
      // Generate quote on step 5 (now async)
      if (currentStep === 5) {
        generateFinalQuote(); // This is now async but doesn't need await
      }
    }
  }
}

function prevStep() {
  if (currentStep > 1) {
    document.getElementById(`step${currentStep}`).classList.remove('active');
    updateStepIndicator(currentStep, false);
    currentStep--;
    document.getElementById(`step${currentStep}`).classList.add('active');
    updateStepIndicator(currentStep, true);
  }
}

function updateStepIndicator(step, isActive) {
  const indicators = document.querySelectorAll('.step-dot');
  indicators.forEach((indicator, index) => {
    const stepNum = index + 1;
    if (stepNum < step) {
      indicator.classList.add('completed');
      indicator.classList.remove('active');
    } else if (stepNum === step) {
      indicator.classList.toggle('active', isActive);
      indicator.classList.remove('completed');
    } else {
      indicator.classList.remove('active', 'completed');
    }
  });
}

function validateStep(step) {
  switch(step) {
    case 1:
      return quoteData.projectType !== '';
    case 2:
      return quoteData.borough !== '' && quoteData.budgetRange !== '';
    case 3:
      return quoteData.description !== '';
    default:
      return true;
  }
}

// Project Type Selection
document.addEventListener('DOMContentLoaded', function() {
  const projectCards = document.querySelectorAll('.project-type-card');
  projectCards.forEach(card => {
    card.addEventListener('click', function() {
      projectCards.forEach(c => c.classList.remove('selected'));
      this.classList.add('selected');
      quoteData.projectType = this.dataset.type;
      document.getElementById('btn-step1').disabled = false;
    });
  });

  // Borough change
  document.getElementById('borough')?.addEventListener('change', function() {
    quoteData.borough = this.value;
  });

  // Square footage change
  document.getElementById('squareFootage')?.addEventListener('input', function() {
    quoteData.squareFootage = this.value;
  });

  // Budget range change
  document.getElementById('budgetRange')?.addEventListener('change', function() {
    quoteData.budgetRange = this.value;
  });

  // Timeline change
  document.getElementById('timeline')?.addEventListener('change', function() {
    quoteData.timeline = this.value;
  });

  // Photo upload drag and drop
  setupDragAndDrop();
});

// AI Chat Functionality
async function sendToAI() {
  const description = document.getElementById('projectDescription').value.trim();
  if (!description) {
    alert('Please describe your project first.');
    return;
  }

  quoteData.description = description;

  // Add user message to chat
  const chatContainer = document.getElementById('chat-container');
  const userMessage = document.createElement('div');
  userMessage.className = 'chat-message user';
  userMessage.innerHTML = `<strong>You:</strong> ${description}`;
  chatContainer.appendChild(userMessage);
  chatContainer.scrollTop = chatContainer.scrollHeight;

  // Clear input
  document.getElementById('projectDescription').value = '';

  // Show typing indicator
  const typingIndicator = document.createElement('div');
  typingIndicator.className = 'chat-message ai';
  typingIndicator.id = 'typing-indicator';
  typingIndicator.innerHTML = '<strong>RenoBot:</strong> <div class="typing-indicator"><span></span><span></span><span></span></div>';
  chatContainer.appendChild(typingIndicator);
  chatContainer.scrollTop = chatContainer.scrollHeight;

  // Disable send button
  const sendBtn = document.getElementById('btn-send-ai');
  sendBtn.disabled = true;

  try {
    // Call OpenAI API
    const aiResponse = await callOpenAI(description);
    
    // Remove typing indicator
    document.getElementById('typing-indicator')?.remove();

    // Add AI response to chat
    const aiMessage = document.createElement('div');
    aiMessage.className = 'chat-message ai';
    aiMessage.innerHTML = `<strong>RenoBot:</strong> ${aiResponse}`;
    chatContainer.appendChild(aiMessage);
    chatContainer.scrollTop = chatContainer.scrollHeight;

    // Show AI analysis box
    const aiResponseBox = document.getElementById('ai-response');
    const aiResponseContent = document.getElementById('ai-response-content');
    aiResponseContent.innerHTML = aiResponse;
    aiResponseBox.style.display = 'block';
    
    quoteData.aiAnalysis = aiResponse;
    document.getElementById('btn-step3').disabled = false;

  } catch (error) {
    console.error('AI Error:', error);
    document.getElementById('typing-indicator')?.remove();
    
    // Fallback response if API fails
    const fallbackResponse = generateFallbackAnalysis(description);
    const aiMessage = document.createElement('div');
    aiMessage.className = 'chat-message ai';
    aiMessage.innerHTML = `<strong>RenoBot:</strong> ${fallbackResponse}`;
    chatContainer.appendChild(aiMessage);
    
    const aiResponseBox = document.getElementById('ai-response');
    const aiResponseContent = document.getElementById('ai-response-content');
    aiResponseContent.innerHTML = fallbackResponse;
    aiResponseBox.style.display = 'block';
    
    quoteData.aiAnalysis = fallbackResponse;
    document.getElementById('btn-step3').disabled = false;
  } finally {
    sendBtn.disabled = false;
  }
}

// Secure OpenAI API Call via Backend
// API key is safely stored on the server, not exposed to frontend
async function callOpenAI(userDescription) {
  // Backend API endpoint (update this to your production URL when deploying)
  // For local development: http://localhost:3001
  // For production: https://your-backend-domain.com
  const BACKEND_API_URL = window.BACKEND_API_URL || 'http://localhost:3001';
  
  try {
    const response = await fetch(`${BACKEND_API_URL}/api/analyze-project`, {
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

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || 'API request failed');
    }

    const data = await response.json();
    return data.analysis;
  } catch (error) {
    console.error('Backend API Error:', error);
    // If backend is not available, use fallback
    if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
      console.warn('Backend API not available, using fallback analysis');
      return generateFallbackAnalysis(userDescription);
    }
    throw error;
  }
}

// Fallback Analysis (when API is not available)
function generateFallbackAnalysis(description) {
  const projectType = quoteData.projectType || 'renovation';
  const borough = quoteData.borough || 'NYC';
  const sqft = quoteData.squareFootage || '500';
  
  return `
    <p><strong>Scope of Work:</strong> Based on your ${projectType} project in ${borough} (${sqft} sq ft), I've identified the following key components:</p>
    <ul>
      <li>Design and planning phase</li>
      <li>Permits and approvals</li>
      <li>Material selection and procurement</li>
      <li>Construction and installation</li>
      <li>Final inspection and cleanup</li>
    </ul>
    <p><strong>Key Considerations:</strong> Your project will require attention to NYC building codes, proper permits, and quality materials suited for NYC's climate.</p>
    <p><strong>Estimated Timeline:</strong> 4-12 weeks depending on project complexity and permit processing time.</p>
  `;
}

// Cost Estimation
function calculateCostEstimate() {
  const baseCosts = {
    kitchen: { min: 15000, max: 75000, perSqft: 150 },
    bathroom: { min: 8000, max: 35000, perSqft: 200 },
    'full-home': { min: 50000, max: 200000, perSqft: 100 },
    basement: { min: 20000, max: 80000, perSqft: 80 },
    office: { min: 25000, max: 100000, perSqft: 120 },
    other: { min: 10000, max: 50000, perSqft: 100 }
  };

  const boroughMultipliers = {
    manhattan: 1.3,
    brooklyn: 1.1,
    queens: 1.0,
    bronx: 0.9,
    'staten-island': 0.9
  };

  const budgetMultipliers = {
    'under-10k': 0.8,
    '10k-25k': 1.0,
    '25k-50k': 1.2,
    '50k-100k': 1.5,
    '100k-plus': 2.0
  };

  const project = baseCosts[quoteData.projectType] || baseCosts.other;
  const sqft = parseInt(quoteData.squareFootage) || 500;
  const boroughMulti = boroughMultipliers[quoteData.borough] || 1.0;
  const budgetMulti = budgetMultipliers[quoteData.budgetRange] || 1.0;

  // Calculate based on square footage and multipliers
  const baseCost = project.perSqft * sqft;
  let minCost = Math.max(project.min, baseCost * 0.6) * boroughMulti;
  let maxCost = Math.min(project.max, baseCost * 1.8) * boroughMulti * budgetMulti;

  // Round to nearest 1000
  minCost = Math.round(minCost / 1000) * 1000;
  maxCost = Math.round(maxCost / 1000) * 1000;

  return { min: minCost, max: maxCost };
}

// Generate Final Quote with AI-Enhanced Cost Estimation
async function generateFinalQuote() {
  // Show loading state
  const costEstimateDiv = document.getElementById('costEstimate');
  const estimatedCostEl = document.getElementById('estimatedCost');
  const costDetailsEl = document.getElementById('costDetails');
  
  estimatedCostEl.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div> AI Analyzing...';
  costDetailsEl.textContent = 'Analyzing your project details for accurate estimate...';

  // Calculate base estimate (algorithmic fallback)
  const baseCost = calculateCostEstimate();
  
  // Try to get AI-enhanced estimate
  let aiCostEstimate = null;
  try {
    aiCostEstimate = await getAICostEstimate();
  } catch (error) {
    console.log('AI cost estimation not available, using calculated estimate');
  }

  // Use AI estimate if available, otherwise use calculated estimate
  const finalCost = aiCostEstimate || baseCost;
  
  // Update cost display
  estimatedCostEl.textContent = `$${finalCost.min.toLocaleString()} - $${finalCost.max.toLocaleString()}`;
  
  if (aiCostEstimate) {
    costDetailsEl.innerHTML = `
      <i class="fas fa-robot text-primary me-2"></i>
      AI-powered estimate based on your project description<br>
      <small>Project: ${quoteData.projectType} | Location: ${quoteData.borough} | Size: ${quoteData.squareFootage || 'estimated'} sq ft</small>
    `;
  } else {
    costDetailsEl.textContent = `Based on ${quoteData.projectType} renovation in ${quoteData.borough} (${quoteData.squareFootage || 'estimated'} sq ft)`;
  }

  // Display AI analysis
  if (quoteData.aiAnalysis) {
    document.getElementById('finalAnalysisContent').innerHTML = quoteData.aiAnalysis;
  }

  // Generate recommendations
  const recommendations = generateRecommendations();
  document.getElementById('recommendationsContent').innerHTML = recommendations;

  // Kick off the clarification step first. When the user submits their picks
  // (or hits "Skip"), THEN we load tools & materials with the enriched
  // description — so the shopping list and SerpAPI lookups stay accurate
  // instead of being model-default guesses.
  loadClarificationQuestions();

  // Populate form hidden fields
  document.getElementById('form_project_type').value = quoteData.projectType;
  document.getElementById('form_borough').value = quoteData.borough;
  document.getElementById('form_square_footage').value = quoteData.squareFootage;
  document.getElementById('form_budget_range').value = quoteData.budgetRange;
  document.getElementById('form_project_description').value = quoteData.description;
  document.getElementById('form_ai_analysis').value = quoteData.aiAnalysis;
  document.getElementById('form_estimated_cost').value = `$${finalCost.min.toLocaleString()} - $${finalCost.max.toLocaleString()}`;
}

// Secure AI-Powered Cost Estimation via Backend
// API key is safely stored on the server, not exposed to frontend
async function getAICostEstimate() {
  // Backend API endpoint (update this to your production URL when deploying)
  // For local development: http://localhost:3001
  // For production: https://your-backend-domain.com
  const BACKEND_API_URL = window.BACKEND_API_URL || 'http://localhost:3001';
  
  // Get base calculated estimate for context
  const baseEstimate = calculateCostEstimate();

  try {
    const response = await fetch(`${BACKEND_API_URL}/api/estimate-cost`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        projectType: quoteData.projectType,
        borough: quoteData.borough,
        squareFootage: quoteData.squareFootage,
        budgetRange: quoteData.budgetRange,
        timeline: quoteData.timeline,
        description: quoteData.description,
        baseEstimate: baseEstimate
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || 'API request failed');
    }

    const data = await response.json();
    return {
      min: data.min,
      max: data.max,
      reasoning: data.reasoning || ''
    };
  } catch (error) {
    console.error('Backend API Error:', error);
    // If backend is not available, throw error to use fallback
    if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
      console.warn('Backend API not available, using calculated estimate');
      throw new Error('Backend not available');
    }
    throw error;
  }
}

function generateRecommendations() {
  const recommendations = [];
  
  if (quoteData.timeline === 'asap') {
    recommendations.push('Consider starting with essential permits and approvals to expedite the process.');
  }
  
  if (quoteData.budgetRange === 'under-10k') {
    recommendations.push('For a smaller budget, consider phasing the project or focusing on high-impact areas first.');
  }
  
  recommendations.push('We recommend scheduling an on-site consultation for accurate measurements and a detailed quote.');
  recommendations.push('Check NYC DOB requirements for permits specific to your renovation type.');
  recommendations.push('Consider energy-efficient materials and fixtures for long-term savings.');
  
  return '<ul>' + recommendations.map(rec => `<li>${rec}</li>`).join('') + '</ul>';
}

// Photo Upload
function setupDragAndDrop() {
  const uploadArea = document.getElementById('uploadArea');
  const fileInput = document.getElementById('fileInput');

  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    uploadArea.addEventListener(eventName, preventDefaults, false);
  });

  function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  ['dragenter', 'dragover'].forEach(eventName => {
    uploadArea.addEventListener(eventName, () => {
      uploadArea.classList.add('dragover');
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    uploadArea.addEventListener(eventName, () => {
      uploadArea.classList.remove('dragover');
    }, false);
  });

  uploadArea.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const files = dt.files;
    handleFiles(files);
  }, false);
}

function handleFiles(files) {
  const preview = document.getElementById('uploadPreview');
  
  Array.from(files).forEach(file => {
    if (file.type.startsWith('image/') && file.size <= 10 * 1024 * 1024) {
      const reader = new FileReader();
      reader.onload = function(e) {
        const previewItem = document.createElement('div');
        previewItem.className = 'upload-preview-item';
        previewItem.innerHTML = `
          <img src="${e.target.result}" alt="Preview">
          <button onclick="removePhoto(this)" type="button">×</button>
        `;
        preview.appendChild(previewItem);
        
        // Store file data (in production, upload to server)
        quoteData.photos.push({
          name: file.name,
          data: e.target.result
        });
      };
      reader.readAsDataURL(file);
    } else {
      alert('Please upload image files under 10MB.');
    }
  });
}

function removePhoto(button) {
  const previewItem = button.parentElement;
  const index = Array.from(previewItem.parentElement.children).indexOf(previewItem);
  quoteData.photos.splice(index, 1);
  previewItem.remove();
}

// ===== Clarification step (runs BEFORE tools & materials) =====

async function loadClarificationQuestions() {
  const box = document.getElementById('clarifyBox');
  const slot = document.getElementById('clarifyQuestions');
  const actions = document.getElementById('clarifyActions');
  const introEl = document.getElementById('clarifyIntro');
  if (!box || !slot) return;

  const BACKEND_API_URL = window.BACKEND_API_URL || 'http://localhost:3001';
  try {
    const response = await fetch(`${BACKEND_API_URL}/api/clarify-project`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectType: quoteData.projectType,
        borough: quoteData.borough,
        squareFootage: quoteData.squareFootage,
        budgetRange: quoteData.budgetRange,
        description: quoteData.description || '',
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.questions?.length) {
      // No questions to ask (or backend hiccup) — fall through directly to materials.
      revealToolsAndMaterials();
      return;
    }
    if (data.intro && introEl) introEl.textContent = data.intro;
    renderClarification(slot, data.questions);
    actions.style.display = '';
    document.getElementById('clarifySkipBtn').onclick = () => {
      quoteData.clarifications = {};
      revealToolsAndMaterials();
    };
    document.getElementById('clarifySubmitBtn').onclick = () => {
      revealToolsAndMaterials();
    };
  } catch (err) {
    console.error('clarify-project failed', err);
    // If the clarifier fails, don't block the user — just load the materials.
    revealToolsAndMaterials();
  }
}

function renderClarification(container, questions) {
  container.innerHTML = questions.map((q) => `
    <div class="cq-group" data-qid="${escapeHtml(q.id)}">
      <div class="cq-label">${escapeHtml(q.label || q.question)}</div>
      <div class="cq-question">${escapeHtml(q.question)}</div>
      <div class="cq-chips">
        ${q.options.map((opt) => `
          <button type="button" class="cq-chip" data-value="${escapeHtml(opt)}">${escapeHtml(opt)}</button>
        `).join('')}
      </div>
    </div>
  `).join('');

  container.querySelectorAll('.cq-group').forEach((group) => {
    const qid = group.dataset.qid;
    group.querySelectorAll('.cq-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        group.querySelectorAll('.cq-chip').forEach((c) => c.classList.remove('selected'));
        chip.classList.add('selected');
        quoteData.clarifications[qid] = chip.dataset.value;
      });
    });
  });
}

function revealToolsAndMaterials() {
  const clarifyBox = document.getElementById('clarifyBox');
  const tmBox = document.getElementById('toolsMaterialsBox');
  if (clarifyBox) clarifyBox.style.display = 'none';
  if (tmBox) tmBox.style.display = '';
  loadToolsAndMaterials();
}

// ===== Tools & Materials + Retailer Comparison =====

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function loadToolsAndMaterials() {
  const materialsPane = document.getElementById('tm-materials');
  const toolsPane = document.getElementById('tm-tools');
  if (!materialsPane || !toolsPane) return;

  const BACKEND_API_URL = window.BACKEND_API_URL || 'http://localhost:3001';

  // Fold clarification picks into the description so the model has the
  // user's explicit preferences instead of guessing defaults.
  const baseDesc = quoteData.description || quoteData.aiAnalysis || '';
  const picks = Object.entries(quoteData.clarifications || {})
    .filter(([, v]) => v && !/^surprise/i.test(v))
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
    .join('; ');
  const enrichedDesc = picks ? `${baseDesc}\n\nUser preferences — ${picks}` : baseDesc;

  try {
    const response = await fetch(`${BACKEND_API_URL}/api/recommend-products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectType: quoteData.projectType,
        borough: quoteData.borough,
        squareFootage: quoteData.squareFootage,
        budgetRange: quoteData.budgetRange,
        timeline: quoteData.timeline,
        description: enrichedDesc,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const e = new Error(`HTTP ${response.status}`);
      e.payload = data;
      e.status = response.status;
      throw e;
    }
    renderToolMaterialPane(materialsPane, data.materials || [], 'materials');
    renderToolMaterialPane(toolsPane, data.tools || [], 'tools');
    bindTmTabs();
  } catch (err) {
    console.error('recommend-products failed', err);
    const hint = err.payload?.hint || '';
    const status = err.status || 'network';
    const msg = `
      <div class="tm-empty" style="text-align:left; padding:18px; background:#fff5f5; border:1px solid #f5c2c0; border-radius:8px; color:#842029;">
        <strong>Couldn't load product suggestions.</strong><br>
        <small>Status: ${escapeHtml(String(status))}${hint ? ' — ' + escapeHtml(hint) : ''}</small><br>
        <small>Your quote estimate above is still valid. We're looking into it.</small>
      </div>`;
    materialsPane.innerHTML = msg;
    toolsPane.innerHTML = msg;
  }
}

function renderToolMaterialPane(container, items, kind) {
  if (!items.length) {
    container.innerHTML = `<div class="tm-empty">No ${kind} suggestions for this project.</div>`;
    return;
  }
  container.innerHTML = items
    .map((item, idx) => itemRow(item, `${kind}-${idx}`))
    .join('');
  container.querySelectorAll('[data-search-btn]').forEach((btn) => {
    btn.addEventListener('click', () => searchAndRender(btn));
  });
}

function itemRow(item, id) {
  const qty = item.qty ? `${item.qty} ${escapeHtml(item.unit || '')}` : '';
  return `
    <div class="tm-item" data-tm-id="${escapeHtml(id)}">
      <div class="tm-item-header">
        <div>
          <div class="tm-item-name">${escapeHtml(item.name)}</div>
          <div class="tm-item-meta">${escapeHtml(item.category || '')} ${qty ? '· ' + qty : ''}</div>
        </div>
        <button type="button" class="tm-search-btn"
          data-search-btn data-query="${escapeHtml(item.query)}">
          Compare prices
        </button>
      </div>
      ${item.why ? `<div class="tm-item-why">${escapeHtml(item.why)}</div>` : ''}
      <div class="tm-results" data-results style="display:none;"></div>
    </div>
  `;
}

async function searchAndRender(btn) {
  const wrapper = btn.closest('.tm-item');
  const resultsEl = wrapper.querySelector('[data-results]');
  const query = btn.dataset.query;
  if (!query) return;

  if (wrapper.dataset.loaded === '1') {
    resultsEl.style.display = resultsEl.style.display === 'none' ? 'grid' : 'none';
    btn.textContent = resultsEl.style.display === 'none' ? 'Compare prices' : 'Hide prices';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Searching…';
  resultsEl.style.display = 'grid';
  resultsEl.innerHTML = `<div class="tm-loading"><div class="typing-indicator"><span></span><span></span><span></span></div></div>`;

  const BACKEND_API_URL = window.BACKEND_API_URL || 'http://localhost:3001';
  try {
    const response = await fetch(`${BACKEND_API_URL}/api/product-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit: 6 }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    renderProducts(resultsEl, data.results || [], data.source);
    wrapper.dataset.loaded = '1';
    btn.textContent = 'Hide prices';
  } catch (err) {
    console.error('product-search failed', err);
    resultsEl.innerHTML = `<div class="tm-empty">Couldn't load prices. Try again later.</div>`;
    btn.textContent = 'Retry';
  } finally {
    btn.disabled = false;
  }
}

function renderProducts(container, products, source) {
  if (!products.length) {
    container.innerHTML = `<div class="tm-empty">No matching products found.</div>`;
    return;
  }
  const cheapest = products.reduce((min, p) =>
    p.price != null && (min == null || p.price < min) ? p.price : min, null);

  const cards = products.map((p) => `
    <div class="tm-product">
      ${p.thumbnail ? `<img src="${escapeHtml(p.thumbnail)}" alt="${escapeHtml(p.title)}" loading="lazy">` : ''}
      <div class="tm-product-title">${escapeHtml(p.title)}</div>
      <div class="tm-product-retailer">
        ${escapeHtml(p.retailer)} ${p.rating ? `· ⭐ ${(+p.rating).toFixed(1)}` : ''}
      </div>
      <div class="tm-product-price">
        ${escapeHtml(p.priceDisplay || (p.price != null ? '$' + p.price.toFixed(2) : 'See price'))}
        ${cheapest != null && p.price === cheapest ? ' <span style="font-size:0.7rem;color:#28a745;">BEST</span>' : ''}
      </div>
      <a href="${escapeHtml(p.link || '#')}" target="_blank" rel="noopener noreferrer">View</a>
    </div>
  `).join('');

  const note = source === 'mock'
    ? `<div class="tm-empty" style="grid-column:1/-1;padding:6px;">Showing sample data — live retailer search activates once SERPAPI_KEY is configured.</div>`
    : '';
  container.innerHTML = cards + note;
}

function bindTmTabs() {
  const tabs = document.querySelectorAll('#tmTabs .tm-tab');
  if (!tabs.length) return;
  tabs.forEach((tab) => {
    if (tab.dataset.bound) return;
    tab.dataset.bound = '1';
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.tm-pane').forEach((p) => {
        p.style.display = p.id === tab.dataset.pane ? '' : 'none';
      });
    });
  });
}

// Form Submission
document.getElementById('quoteForm')?.addEventListener('submit', function(e) {
  e.preventDefault();
  
  const formData = new FormData(this);
  
  // Add AI-generated data
  formData.append('subject', 'AI-Powered Quote Request');
  formData.append('estimated_cost', document.getElementById('form_estimated_cost').value);
  
  // Submit to Formspree
  fetch(this.action, {
    method: 'POST',
    body: formData,
    headers: {
      'Accept': 'application/json'
    }
  })
  .then(response => {
    if (response.ok) {
      alert('Thank you! We\'ve received your quote request. Our team will contact you shortly for a detailed on-site consultation.');
      this.reset();
      // Optionally redirect
      // window.location.href = 'contact.html';
    } else {
      throw new Error('Form submission failed');
    }
  })
  .catch(error => {
    console.error('Error:', error);
    alert('There was an error submitting your request. Please try again or call us directly at +1 (646) 444-2434');
  });
});

