/**
 * content/content-script.js
 *
 * Injected on demand (via chrome.scripting.executeScript) when the user
 * interacts with the extension. Never runs automatically.
 *
 * Handles two messages from the background service worker:
 *   { action: 'getContent' }   → returns readable page text
 *   { action: 'getSelection' } → returns currently selected text
 */

(function() {
  // Idempotency guard: if this script is injected again into the same page
  // (e.g. on a second quick-action click) we skip re-registration.
  if (window.__pageAssistantLoaded) return;
  window.__pageAssistantLoaded = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'getContent') {
      sendResponse(extractPageContent());
      return false; // synchronous response
    }

    if (message.action === 'getSelection') {
      const selectedText = window.getSelection()?.toString().trim() ?? '';
      sendResponse({ selectedText });
      return false;
    }
  });

  // ─── Page content extraction ──────────────────────────────────────────────────

  const MAX_CHARS = 32_000; // ~8k tokens — generous but bounded

/**
 * Extracts the most readable text from the current page.
 *
 * Strategy:
 *   1. Prefer semantic containers: <main>, <article>, [role="main"]
 *   2. Fall back to <body>
 *   3. Strip noise: scripts, styles, nav, footer, ads, hidden elements
 *   4. Normalise whitespace
 *   5. Truncate to MAX_CHARS
 */
function extractPageContent() {
  // Find the best semantic container
  const CONTAINER_SELECTORS = [
    'main',
    'article',
    '[role="main"]',
    '#content',
    '#main',
    '.content',
    '.main',
    '.post',
    '.article',
  ];

  let container = null;
  for (const sel of CONTAINER_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) { container = el; break; }
  }
  if (!container) container = document.body;

  // Clone so we don't mutate the live DOM
  const clone = container.cloneNode(true);

  // Remove elements that add noise rather than content
  const NOISE = [
    'script', 'style', 'noscript',
    'nav', 'footer', 'aside', 'header',
    '[role="banner"]', '[role="navigation"]', '[role="complementary"]',
    '[aria-hidden="true"]',
    '.ad', '.ads', '.advertisement', '.cookie-banner',
    'iframe', 'svg',
  ].join(', ');
  clone.querySelectorAll(NOISE).forEach(el => el.remove());

  // innerText respects CSS visibility and collapses whitespace naturally
  let text = clone.innerText ?? clone.textContent ?? '';

  // Normalise: collapse 3+ blank lines → 2, strip trailing spaces per line
  text = text
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const truncated  = text.length > MAX_CHARS;
  if (truncated) text = text.slice(0, MAX_CHARS);

  const wordCount  = text.split(/\s+/).filter(Boolean).length;

  return {
    title:     document.title,
    url:       location.href,
    content:   text,
    truncated,
    wordCount,
  };
}

})();
