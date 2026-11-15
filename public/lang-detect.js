// Is a letter written in Yiddish (and not in Hebrew)? Both use the same letters; Yiddish is told by its own common
// words (איז, און, ניט, וואס…) and spellings (וו, יי). Used by the app (which letters "עברית" still lacks) and by
// the server (which letters a translation to Hebrew has to translate).
const YIDDISH = new Set(`איז און ניט נישט וואס ווי וועט וועלן וועלכע דער דאס דעם דיין מיט פון פאר האט האבן האב צו אויף אויך אונז
אונזער אייער זייער זיין זיינען זענען זאל זאלן קען קענען מען מיר איך ער זי זיי אלע אלץ געווען געוואָרן ווערן ווערט
ביז נאר נאך שוין יעדער יעדן ווייל אזוי אזא אדער אבער ווען וויל ווילן איבער אונטער ארויס אריין דארף דארפן געבן נעמען
גוט גרויס קליין טאג יאר הייסט הייבן ליב ליבע ביי מער זאגן געזאגט וועגן דורך צוליב`.split(/\s+/));

/** Share of the words that are Yiddish-only. */
export function yiddishShare(text) {
  const words = String(text || '').normalize('NFC').replace(/[֑-ׇ]/g, '').match(/[א-תײױװ]+/g) || [];
  if (!words.length) return 0;
  const hits = words.filter((w) => YIDDISH.has(w) || /[ײױװ]/.test(w) || /^(גע|פאר|צו)[א-ת]{3,}(ט|ן|ען)$/.test(w) && /וו|יי|אָ/.test(w)).length;
  return hits / words.length;
}

// pure Yiddish letters score 0.2–0.4; Hebrew letters with a Yiddish phrase in them stay well under 0.1
export const isYiddish = (text) => yiddishShare(text) >= 0.14;
