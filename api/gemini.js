/**
 * api/gemini.js
 * Thin wrapper around the Gemini REST API.
 * Imported only by the background service worker (ES module context).
 */

import GEMINI_API_KEY from '../config.js';

const MODEL   = 'gemini-3.1-flash-lite-preview';
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

/**
 * Call the Gemini generateContent endpoint with a full multi-turn conversation.
 *
 * @param {object} params
 * @param {Array<{role: string, parts: Array<{text: string}>}>} params.contents
 *   Full conversation in Gemini multi-turn format.
 *   The last entry should be the new user message.
 * @param {string} params.systemInstruction
 *   System-level instruction (developer role, not part of the conversation turns).
 *
 * @returns {Promise<{text: string, usage: object}>} An object with the assistant's plain-text response and usage metadata.
 * @throws {Error}  Descriptive error for HTTP failures, safety blocks, or empty responses.
 */
export async function callGemini({ contents, systemInstruction }) {
  let response;

  try {
    response = await fetch(`${API_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        systemInstruction: {
          parts: [{ text: systemInstruction }],
        },        tools: [{
          googleSearch: {}
        }],        generationConfig: {
          maxOutputTokens: 2048,
          temperature: 0.7,
        },
      }),
    });
  } catch (networkErr) {
    throw new Error('Network error — check your internet connection.');
  }

  if (!response.ok) {
    let message = `Gemini API error (HTTP ${response.status})`;
    try {
      const body = await response.json();
      if (body?.error?.message) message = body.error.message;
    } catch { /* ignore parse errors */ }
    throw new Error(message);
  }

  const data = await response.json();

  // Safety block at prompt level
  if (data.promptFeedback?.blockReason) {
    throw new Error(`Request blocked by Gemini safety filters: ${data.promptFeedback.blockReason}`);
  }

  const candidate = data.candidates?.[0];
  if (!candidate) {
    throw new Error('Gemini returned no candidates. Try rephrasing your question.');
  }

  // Safety block at candidate level
  if (candidate.finishReason === 'SAFETY') {
    throw new Error('Response blocked by Gemini safety filters.');
  }

  // Concatenate all text parts (handles split responses)
  const text = candidate.content?.parts
    ?.filter(p => p.text)
    .map(p => p.text)
    .join('') ?? '';

  if (!text.trim()) {
    throw new Error('Gemini returned an empty response. Try again.');
  }

  return {
    text,
    usage: data.usageMetadata || null
  };
}
