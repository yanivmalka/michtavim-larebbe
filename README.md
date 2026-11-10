# מכתבים לרבי

אפליקציית ווב (מותאמת לנייד ולמחשב, ניתנת להתקנה כאפליקציה – PWA) שבה כותבים מכתב לרבי בממשק בסגנון וואטסאפ.
בתשובה המערכת:

1. **פותחת את הספר במקום אקראי** (כמנהג הכנסת המכתב לכרך של אגרות קודש) – מתוך 11,062 האגרות שבכרכים א–כח ב[ספריית ליובאוויטש](https://chabadlibrary.org/books/1200000000), ומציגה **תמונה של העמוד** שנפתח: יכולים להופיע בו סוף אגרת קודמת, אגרות שלמות ותחילת האגרת הבאה.
2. מאפשרת להוריד את העמוד כ-**PDF**, ולפתוח כל אחת מהאגרות שבעמוד במלואה (טקסט ו-PDF, כולל ההערות).
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

**איך נבנה העמוד:** במקור המקוון יש את טקסט האגרות אך לא את חלוקת העמודים של הספר המודפס, ולכן העמוד מדומה: נבחרת נקודה אקראית בתוך אגרת אקראית, העמוד מתחיל עד כאורך עמוד אחד לפניה (ואז עשוי להתחיל באמצע אגרת קודמת), ומנוע העימוד ממלא עמוד אחד בגודל עמוד ספר. לכן התוכן ורצף האגרות זהים לספר, אבל שבירת השורות והעמודים אינה זהה לדפוס. הערות השוליים אינן מוצגות בתמונת העמוד, אלא באגרת המלאה.

הטקסט נלקח מ-API של ספריית ליובאוויטש (`https://chabadlibrary.org/books/api/main?path=<id>`).
הקובץ `data/catalog.json` מכיל את מזהי כל האגרות (כרך ← מספר אגרת), ומשמש להגרלה. כדי לרענן אותו (אם נוספים כרכים באתר):

```bash
npm run catalog
```

**לימוד אורכי האגרות:** כל אגרת שהשרת מוריד (לכל משתמש) נמדדת, ואורכה נשמר בקובץ משותף לכל המשתמשים (`.cache/letter-lengths.json`, או הנתיב שב-`LENGTHS_FILE`). הידע נשמר גם אחרי הפעלה מחדש, ומצבו מוצג ב-`GET /api/stats`. כרגע ההגרלה עדיין נותנת לכל אגרת סיכוי שווה; הידע הזה מיועד לשקלול לפי אורך בהמשך (כמו בספר אמיתי), בלי הורדות נוספות. בשרת אירוח יש להפנות את `LENGTHS_FILE` לדיסק קבוע, אחרת הקובץ נמחק בכל פריסה.

> לפני העלאה לאוויר מומלץ לבדוק את תנאי השימוש של ספריית ליובאוויטש, ואם אפשר – לתאם איתם. השרת פונה לאתר רק לאגרת אחת בכל מכתב.

## API

`POST /api/letters`

```json
{ "letter": "טקסט המכתב", "replyLanguage": "he" }
```

`replyLanguage` אופציונלי (קוד ISO בן 2 אותיות). תשובה:

```json
{
  "id": "…", "volume": 15, "volumeHeading": "כרך טו",
  "title": "אגרות קודש, כרך טו, אגרות ה'שע, ה'שעא",
  "imagePath": "/api/answers/<id>/page.png",
  "pdfPath": "/api/answers/<id>/page.pdf",
  "letters": [
    { "number": "ה'שע", "startsOnPage": false, "endsOnPage": true,
      "pageText": "החלק שבעמוד", "fullText": "האגרת המלאה",
      "viewerUrl": "https://chabadlibrary.org/books/…", "pdfPath": "/api/answers/<id>/letters/0.pdf" }
  ],
  "sourceLanguage": "hebrew", "replyLanguage": "he",
  "translation": "…", "explanation": "…", "keyQuote": "…"
}
```

`GET /api/answers/<id>/page.png` – תמונת העמוד; `page.pdf` – העמוד כ-PDF; `letters/<n>.pdf` – אגרת מלאה. נשמרים בזיכרון השרת (300 התשובות האחרונות).

## WhatsApp Business

1. יוצרים אפליקציה ב-Meta for Developers עם מוצר WhatsApp, ומעתיקים ל-`.env`:
   `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, ובוחרים `WHATSAPP_VERIFY_TOKEN`.
2. מגדירים `PUBLIC_BASE_URL` לכתובת HTTPS ציבורית של השרת (וואטסאפ מוריד את ה-PDF מכתובת זו).
3. כתובת ה-Webhook: `https://<השרת>/webhooks/whatsapp` (מנויים לשדה `messages`).

הודעת טקסט נכנסת ← אישור קבלה ← תמונת העמוד ← הודעה עם ציטוט, תרגום, הסבר וקישור ל-PDF.

## מבנה

```
src/
  app.js              Express: API, קבצים סטטיים, webhook
  letters.js          הליבה המשותפת (ווב + וואטסאפ)
  igrot/catalog.js    טעינת הקטלוג
  igrot/chabadlibrary.js  הורדת אגרת מספריית ליובאוויטש ופירוקה
  igrot/openBook.js   "פתיחת הספר": בניית העמוד שנפתח
  render/bookPage.js  ציור עמוד בסגנון ספר (PNG) והפיכה ל-PDF
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
