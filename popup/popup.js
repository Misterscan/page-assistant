/**
 * popup/popup.js
 *
 * Manages the popup UI and conversation state.
 *
 * Responsibilities:
 *   - Capture the active tab ID on load
 *   - Route quick-action clicks and custom text input to the service worker
 *   - Maintain conversation history in memory (Gemini multi-turn format)
 *   - Render AI responses with basic markdown support
 *   - Handle loading states, errors, and the clear action
 */

(function () {
  'use strict';

  // ─── State ─────────────────────────────────────────────────────────────────

  /**
   * Gemini multi-turn history.
   * Stored as actual prompts (including page content for turn 1) so the
   * model retains full context on follow-up messages.
   * @type {Array<{role: string, parts: Array<{text: string}>}>}
   */
  let conversationHistory = [];

  /** True once the first successful page extraction has been shown. */
  let pageInfoShown = false;

  /** 
   * UI-friendly history for rendering bubbles.
   * Format: { role: 'user' | 'assistant' | 'error', text: string }
   */
  let displayHistory = [];
  let lastTokens = null;

  let isLoading = false;

  // ─── DOM references ────────────────────────────────────────────────────────

  const chatEl         = document.getElementById('chat-messages');
  const emptyState     = document.getElementById('empty-state');
  const userInput      = document.getElementById('user-input');
  const btnSend        = document.getElementById('btn-send');
  const btnClear       = document.getElementById('btn-clear');
  const btnExport      = document.getElementById('btn-export');
  const loadingEl      = document.getElementById('loading');
  const loadingText    = document.getElementById('loading-text');
  const pageInfoEl     = document.getElementById('page-info');
  const pageTitleEl    = document.getElementById('page-title-text');
  const truncBadgeEl   = document.getElementById('truncation-badge');
  const tokenCounterEl = document.getElementById('token-counter');

  // ─── Init ──────────────────────────────────────────────────────────────────

  // Restore history from storage
  chrome.storage.local.get(['conversationHistory', 'displayHistory', 'pageInfoShown', 'pageTitle', 'truncated'], (result) => {
    if (result.conversationHistory) conversationHistory = result.conversationHistory;
    if (result.pageInfoShown) pageInfoShown = result.pageInfoShown;
    
    // Restore UI from displayHistory
    if (result.displayHistory && result.displayHistory.length > 0) {
      result.displayHistory.forEach(msg => appendMessage(msg.role, msg.text));
    }
    
    // Restore page info bar
    if (pageInfoShown && result.pageTitle) {
      pageTitleEl.textContent = result.pageTitle;
      pageInfoEl.classList.remove('hidden');
      if (result.truncated) truncBadgeEl.classList.remove('hidden');
      if (result.lastTokens) {
        tokenCounterEl.textContent = result.lastTokens;
        tokenCounterEl.classList.remove('hidden');
      }
    }
  });

  // ─── State Save Helper ─────────────────────────────────────────────────────

  function saveState(pageTitle, truncated) {
    const state = { conversationHistory, displayHistory, pageInfoShown };
    if (pageTitle !== undefined) state.pageTitle = pageTitle;
    if (truncated !== undefined) state.truncated = truncated;
    if (lastTokens !== null) state.lastTokens = lastTokens;
    chrome.storage.local.set(state);
  }

  // ─── Event listeners ───────────────────────────────────────────────────────

  document.querySelectorAll('.action-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!isLoading) sendToAI(btn.dataset.task, null);
    });
  });

  btnSend.addEventListener('click', handleSend);

  userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  // Auto-grow textarea up to CSS max-height
  userInput.addEventListener('input', () => {
    userInput.style.height = 'auto';
    userInput.style.height = Math.min(userInput.scrollHeight, 100) + 'px';
  });

  btnExport.addEventListener('click', exportConversation);
  btnClear.addEventListener('click', clearConversation);

  // ─── Core logic ────────────────────────────────────────────────────────────

  function handleSend() {
    const text = userInput.value.trim();
    if (!text || isLoading) return;
    userInput.value = '';
    userInput.style.height = 'auto';
    sendToAI('custom', text);
  }

  async function sendToAI(task, question) {
    if (isLoading) return;

    // Get the currently active tab ID dynamically so it stays up to date in the side panel
    let currentTabId;
    try {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tabs?.[0]?.id !== undefined) {
        currentTabId = tabs[0].id;
      }
    } catch (e) {
      console.warn('Failed to query tab:', e);
    }

    if (!currentTabId) {
      appendMessage('error', "Couldn't identify the current tab. Make sure a web page is active.");
      return;
    }

    // Optimistically show the user label immediately
    const label = question ?? TASK_LABELS[task] ?? task;
    appendMessage('user', label);
    displayHistory.push({ role: 'user', text: label });
    saveState();

    setLoading(true, pageInfoShown ? 'Thinking…' : 'Reading page…');

    let response;
    try {
      response = await sendMessage({ action: 'analyze', task, question, conversationHistory, tabId: currentTabId });
    } catch (err) {
      setLoading(false);
      const errorMsg = 'Could not reach the assistant. Make sure the extension is enabled and try again.';
      appendMessage('error', errorMsg);
      displayHistory.push({ role: 'error', text: errorMsg });
      saveState();
      return;
    }

    setLoading(false);

    if (!response.success) {
      const errorMsg = response.error ?? 'Something went wrong.';
      appendMessage('error', errorMsg);
      displayHistory.push({ role: 'error', text: errorMsg });
      saveState();
      return;
    }

    // Show page info bar on first successful extraction
    if (!pageInfoShown && response.pageTitle) {
      pageInfoShown = true;
      pageTitleEl.textContent = response.pageTitle;
      pageInfoEl.classList.remove('hidden');
      if (response.truncated) truncBadgeEl.classList.remove('hidden');
    }
    
    if (response.usage && response.usage.totalTokenCount) {
      lastTokens = `${response.usage.totalTokenCount} tokens`;
      tokenCounterEl.textContent = lastTokens;
      tokenCounterEl.classList.remove('hidden');
    }

    appendMessage('assistant', response.answer);
    displayHistory.push({ role: 'assistant', text: response.answer });

    // Store the actual message text (includes page content for turn 1)
    // so the model has full context for follow-up questions.
    conversationHistory.push(
      { role: 'user',  parts: [{ text: response.userMessageText }] },
      { role: 'model', parts: [{ text: response.answer }] },
    );
    saveState(response.pageTitle, response.truncated);
  }

  function exportConversation() {
    if (displayHistory.length === 0) return;
    
    let mdContent = `# Page Assistant Conversation\n\n`;
    if (pageInfoShown) {
      mdContent += `**Page:** ${pageTitleEl.textContent}\n\n---\n\n`;
    }
    
    for (const msg of displayHistory) {
      const roleStr = msg.role === 'user' ? '## You' : (msg.role === 'assistant' ? '## Assistant' : '## System');
      mdContent += `${roleStr}\n\n${msg.text}\n\n`;
    }
    
    const blob = new Blob([mdContent], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `conversation-${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function clearConversation() {
    conversationHistory = [];
    displayHistory      = [];
    pageInfoShown       = false;
    lastTokens          = null;

    chrome.storage.local.remove(['conversationHistory', 'displayHistory', 'pageInfoShown', 'pageTitle', 'truncated', 'lastTokens']);

    chatEl.innerHTML = '';
    chatEl.appendChild(buildEmptyState());

    pageInfoEl.classList.add('hidden');
    truncBadgeEl.classList.add('hidden');
    tokenCounterEl.classList.add('hidden');
  }

  // ─── UI helpers ────────────────────────────────────────────────────────────

  function appendMessage(role, text) {
    // Remove empty state on first real message
    const es = chatEl.querySelector('.empty-state');
    if (es) es.remove();

    const msg    = document.createElement('div');
    msg.className = `message ${role}`;

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    if (role === 'assistant') {
      bubble.innerHTML = renderMarkdown(text);
    } else {
      // user / error: plain text (escaped)
      bubble.textContent = text;
    }

    msg.appendChild(bubble);
    chatEl.appendChild(msg);
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  function buildEmptyState() {
    const div = document.createElement('div');
    div.className = 'empty-state';
    div.id        = 'empty-state';
    div.innerHTML = `
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="1.5" class="empty-icon">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
      </svg>
      <p>Use a quick action or ask anything about the page you're viewing.</p>`;
    return div;
  }

  function setLoading(active, text) {
    isLoading = active;
    loadingEl.classList.toggle('hidden', !active);
    if (text) loadingText.textContent = text;
    btnSend.disabled = active;
    document.querySelectorAll('.action-btn').forEach(b => { b.disabled = active; });
  }

  // ─── Chrome message helper ─────────────────────────────────────────────────

  /** Wraps chrome.runtime.sendMessage in a Promise. */
  function sendMessage(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  }

  // ─── Markdown renderer ─────────────────────────────────────────────────────

  /**
   * Render markdown to HTML safely using marked.js and DOMPurify.
   */
  function renderMarkdown(raw) {
    if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
      const html = marked.parse(raw);
      return DOMPurify.sanitize(html);
    }
    // Fallback if scripts fail to load
    let text = escapeHtml(raw);
    text = text.replace(/```[\\s\\S]*?```/g, m => `<pre><code>${m.slice(3,-3).trim()}</code></pre>`);
    return text.replace(/\\*\\*(.*?)\\*\\*/g, '<strong>$1</strong>').replace(/\\n/g, '<br>');
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;')
      .replace(/'/g,  '&#39;');
  }

  // ─── Constants ─────────────────────────────────────────────────────────────

  const TASK_LABELS = {
    summarize:   'Summarize the page(s)',
    explain:     'Explain the page(s)',
    keypoints:   'Extract key points from the page(s)',
    actionitems: 'Find action items on the page(s)',
    selection:   'Explain selected text',
  };

})();
