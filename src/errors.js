const MESSAGES = {
  LETTER_EMPTY: 'נא לכתוב את המכתב לפני השליחה.',
  LETTER_TOO_LONG: 'המכתב ארוך מדי (עד 8,000 תווים).',
  CATALOG_EMPTY: 'מאגר הכרכים עדיין לא הוגדר בשרת (data/volumes.json).',
  SOURCE_NOT_PDF: 'המאגר המקוון החזיר תוכן שאינו PDF. נסו שוב.',
  AI_REFUSED: 'לא ניתן היה להפיק הסבר למכתב זה.',
  AI_TRUNCATED: 'ההסבר נקטע. נסו שוב.',
};

export function userMessage(err) {
  const code = err?.message || '';
  if (MESSAGES[code]) return { status: code.startsWith('LETTER') ? 400 : 503, code, message: MESSAGES[code] };
  if (code.startsWith('SOURCE_HTTP_')) return { status: 502, code, message: 'לא ניתן היה להוריד את העמוד מהמאגר המקוון. נסו שוב.' };
  return { status: 500, code: 'INTERNAL', message: 'אירעה שגיאה. נסו שוב בעוד רגע.' };
}
