import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { config } from '../config.js';

export const AnswerSchema = z.object({
  sourceLanguage: z.enum(['hebrew', 'yiddish', 'english', 'russian', 'other']),
  replyLanguage: z.string(),
  translation: z.string(),
  explanation: z.string(),
  keyQuote: z.string(),
});

const jsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['sourceLanguage', 'replyLanguage', 'translation', 'explanation', 'keyQuote'],
  properties: {
    sourceLanguage: { type: 'string', enum: ['hebrew', 'yiddish', 'english', 'russian', 'other'], description: 'השפה העיקרית של האגרת' },
    replyLanguage: { type: 'string', description: 'קוד השפה (ISO 639-1) שבה נכתבו translation, explanation ו-keyQuote' },
    translation: { type: 'string', description: 'תרגום מלא של האגרת לשפת המענה. אם האגרת כבר בשפת המענה – מחרוזת ריקה' },
    explanation: { type: 'string', description: 'הסבר כיצד האגרת עשויה להתייחס למה שנכתב במכתב' },
    keyQuote: { type: 'string', description: 'משפט קצר מתוך האגרת (בשפת המענה) שהוא לב המענה' },
  },
};

const SYSTEM = `אתה מסייע לאדם שכתב מכתב לרבי מליובאוויטש. בתשובה נפתחה עבורו באקראי אגרת מתוך "אגרות קודש", והיא מצורפת.
המשימה:
1. אם האגרת אינה בשפת המענה (בפרט כשהיא באידיש) – תרגם אותה במלואה, בנאמנות ובלשון מכובדת. ראשי תיבות – פתח אותם בתרגום.
2. כתוב הסבר חם, ענייני ולא מפריז: אילו נקודות באגרת עשויות להתייחס למה שהכותב שיתף, ואיזה כיוון מעשי עולה מהן. התבסס רק על מה שכתוב באגרת, ואם הקשר אינו ישיר – אמור זאת בפשטות והצע איזו נקודה כללית אפשר לקחת. אל תציג פרשנות כנבואה ואל תפסוק הלכה; בשאלה הלכתית, רפואית או משפטית – הפנה בעדינות לרב, לרופא או לאיש מקצוע.
3. שמור על כבוד ודרך ארץ. ההסבר באורך של 2–4 פסקאות קצרות.
החזר JSON בלבד לפי הסכמה.`;

let client;
const getClient = () => (client ??= new Anthropic());

/**
 * Translates the letter when needed and explains how it may answer what was written.
 * @param {{ letter: string, igeret: string, replyLanguage?: string, title: string }} input
 */
export async function explainAnswer({ letter, igeret, replyLanguage, title }) {
  const langLine = replyLanguage ? `שפת המענה: ${replyLanguage}.` : 'שפת המענה: השפה שבה נכתב המכתב.';

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
        { type: 'document', source: { type: 'text', media_type: 'text/plain', data: igeret }, title },
        { type: 'text', text: `${langLine}\n\nהמכתב שנכתב לרבי:\n"""\n${letter}\n"""` },
      ],
    }],
  });

  if (response.stop_reason === 'refusal') throw new Error('AI_REFUSED');
  if (response.stop_reason === 'max_tokens') throw new Error('AI_TRUNCATED');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return AnswerSchema.parse(JSON.parse(text));
}
