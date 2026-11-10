// Chooses the AI provider: AI_PROVIDER=gemini|claude, or whichever has a key (Gemini first).
import { explainAnswer, followUpClaude, claudeAvailable } from './explain.js';
import { explainWithGemini, followUpWithGemini, geminiAvailable } from './gemini.js';

export function provider() {
  const wanted = process.env.AI_PROVIDER;
  if (wanted === 'claude' || wanted === 'gemini') return wanted;
  if (geminiAvailable()) return 'gemini';
  if (claudeAvailable()) return 'claude';
  return null;
}

export async function analyzePage(input) {
  const p = provider();
  if (!p) throw new Error('AI_NOT_CONFIGURED');
  return { ...(p === 'gemini' ? await explainWithGemini(input) : await explainAnswer(input)), provider: p };
}

export async function followUp(input) {
  const p = provider();
  if (!p) throw new Error('AI_NOT_CONFIGURED');
  return { answer: p === 'gemini' ? await followUpWithGemini(input) : await followUpClaude(input), provider: p };
}
