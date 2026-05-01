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
      extractAllPagesContent().then(sendResponse);
      return true; // asynchronous response
    }

    if (message.action === 'getSelection') {
      const selectedText = window.getSelection()?.toString().trim() ?? '';
      sendResponse({ selectedText });
      return false;
    }
  });

  // ─── Page content extraction ──────────────────────────────────────────────────

  function getNextPageUrl(doc, baseUrl, currentPageIndex) {
  // Try to find a pagination link that specifically points to the next consecutive page number
  const targetPageNum = (currentPageIndex + 2).toString();

  const nextSelectors = [
    'link[rel="next"]',
    'a[rel="next"]',
    '.pagination .next',
    '.pagination .next a',
    '.nav-next a',
    '.page-next',
    'a.next',
    'a.pageNav-jump--next', // XenForo
    '.page-nav-next',       // Discourse
    '.pagenav a[rel="next"]'// vBulletin
  ];

  for (const selector of nextSelectors) {
    const el = doc.querySelector(selector);
    const href = el?.getAttribute('href');
    if (href && !href.startsWith('javascript:')) {
      try { return new URL(href, baseUrl).href; } catch (e) {}
    }
  }

  // Fallback: look for text variations of "Next"
  const links = Array.from(doc.querySelectorAll('a'));
  const nextTextVariations = ['next', 'next ›', 'next »', 'next page', 'older posts', 'older', 'older ›', '>', '›', '»', '→'];
  for (const link of links) {
    const text = (link.textContent || '').trim().toLowerCase();
    const href = link.getAttribute('href');
    
    // Check if the link text exactly matches a variation, or contains "next " / " next", or matches the exact target page number
    if ((nextTextVariations.includes(text) || text.includes('next ') || text.includes(' older') || text === targetPageNum) && href && !href.startsWith('javascript:') && href !== '#') {
      try { return new URL(href, baseUrl).href; } catch (e) {}
    }
  }

  return null;
}

async function extractAllPagesContent() {
  const MAX_PAGES = 30; // aggressive limit to pull a lot of forum context
  let currentUrl = location.href;
  let currentDoc = document;
  let combinedContent = '';

  for (let i = 0; i < MAX_PAGES; i++) {
    // Extract current doc text
    const text = extractPageContent(currentDoc);
    combinedContent += `\n\n--- [PAGE ${i + 1}] ---\n\n` + text;

    // Find next page
    const nextUrl = getNextPageUrl(currentDoc, currentUrl, i);
    if (!nextUrl || nextUrl === currentUrl) break; // no next page found, or stuck in a loop

    // Fetch and parse next page
    try {
      const response = await fetch(nextUrl);
      if (!response.ok) break;
      const html = await response.text();
      const parser = new DOMParser();
      currentDoc = parser.parseFromString(html, 'text/html');
      currentUrl = nextUrl;
    } catch {
      break; // error fetching, stop here
    }
  }

  return {
    title: document.title,
    url: location.href,
    content: combinedContent,
    truncated: false
  };
}

/**
 * Extract the most readable text from the current page.
 *
 * Strategy:
 *   1. Prefer semantic containers: <main>, <article>, [role="main"]
 *   2. Fall back to <body>
 *   3. Strip noise: scripts, styles, nav, footer, ads, hidden elements
 *   4. Normalise whitespace
 */
function extractPageContent(doc = document) {
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
    const el = doc.querySelector(sel);
    if (el) { container = el; break; }
  }
  if (!container) container = doc.body;

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

  // Use a recursive text extractor because `innerText` relies on CSS layout engine.
  // When documents are created via DOMParser() for background pages, the browser
  // does not render them, so `clone.innerText` would be completely empty. 
  // `textContent` alone mashes all text together without newlines causing a jumbled mess.
  function extractReadableText(node) {
    if (node.nodeType === 3) return node.nodeValue; // Text node
    if (node.nodeType !== 1) return ''; // Skip non-element nodes (comments, etc)
    
    if (node.nodeName === 'BR') return '\n';
    
    // Block-level elements should force newlines
    const blockTags = new Set(['DIV', 'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TR', 'ARTICLE', 'SECTION', 'MAIN', 'BLOCKQUOTE']);
    let content = '';
    
    for (const child of node.childNodes) {
      content += extractReadableText(child);
    }
    
    if (blockTags.has(node.nodeName)) {
      content += '\n\n';
    }
    
    return content;
  }

  let text = extractReadableText(clone);

  // Normalise: collapse 3+ blank lines → 2, strip trailing spaces per line
  text = text
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

})();
