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
  LANGUAGE_BAD: 'שפה לא מוכרת.',
  NOTHING_TO_TRANSLATE: 'אין עדיין ניתוח לתרגום.',
  PHOTO_BAD: 'הקובץ אינו תמונה שאפשר לקרוא. מחקו וטענו תמונה אחרת.',
  PHOTO_NOT_IGROT: 'נראה שזה אינו צילום של עמוד מאגרות קודש. מחקו את התמונה וטענו צילום של עמוד מהספר.',
  PHOTO_UNREADABLE: 'לא הצלחנו לקרוא את מספרי האגרות בצילום. מחקו וצלמו שוב – עמוד שלם, ישר ומואר, כך שמספר האגרת ייראה בבירור.',
  PHOTO_NOT_FOUND: 'מספרי האגרות שנקראו בצילום לא נמצאו במאגר. מחקו וצלמו שוב, כך שמספר האגרת ייראה בבירור.',
  VOICE_BAD: 'ההקלטה אינה בפורמט מוכר. נסו להקליט שוב.',
  VOICE_EMPTY: 'לא נשמע דיבור ברור בהקלטה. מחקו ונסו להקליט שוב.',
  VOICE_NOT_CONFIGURED: 'המרת הקלטה לטקסט אינה מוגדרת בשרת (חסר מפתח Gemini).',
};

export function userMessage(err) {
  const code = err?.message || '';
  if (MESSAGES[code]) {
    const status = /^(LETTER|QUESTION|PAGE|LANGUAGE|NOTHING|PHOTO|VOICE_(BAD|EMPTY))/.test(code) ? 400 : code === 'AI_RATE_LIMIT' ? 429 : 503;
    return { status, code, message: MESSAGES[code] };
  }
  if (err?.status === 429) return { status: 429, code: 'AI_RATE_LIMIT', message: MESSAGES.AI_RATE_LIMIT };
  if (code.startsWith('SOURCE_HTTP_')) return { status: 502, code, message: 'לא ניתן היה להוריד את האגרת מהמאגר המקוון. נסו שוב.' };
  // errors from the AI provider (Gemini / Claude): say what went wrong, without any key
  const providerStatus = Number(err?.status || err?.code);
  if (providerStatus >= 400 && providerStatus < 600) {
    let detail = String(err?.message || '');
    try { detail = JSON.parse(detail.slice(detail.indexOf('{'))).error?.message || detail; } catch { /* plain text */ }
    detail = detail.replace(/AIza[\w-]{20,}/g, '…').replace(/sk-ant-[\w-]+/g, '…').slice(0, 300);
    const hint = providerStatus === 400 && /api key|API_KEY/i.test(detail) ? 'מפתח ה-API של Gemini אינו תקין. '
      : providerStatus === 403 ? 'אין הרשאה לשירות ה-AI (בדקו את המפתח וההגדרות). '
        : providerStatus === 404 ? 'מודל ה-AI שהוגדר לא נמצא. '
          : providerStatus === 429 ? 'מכסת הבקשות החינמית נוצלה זמנית. '
            : providerStatus === 503 ? 'שירות ה-AI עמוס כרגע (בכל המודלים שנוסו). נסו שוב בעוד כמה דקות. ' : '';
    const message = hint && providerStatus >= 429 ? hint.trim() : `${hint}שגיאה משירות ה-AI (${providerStatus}): ${detail}`;
    return { status: providerStatus === 429 ? 429 : 502, code: 'AI_PROVIDER_ERROR', message };
  }
  return { status: 500, code: 'INTERNAL', message: 'אירעה שגיאה. נסו שוב בעוד רגע.' };
}
