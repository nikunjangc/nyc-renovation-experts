// Self-Fix AI chat widget — talks to the Python backend (selffix/server.py locally,
// or /api/self-fix on Vercel). Keeps a short rolling history for context and
// enforces the booking redirect when the backend's safety guardrail trips.
(function () {
  // Backend endpoint resolution:
  //  - On localhost, ALWAYS use the local Python dev server (selffix/server.py),
  //    even if the page sets a production window.SELF_FIX_API_URL — so the dev
  //    loop hits your local backend. Override the local target with
  //    window.SELF_FIX_API_URL_LOCAL if you run it on a different port.
  //  - In production (e.g. GitHub Pages), use window.SELF_FIX_API_URL (the Vercel
  //    function URL set in self-fix.html), falling back to same-origin.
  var isLocal = /^localhost$|^127\.0\.0\.1$/.test(location.hostname);
  var API_URL = isLocal
    ? window.SELF_FIX_API_URL_LOCAL || 'http://localhost:3002/api/self-fix'
    : window.SELF_FIX_API_URL || '/api/self-fix';

  var BOOKING_URL = 'appointment.html';
  var MAX_HISTORY = 6; // turns sent back for context

  var history = []; // [{role:'user'|'assistant', content:''}]

  var elMessages = document.getElementById('chatMessages');
  var elForm = document.getElementById('chatForm');
  var elInput = document.getElementById('chatInput');
  var elSend = document.getElementById('chatSend');

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Render plain text with line breaks; turn leading "1. / 2." lines into a list feel.
  function formatReply(text) {
    return escapeHtml(text).replace(/\n/g, '<br>');
  }

  function addBubble(role, html, opts) {
    opts = opts || {};
    var wrap = document.createElement('div');
    wrap.className = 'sf-msg sf-' + role + (opts.danger ? ' sf-danger' : '');
    var bubble = document.createElement('div');
    bubble.className = 'sf-bubble';
    bubble.innerHTML = html;
    wrap.appendChild(bubble);

    if (opts.booking) {
      var cta = document.createElement('a');
      cta.className = 'sf-book-btn';
      cta.href = BOOKING_URL;
      cta.textContent = '📅 Book a Licensed Electrician';
      wrap.appendChild(cta);
    }
    elMessages.appendChild(wrap);
    elMessages.scrollTop = elMessages.scrollHeight;
    return wrap;
  }

  function setBusy(busy) {
    elInput.disabled = busy;
    elSend.disabled = busy;
    elSend.textContent = busy ? '…' : 'Send';
  }

  function addTyping() {
    var wrap = document.createElement('div');
    wrap.className = 'sf-msg sf-assistant sf-typing';
    wrap.innerHTML = '<div class="sf-bubble"><span></span><span></span><span></span></div>';
    elMessages.appendChild(wrap);
    elMessages.scrollTop = elMessages.scrollHeight;
    return wrap;
  }

  async function send(message) {
    addBubble('user', escapeHtml(message));
    history.push({ role: 'user', content: message });
    setBusy(true);
    var typing = addTyping();

    try {
      var res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message, history: history.slice(-MAX_HISTORY) }),
      });
      var data = await res.json();
      typing.remove();

      if (!res.ok) {
        addBubble('assistant', 'Sorry, something went wrong. Please try again, or book an electrician directly.', { booking: true });
        return;
      }

      var blocked = data.redirect_to_booking || (data.safety && data.safety.blocked);
      addBubble('assistant', formatReply(data.reply || ''), {
        booking: !!blocked,
        danger: !!blocked,
      });
      history.push({ role: 'assistant', content: data.reply || '' });
    } catch (err) {
      typing.remove();
      addBubble(
        'assistant',
        'I could not reach the assistant. If this is urgent or anything looks unsafe, please book an electrician.',
        { booking: true, danger: true }
      );
    } finally {
      setBusy(false);
      elInput.focus();
    }
  }

  elForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var msg = elInput.value.trim();
    if (!msg) return;
    elInput.value = '';
    send(msg);
  });

  // Quick-start example chips
  document.querySelectorAll('[data-example]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var msg = btn.getAttribute('data-example');
      elInput.value = '';
      send(msg);
    });
  });

  // Greeting
  addBubble(
    'assistant',
    "Hi! I'm SafetyBot. I can help with <strong>safe, minor electrical fixes</strong> — like a tripped breaker, a GFCI outlet with no power, or a burnt-out bulb. Describe what's happening. If anything looks or smells dangerous, I'll get you straight to a licensed electrician."
  );
})();
