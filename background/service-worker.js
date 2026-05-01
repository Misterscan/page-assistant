/**
 * background/service-worker.js
 *
 * ES-module background service worker (MV3).
 * Owns all AI calls — the popup never touches the API key directly.
 *
 * Message contract (from popup → service worker):
 *   {
 *     action:              'analyze',
 *     task:                'summarize' | 'explain' | 'keypoints' |
 *                          'actionitems' | 'selection' | 'custom',
 *     question:            string | null,   // required for 'custom'
 *     conversationHistory: GeminiContent[], // may be empty array
 *     tabId:               number,
 *   }
 *
 * Response (service worker → popup):
 *   Success: { success: true,  answer, userMessageText, pageTitle, truncated }
 *   Failure: { success: false, error: string }
 */

import { callGemini } from '../api/gemini.js';

const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Setup side panel behavior to open on action click if sidePanel is supported
if (browserAPI.sidePanel && browserAPI.sidePanel.setPanelBehavior) {
  browserAPI.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error(error));
} else if (browserAPI.action && browserAPI.action.onClicked) {
  // Fallback for browsers (like Opera) that don't support sidePanel and
  // don't have a default_popup set. Open as a standalone popup window.
  browserAPI.action.onClicked.addListener((tab) => {
    browserAPI.windows.create({
      url: browserAPI.runtime.getURL("popup/popup.html"),
      type: "popup",
      width: 425,
      height: 650
    });
  });
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_SYSTEM_INSTRUCTION = `\
### ROLE: PAGE ASSISTANT (AI WEB COPILOT)
Act as **Page Assistant**, a sophisticated, high-context digital companion. Your goal is to transform raw web data into intuitive, human-centric intelligence. While your foundation is technical precision, your delivery should feel like a brilliant researcher presenting findings to a colleague—insightful, articulate, and engaging.

### OPERATIONAL PROTOCOL
1.  **Deep Immersion**: Analyze [PAGE_CONTENT] to grasp not just the text, but the underlying intent and structure.
2.  **Targeted Reconnaissance**: If [PAGE_CONTENT] lacks the necessary depth, execute a surgical Google Search strictly confined to the domain/path of [CONTEXT_URL].
3.  **Creative Synthesis**: Merge data points into a cohesive narrative. Do not simply list facts; connect the dots to provide a "big picture" understanding of the [USER_QUERY].
4.  **Intellectual Honesty**: If the required information is genuinely absent from both [PAGE_CONTENT] and the [CONTEXT_URL] scope, pivot gracefully. State: "The current page and domain data don't explicitly cover [TOPIC], though they focus heavily on [RELATED TOPIC]."

### VOICE & TONE GUIDELINES
- **Human-Centric**: Use a natural, fluid prose style. Avoid the "robotic list" feel unless the query specifically demands a checklist.
- **Analytical Flair**: You are encouraged to offer logical inferences and highlight interesting patterns found within the data.
- **Active Engagement**: Use active verbs and direct address.
- **Precision over Fluff**: "Human-like" does not mean "wordy." Be concise, but let your personality show through sophisticated vocabulary and varied sentence structure.

### NEGATIVE CONSTRAINTS
- **NO HALLUCINATION**: Never fabricate data, links, or quotes.
- **NO GENERIC WEB SEARCH**: Stay within the walled garden of [CONTEXT_URL].
- **NO CLICHÉS**: Avoid "As an AI..." or "I'm here to help." Jump straight into the value.
- **NO EXTERNAL OVERREACH**: Do not use training data that contradicts the specific facts found in the provided sources.

### OUTPUT ARCHITECTURE
- **Headers**: Use '###' for logical section breaks.
- **Emphasis**: Use **bolding** for critical insights and 'code blocks' for technical identifiers/UI elements.
- **Visual Flow**: Use bullet points for features/specs, but use paragraphs for synthesis and context.
- **Callouts**: Use '> Quote' blocks for direct excerpts from the page that prove a point.

### INPUT PARAMETERS
- **[PAGE_CONTENT]**: Raw data from the active browser tab.
- **[CONTEXT_URL]**: The authoritative domain for scoped search operations.
- **[USER_QUERY]**: The human intent/question to be resolved.

### EXECUTION
Evaluate [USER_QUERY] against the backdrop of [PAGE_CONTENT] and [CONTEXT_URL]. Deliver a response that is technically flawless yet reads with the nuance and clarity of a subject matter expert.`;

/** Build the user-turn text for each task type. */
const buildPrompt = {
  summarize:   (content)           => `Summarize this page in 5-7 concise bullet points:\n\n${content}`,
  explain:     (content)           => `Explain what the page(s) are about in plain, simple language a non-expert would understand:\n\n${content}`,
  keypoints:   (content)           => `Extract the most important key points from the page(s) as a bullet list:\n\n${content}`,
  actionitems: (content)           => `Find all action items, tasks, deadlines, or next steps mentioned on the page(s). If none exist, say so clearly:\n\n${content}`,
  selection:   (selectedText)      => `Explain the following selected text:\n\n"${selectedText}"`,
  custom:      (content, question) => `${question}\n\nPage content:\n${content}`,
  followup:    (question)          => question,
};

// ─── Message listener ─────────────────────────────────────────────────────────

// Must be registered synchronously at top level (MV3 requirement).
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action !== 'analyze') return false;

  handleAnalyze(message)
    .then(sendResponse)
    .catch(err => sendResponse({ success: false, error: err.message ?? 'Unknown error.' }));

  return true; // keep the message channel open for the async response
});

// ─── Core handler ─────────────────────────────────────────────────────────────

async function handleAnalyze({ task, question, conversationHistory, tabId }) {
  // 1. Inject the content script (idempotent — the script self-guards)
  let currentUrl = '';
  try {
    const tab = await browserAPI.tabs.get(tabId);
    currentUrl = tab.url || '';
  } catch {}

  try {
    await browserAPI.scripting.executeScript({
      target: { tabId },
      files:  ['content/content-script.js'],
    });
  } catch {
    // Proceed anyway to allow Gemini to work via URL search
  }

  // 2. Fetch page content or selected text from the content script
  const isFirstMessage = conversationHistory.length === 0;
  const isSelection    = task === 'selection';

  let pageData = null;
  if (isFirstMessage || isSelection) {
    try {
      pageData = await browserAPI.tabs.sendMessage(tabId, {
        action: isSelection ? 'getSelection' : 'getContent',
      });
    } catch {
      // Fallback
    }
  }

  // 3. Validate extracted content
  if (isSelection) {
    if (!pageData?.selectedText) {
      return {
        success: false,
        error: 'No text is selected. Please highlight some text on the page first, then click "Explain Selection".',
      };
    }
  } else if (isFirstMessage && !pageData?.content?.trim()) {
    pageData = { content: `[No readable text found directly on the page, but the URL is ${currentUrl}]` };
  }

  // 4. Build the user-turn text for this message
  let userMessageText;

  if (isSelection) {
    userMessageText = buildPrompt.selection(pageData.selectedText);
  } else if (isFirstMessage) {
    const content = pageData.content;
    userMessageText = task === 'custom'
      ? buildPrompt.custom(content, question ?? '')
      : buildPrompt[task](content);
    // Give model the URL to crawl if it needs to
    userMessageText = `Current Page URL (feel free to search this site): ${currentUrl}\n\n${userMessageText}`;
  } else {
    // Follow-up turn: the model already has page context from the conversation history
    userMessageText = buildPrompt.followup(question ?? `Please ${task} this page.`);
  }

  // 5. Assemble the full multi-turn contents array
  const contents = [
    ...conversationHistory,
    { role: 'user', parts: [{ text: userMessageText }] },
  ];

  // 6. Call the Gemini API
  const prefs = await chrome.storage.local.get('systemInstruction');
  const systemInstruction = prefs.systemInstruction || DEFAULT_SYSTEM_INSTRUCTION;

  const response = await callGemini({ contents, systemInstruction });

  return {
    success:         true,
    answer:          response.text,
    usage:           response.usage,
    userMessageText,
    pageTitle:       pageData?.title  ?? null,
    truncated:       pageData?.truncated ?? false,
  };
}
