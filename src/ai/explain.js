import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { config } from '../config.js';

export const AnswerSchema = z.object({
  sourceLanguage: z.enum(['hebrew', 'yiddish', 'english', 'russian', 'other']),
  replyLanguage: z.string(),
  transcription: z.string(),
  translation: z.string(),
  explanation: z.string(),
  keyQuote: z.string(),
});

const jsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['sourceLanguage', 'replyLanguage', 'transcription', 'translation', 'explanation', 'keyQuote'],
  properties: {
    sourceLanguage: { type: 'string', enum: ['hebrew', 'yiddish', 'english', 'russian', 'other'], description: 'השפה העיקרית של האגרת בעמוד' },
    replyLanguage: { type: 'string', description: 'קוד השפה (ISO 639-1) שבה נכתבו translation ו-explanation' },
    transcription: { type: 'string', description: 'העתקה נאמנה של טקסט האגרת/ות בעמוד, בשפת המקור' },
    translation: { type: 'string', description: 'תרגום מלא לשפת המענה. אם המקור כבר בשפת המענה – מחרוזת ריקה' },
    explanation: { type: 'string', description: 'הסבר כיצד המענה עשוי להתייחס למה שנכתב במכתב' },
    keyQuote: { type: 'string', description: 'משפט קצר מתוך האגרת (בתרגום) שהוא לב המענה' },
  },
};

const SYSTEM = `אתה מסייע לאדם שכתב מכתב לרבי מליובאוויטש, ובתשובה נפתח עבורו עמוד אקראי מתוך "אגרות קודש".
המשימה:
1. קרא את עמוד ה-PDF המצורף (סריקה) והעתק את טקסט האגרת/ות שבו בשפת המקור. אם העמוד מכיל סוף אגרת אחת ותחילת אחרת – העתק את שתיהן וציין זאת.
2. אם האגרת אינה בשפת המענה (בפרט כשהיא באידיש) – תרגם אותה במלואה, בנאמנות ובלשון מכובדת.
3. כתוב הסבר חם, ענייני ולא מפריז: אילו נקודות באגרת עשויות להתייחס למה שהכותב שיתף, ואיזה כיוון מעשי עולה מהן. אל תמציא דברים שאינם כתובים, אל תציג פרשנות כנבואה, ואל תפסוק הלכה – כשעולה שאלה הלכתית, רפואית או משפטית, הפנה בעדינות לרב, לרופא או לאיש מקצוע.
4. שמור על כבוד ודרך ארץ. אם קטע בסריקה אינו קריא – כתוב [לא ברור] ואל תנחש.
החזר JSON בלבד לפי הסכמה.`;

let client;
const getClient = () => (client ??= new Anthropic());

/**
 * Reads the page, translates it when needed and explains how it may answer the letter.
 * @param {{ letter: string, pdf: Buffer, replyLanguage?: string, volume: number, page: number }} input
 */
export async function explainAnswer({ letter, pdf, replyLanguage, volume, page }) {
  const langLine = replyLanguage
    ? `שפת המענה: ${replyLanguage}.`
    : 'שפת המענה: השפה שבה נכתב המכתב.';

  const response = await getClient().beta.messages.create({
    model: config.claude.model,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: {
      effort: config.claude.effort,
      format: { type: 'json_schema', schema: jsonSchema },
    },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') },
          title: `אגרות קודש, כרך ${volume}, עמוד ${page}`,
        },
        { type: 'text', text: `${langLine}\n\nהמכתב שנכתב לרבי:\n"""\n${letter}\n"""` },
      ],
    }],
  });

  if (response.stop_reason === 'refusal') throw new Error('AI_REFUSED');
  if (response.stop_reason === 'max_tokens') throw new Error('AI_TRUNCATED');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return AnswerSchema.parse(JSON.parse(text));
}
