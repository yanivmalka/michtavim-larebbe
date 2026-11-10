# מכתבים לרבי

אפליקציית ווב (מותאמת לנייד ולמחשב, ניתנת להתקנה כאפליקציה – PWA) שבה כותבים מכתב לרבי בממשק בסגנון וואטסאפ.
בתשובה המערכת:

1. פותחת **אגרת אקראית** מתוך אגרות קודש של הרבי (כמנהג פתיחת אגרות קודש) – מתוך 11,062 האגרות שבכרכים א–כח ב[ספריית ליובאוויטש](https://chabadlibrary.org/books/1200000000).
2. מפיקה ממנה **קובץ PDF** מעוצב (גופן עברי, ימין לשמאל, כולל הערות השוליים וקישור למקור).
3. אם האגרת **באידיש** (או בכל שפה אחרת משפת המענה) – מתרגמת לעברית או לשפה שהמשתמש בחר (ברירת מחדל: השפה שבה נכתב המכתב).
4. מציגה הסבר כיצד מה שנכתב במכתב עשוי לקבל התייחסות במענה.

אותו מנגנון חשוף גם כ-**API** וכ-**Webhook ל-WhatsApp Business (Cloud API)**.

## הרצה

```bash
npm install
cp .env.example .env   # ולמלא ANTHROPIC_API_KEY
npm start              # http://localhost:3000
npm test
```

## מקור האגרות

הטקסט נלקח מ-API של ספריית ליובאוויטש (`https://chabadlibrary.org/books/api/main?path=<id>`).
הקובץ `data/catalog.json` מכיל את מזהי כל האגרות (כרך ← מספר אגרת), ומשמש להגרלה. כדי לרענן אותו (אם נוספים כרכים באתר):

```bash
npm run catalog
```

> לפני העלאה לאוויר מומלץ לבדוק את תנאי השימוש של ספריית ליובאוויטש, ואם אפשר – לתאם איתם. השרת פונה לאתר רק לאגרת אחת בכל מכתב.

## API

`POST /api/letters`

```json
{ "letter": "טקסט המכתב", "replyLanguage": "he" }
```

`replyLanguage` אופציונלי (קוד ISO בן 2 אותיות). תשובה:

```json
{
  "id": "…", "volume": 10, "volumeHeading": "כרך י", "letterNumber": "ג'סה",
  "title": "אגרות קודש, כרך י, אגרת ג'סה",
  "pdfPath": "/api/answers/<id>.pdf", "viewerUrl": "https://chabadlibrary.org/books/1200840102",
  "original": "נוסח האגרת", "sourceLanguage": "hebrew", "replyLanguage": "he",
  "translation": "…", "explanation": "…", "keyQuote": "…"
}
```

`GET /api/answers/<id>.pdf` – קובץ ה-PDF של האגרת (נשמר בזיכרון השרת, עד 500 אחרונים).

## WhatsApp Business

1. יוצרים אפליקציה ב-Meta for Developers עם מוצר WhatsApp, ומעתיקים ל-`.env`:
   `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, ובוחרים `WHATSAPP_VERIFY_TOKEN`.
2. מגדירים `PUBLIC_BASE_URL` לכתובת HTTPS ציבורית של השרת (וואטסאפ מוריד את ה-PDF מכתובת זו).
3. כתובת ה-Webhook: `https://<השרת>/webhooks/whatsapp` (מנויים לשדה `messages`).

הודעת טקסט נכנסת ← אישור קבלה ← קובץ ה-PDF של האגרת ← הודעה עם ציטוט, תרגום, הסבר וקישור למקור.

## מבנה

```
src/
  app.js              Express: API, קבצים סטטיים, webhook
  letters.js          הליבה המשותפת (ווב + וואטסאפ)
  igrot/catalog.js    טעינת הקטלוג והגרלת אגרת
  igrot/chabadlibrary.js  הורדת אגרת מספריית ליובאוויטש ופירוקה
  pdf/letterPdf.js    הפקת PDF עברי (ימין לשמאל)
  ai/explain.js       Claude: תרגום והסבר (JSON מובנה)
  whatsapp/webhook.js WhatsApp Cloud API
public/               ממשק הצ'אט (RTL, PWA)
data/catalog.json     מזהי כל האגרות (npm run catalog)
assets/fonts/         גופן Frank Ruhl Libre (OFL)
```

## הערות

- המודל: `claude-opus-5-5` (ניתן לשינוי ב-`CLAUDE_MODEL`). מופעל fallback בצד השרת (`fallbacks: "default"`) כך שבמקרה של סירוב הבקשה ממשיכה במודל חלופי.
- ההסבר מוצג כהצעה להבנה בלבד ואינו פסק הלכה; ההנחיה למודל היא להתבסס רק על מה שכתוב באגרת.
- היסטוריית השיחה נשמרת רק במכשיר המשתמש (localStorage).

## אפליקציית אנדרואיד (APK)

תיקיית `android/` היא פרויקט Capacitor שעוטף את ממשק הצ'אט. האפליקציה פונה לשרת שכתובתו `API_BASE_URL`, ולכן קודם צריך להעלות את השרת לכתובת HTTPS ציבורית.

**בנייה אוטומטית ב-GitHub:** בכל push ל-`main` רץ ה-workflow `Android APK` ומעלה את הקובץ `app-debug.apk` ל-Artifacts של הריצה (לשונית Actions). את כתובת השרת מגדירים ב-Settings ← Secrets and variables ← Actions ← Variables, במשתנה `API_BASE_URL`.

**בנייה מקומית** (דורש Android SDK ו-JDK 21):

```bash
API_BASE_URL=https://your-server.example npm run apk
```

הקובץ נוצר ב-`android/app/build/outputs/apk/debug/app-debug.apk`. זהו APK לניפוי שגיאות (debug) שניתן להתקין ישירות בטלפון. להפצה בחנות Google Play צריך לבנות גרסת release חתומה.
