const MESSAGES = {
  LETTER_EMPTY: 'נא לכתוב את המכתב לפני השליחה.',
  LETTER_TOO_LONG: 'המכתב ארוך מדי (עד 8,000 תווים).',
  CATALOG_EMPTY: 'קטלוג האגרות ריק בשרת (npm run catalog).',
  SOURCE_BAD_RESPONSE: 'המאגר המקוון החזיר תשובה לא צפויה. נסו שוב.',
  SOURCE_EMPTY_LETTER: 'האגרת שנבחרה ריקה במאגר. נסו שוב.',
  AI_REFUSED: 'לא ניתן היה להפיק הסבר למכתב זה.',
  AI_TRUNCATED: 'ההסבר נקטע. נסו שוב.',
};

export function userMessage(err) {
  const code = err?.message || '';
  if (MESSAGES[code]) return { status: code.startsWith('LETTER') ? 400 : 503, code, message: MESSAGES[code] };
  if (code.startsWith('SOURCE_HTTP_')) return { status: 502, code, message: 'לא ניתן היה להוריד את האגרת מהמאגר המקוון. נסו שוב.' };
  return { status: 500, code: 'INTERNAL', message: 'אירעה שגיאה. נסו שוב בעוד רגע.' };
}
