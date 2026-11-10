const MESSAGES = {
  LETTER_EMPTY: 'נא לכתוב את המכתב לפני השליחה.',
  LETTER_TOO_LONG: 'המכתב ארוך מדי (עד 8,000 תווים).',
  CATALOG_EMPTY: 'קטלוג האגרות ריק בשרת (npm run catalog).',
  SOURCE_BAD_RESPONSE: 'המאגר המקוון החזיר תשובה לא צפויה. נסו שוב.',
  SOURCE_EMPTY_LETTER: 'האגרת שנבחרה ריקה במאגר. נסו שוב.',
  AI_REFUSED: 'לא ניתן היה להפיק הסבר למכתב זה.',
  AI_NOT_CONFIGURED: 'ההסבר והניתוח אינם מוגדרים בשרת עדיין (חסר מפתח Gemini).',
  AI_EMPTY: 'לא התקבל הסבר. נסו שוב.',
  AI_RATE_LIMIT: 'יותר מדי בקשות לניתוח. נסו שוב בעוד כמה דקות.',
  PAGE_NOT_FOUND: 'העמוד לא נמצא.',
  QUESTION_EMPTY: 'נא לכתוב שאלה.',
  AI_TRUNCATED: 'ההסבר נקטע. נסו שוב.',
};

export function userMessage(err) {
  const code = err?.message || '';
  if (MESSAGES[code]) {
    const status = /^(LETTER|QUESTION|PAGE)/.test(code) ? 400 : code === 'AI_RATE_LIMIT' ? 429 : 503;
    return { status, code, message: MESSAGES[code] };
  }
  if (err?.status === 429) return { status: 429, code: 'AI_RATE_LIMIT', message: MESSAGES.AI_RATE_LIMIT };
  if (code.startsWith('SOURCE_HTTP_')) return { status: 502, code, message: 'לא ניתן היה להוריד את האגרת מהמאגר המקוון. נסו שוב.' };
  return { status: 500, code: 'INTERNAL', message: 'אירעה שגיאה. נסו שוב בעוד רגע.' };
}
