# Page Assistant

A Chrome Extension that acts as an AI copilot for any web page you're viewing.
Ask questions, get summaries, extract key information, and have follow-up
conversations — all powered by **Google Gemini 3.1 Flash-Lite**.

---

## Features

- **Side Panel Interface** — Stays open alongside your browser while you browse different tabs
- **Summarize** — Get a concise 5-7 bullet summary of any page
- **Explain** — Plain-language explanation for non-experts
- **Key Points** — The most important takeaways, as a bullet list
- **Action Items** — Surfaces tasks, deadlines, and next steps
- **Explain Selection** — Highlight any text on the page and get an instant explanation
- **Multi-page Crawling** — Automatically follows "Next" pagination links to read up to 10 consecutive pages (ideal for forum threads and long articles)
- **Ask anything** — Type a custom question and have a multi-turn conversation
- **Google Search Fallback** — Can browse via Google Search if direct page scraping fails
- **Persistent History** — Your conversations are stored per session, so you never lose context
- **Markdown Rendering** — Full support for bold, lists, and code blocks using `marked.js` and `DOMPurify`
- **Conversation Export** — Download your chats as Markdown
- **Token Counter** — Shows exactly how many tokens Gemini used
- **Custom System Prompt** — Tweak the assistant's persona via the extension options page
- **Fast Shortcut** — Accessible quickly via `Cmd/Ctrl+Shift+P`
- **Auto dark/light theme** — Follows your system preference

---

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or later (only needed for setup)
- Chrome 116 or later
- A [Gemini API key](https://aistudio.google.com/apikey) (free tier available)

### Steps

**1. Clone or download this repository**

```
cd page-assistant
```

**2. Run the setup script**

```bash
node setup.js
```

The script will:
- Generate the extension icon files (`icons/icon16.png`, `icon48.png`, `icon128.png`)
- Prompt you to paste your Gemini API key
- Write `config.js` (gitignored — never committed)

> **Tip:** You can also pass your key directly:
> `node setup.js YOUR_API_KEY_HERE`

**3. Load the extension in Chrome**

1. Open `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select this folder (`page-assistant`)

**4. Use it**

Click the **Page Assistant** icon in your Chrome toolbar while on any webpage.

---

## How It Works

### Architecture

```
┌─────────────────────────────────────────────────────┐
│  Chrome Extension                                   │
│                                                     │
│  ┌──────────────┐      ┌──────────────────────────┐ │
│  │  popup.html  │─────▶│  service-worker.js       │ │
│  │  popup.css   │◀─────│  (background ES module)  │ │
│  │  popup.js    │      └──────────┬───────────────┘ │
│  └──────────────┘                 │                 │
│         │                         │ imports         │
│         │ chrome.scripting        │                 │
│         │ .executeScript          ▼                 │
│  ┌──────▼──────────┐    ┌──────────────────────────┐│
│  │ content-script  │    │  api/gemini.js           ││
│  │ (injected on    │    │  (Gemini REST client)    ││
│  │  demand)        │    └─────────┬────────────────┘│
│  └─────────────────┘              │                 │
└───────────────────────────────────┼─────────────────┘
                                    │ HTTPS fetch
                                    ▼
                        generativelanguage.googleapis.com
```

### Message flow

1. **User opens side panel** (via extension icon or Keyboard Shortcut)
2. **User clicks** a quick-action button or types a request
3. **`popup.js`** sends `{ action: 'analyze', task, question, conversationHistory, tabId }` to the service worker
4. **`service-worker.js`** grabs the current tab URL and injects `content-script.js` into the active tab
5. The service worker sends `getContent` (or `getSelection`) to the content script
6. **`content-script.js`** extracts readable text from the page, strips noise elements, and returns it. If this fails due to permissions, it falls back to the URL.
7. The service worker builds a prompt and calls **`api/gemini.js`**
8. `gemini.js` POSTs to `https://generativelanguage.googleapis.com/...gemini-3.1-flash-lite-preview` with Grounding/Google Search enabled.
9. The response and token usage flows back through the service worker to the popup
10. **`popup.js`** saves the history to `chrome.storage.local` and renders the answer with full markdown support (via `marked.js` and `DOMPurify`).

### Privacy design

| Concern | Behaviour |
|---|---|
| Automatic page reading | Never. Content is only extracted after a user action in the Side Panel. |
| Data storage | Conversation history is saved locally via `chrome.storage.local` to persist across sessions but never leaves your computer. |
| What's sent to Google | The page text/URL and your question. |
| Long pages | Scrapes the full active page and automatically follows "next" links to read up to 10 consecutive pages. A Token Count appears when finished.|

### Permissions

| Permission | Reason |
|---|---|
| `sidePanel` | To host the UI persistently alongside standard web browsing. |
| `scripting` | Inject `content-script.js` on demand to extract page text. |
| `storage` | Save conversation history, settings, and custom prompts. |
| `<all_urls>` | Required to allow the Side Panel to run seamlessly as you navigate between tabs. |

---

## File structure

```
page-assistant/
├── manifest.json               # MV3 extension manifest
├── config.js                   # Gitignored — your Gemini API key
├── config.example.js           # Template for config.js
├── setup.js                    # One-time setup: icons + key
├── README.md
│
├── icons/
│   ├── favicon2.ico           # Extension icon 
│   ├── icon16.png              
│   ├── icon48.png
│   └── icon128.png
│
├── popup/
│   ├── popup.html              # Extension popup UI
│   ├── popup.css               # Styles (auto dark/light)
│   └── popup.js                # UI logic, conversation state
│
├── options/
│   ├── options.html            # UI to change the custom system prompt
│   ├── options.css
│   └── options.js
│
├── background/
│   └── service-worker.js       # ES module SW; owns all AI calls
│
├── lib/
│   ├── marked.min.js           # Markdown parser
│   └── purify.min.js           # HTML sanitizer (XSS protection)
│
├── content/
│   └── content-script.js       # Injected on demand; extracts page text
│
└── api/
    └── gemini.js               # Gemini REST client (imported by SW)
```

---

## Updating your API key

Delete `config.js` and re-run `node setup.js`, or edit `config.js` directly.  
After changing the key, reload the extension at `chrome://extensions`.

---

## Future improvements

- **Streaming responses** — Show the answer word-by-word as it arrives using `streamGenerateContent`
- **PDF analysis support** — Send PDF content to Gemini's actual document-processing capability rather than trying to read it
- **Page screenshot context** — Capture a screenshot and include it with the prompt for visual context
- **Voice Output** — Use the Speech synthesis API to read back explanations aloud
