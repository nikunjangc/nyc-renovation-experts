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
  photos: []
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

