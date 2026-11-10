# מכתבים לרבי

אפליקציית ווב (מותאמת לנייד ולמחשב, ניתנת להתקנה כאפליקציה – PWA) שבה כותבים מכתב לרבי בממשק בסגנון וואטסאפ.
בתשובה המערכת:

1. פותחת עמוד אקראי מתוך **אגרות קודש** (כמנהג פתיחת אגרות קודש) ומורידה אותו כקובץ PDF ממאגר מקוון.
2. קוראת את העמוד (Claude, כולל סריקות), מעתיקה את נוסח המקור.
3. אם המענה **באידיש** (או בכל שפה אחרת משפת המענה) – מתרגמת לעברית או לשפה שהמשתמש בחר (ברירת מחדל: השפה שבה נכתב המכתב).
4. מציגה הסבר כיצד מה שנכתב במכתב עשוי לקבל התייחסות במענה.

אותו מנגנון חשוף גם כ-**API** וכ-**Webhook ל-WhatsApp Business (Cloud API)**.

## הרצה

```bash
npm install
cp .env.example .env   # ולמלא ANTHROPIC_API_KEY
npm start              # http://localhost:3000
npm test
```

## הגדרת המאגר – חובה לפני שימוש

הקובץ `data/volumes.json` מכיל 33 כרכים, **ללא מזהים**. יש למלא לכל כרך:

| שדה | משמעות |
|---|---|
| `sourceId` | מזהה הספר במאגר המקוון (למשל מספר `req` של הכרך ב-hebrewbooks.org) |
| `firstLetterPage` / `lastLetterPage` | טווח עמודי ה-PDF שבהם מופיעות האגרות (בלי שער, הקדמה ומפתחות) |

כרך שלא מולא לא ייבחר. תבניות הכתובות של המאגר מוגדרות ב-`.env`:

- `IGROT_PAGE_PDF_URL` – כתובת להורדת עמוד בודד כ-PDF (`{id}`, `{page}`)
- `IGROT_VIEWER_URL` – קישור לצפייה בעמוד באתר המקור

> ⚠️ ברירות המחדל מכוונות לתבנית הכתובות של hebrewbooks.org, אבל **לא נבדקו מול האתר** (לא הייתה גישה אליו מסביבת הפיתוח). יש לוודא אותן ואת תנאי השימוש של האתר לפני העלאה לאוויר.

**חלופה:** `IGROT_SOURCE=local` – מניחים קבצי PDF מלאים בתיקייה `data/pdfs` בשמות `vol-01.pdf`, `vol-02.pdf`... והמערכת חותכת מהם את העמוד.

## API

`POST /api/letters`

```json
{ "letter": "טקסט המכתב", "replyLanguage": "he" }
```

`replyLanguage` אופציונלי (קוד ISO בן 2 אותיות). תשובה:

```json
{
  "id": "…", "volume": 12, "page": 345,
  "pdfPath": "/api/answers/<id>.pdf", "viewerUrl": "https://…",
  "sourceLanguage": "yiddish", "replyLanguage": "he",
  "transcription": "…", "translation": "…", "explanation": "…", "keyQuote": "…"
}
```

`GET /api/answers/<id>.pdf` – קובץ העמוד (נשמר בזיכרון השרת, עד 500 אחרונים).

## WhatsApp Business

1. יוצרים אפליקציה ב-Meta for Developers עם מוצר WhatsApp, ומעתיקים ל-`.env`:
   `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, ובוחרים `WHATSAPP_VERIFY_TOKEN`.
2. מגדירים `PUBLIC_BASE_URL` לכתובת HTTPS ציבורית של השרת (וואטסאפ מוריד את ה-PDF מכתובת זו).
3. כתובת ה-Webhook: `https://<השרת>/webhooks/whatsapp` (מנויים לשדה `messages`).

הודעת טקסט נכנסת ← אישור קבלה ← קובץ ה-PDF של העמוד ← הודעה עם ציטוט, תרגום והסבר.

## מבנה

```
src/
  app.js              Express: API, קבצים סטטיים, webhook
  letters.js          הליבה המשותפת (ווב + וואטסאפ)
  igrot/catalog.js    טעינת הכרכים והגרלת עמוד
  igrot/source.js     הורדת עמוד (remote) או חיתוך מ-PDF מקומי (local)
  ai/explain.js       Claude: העתקה, תרגום, הסבר (JSON מובנה)
  whatsapp/webhook.js WhatsApp Cloud API
public/               ממשק הצ'אט (RTL, PWA)
data/volumes.json     קטלוג הכרכים
```

## הערות

- המודל: `claude-opus-5-5` (ניתן לשינוי ב-`CLAUDE_MODEL`). מופעל fallback בצד השרת (`fallbacks: "default"`) כך שבמקרה של סירוב הבקשה ממשיכה במודל חלופי.
- ההסבר מוצג כהצעה להבנה בלבד ואינו פסק הלכה; ההנחיה למודל היא לא להמציא תוכן שאינו בעמוד ולסמן קטעים לא קריאים.
- היסטוריית השיחה נשמרת רק במכשיר המשתמש (localStorage).
