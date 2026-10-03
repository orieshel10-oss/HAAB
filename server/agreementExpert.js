// Conversational "attendance & absence agreement expert" backing the AI-assist chat in
// agreements.html (both create and edit flows - edit mode is driven entirely by the caller
// seeding the conversation with a synthetic first 'model' turn describing the agreement's
// current state; this module has no edit-specific code path of its own). Stateless by design -
// the caller (the browser) resends the full conversation each turn; this module holds no
// session/DB state. Talks to Google's Gemini API, chosen specifically because it has a genuine
// no-billing-required free tier (see GEMINI_MODEL below for how to swap models/plans later
// without a code change).

// gemini-flash-latest / gemini-3.8-flash return 503 "high demand" fairly often right now (newest
// models, heaviest traffic) - gemini-3.5-flash is a solid, currently-reliable fallback default.
// Override with GEMINI_MODEL any time without a code change.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const SUMMARY_MARKER = '---SUMMARY---';
const DOCUMENT_MARKER = '---DOCUMENT---';

const SYSTEM_PROMPT = `אתה עוזר AI המתמחה בהגדרת הסכמי נוכחות והיעדרות במערכת HAAB, מערכת לניהול נוכחות עובדים.
תפקידך: לשוחח עם מנהל מערכת (System Admin) שרוצה להגדיר הסכם נוכחות חדש **או לערוך הסכם קיים**, ולעזור לו לגבש/לעדכן את פרטי ההסכם. אם ההודעה הראשונה בשיחה (מהצד שלך, "model") מתארת הסכם קיים - אתה במצב עריכה: שמור על כל הערך שהמשתמש לא ביקש לשנות, ושאל רק על מה שחסר או מבוקש לשנות.

עליך לברר בשיחה, בעברית, בטון ידידותי ותכליתי, לפי הצורך (לא כל הכללים רלוונטיים לכל הסכם - אל תתעקש על כלל שהמשתמש מציין שאינו רלוונטי):

שדות בסיסיים (כמעט תמיד רלוונטיים):
- כמה שעות עבודה התקן ביום רגיל (dayStandardMinutes, בדקות).
- כמה שעות עבודה התקן בערב יום המנוחה/ערב חג (shortenedDayStandardMinutes, בדקות). שים לב: שדה זה חייב להיות מספר דקות חיובי - אם אין בכלל מושג כזה, השתמש באותו ערך כמו יום רגיל.
- יום המנוחה השבועי (weeklyRestDay, 0=ראשון...6=שבת).
- כמה ימי עבודה בשבוע (workdaysPerWeek).
- לוח חגים מקושר (holidayCalendar: jewish/christian/muslim/none).

שדות מתקדמים (שאל רק אם רלוונטי לשיחה):
- הפסקה יומית בתשלום/לא בתשלום בדקות (breakMinutes) - אם אין הפסקה מוגדרת, 0.
- מדרגות שעות נוספות: כמה דקות במדרגה הראשונה ובאיזה שיעור (otTier1Minutes, otTier1Rate - למשל 1.25), ושיעור המדרגה השנייה ואילך (otTier2Rate - למשל 1.5).
- הגדרת משמרת לילה: שעת התחלה וסיום של "הלילה" (nightStartTime, nightEndTime, בפורמט HH:MM), כמה דקות חפיפה מינימליות דרושות כדי שמשמרת תיחשב משמרת לילה (nightMinOverlapMinutes), ומה התקן (בדקות) שחל כשמשמרת מוגדרת כמשמרת לילה (nightStandardMinutes) - אם המשתמש מגדיר מהי משמרת לילה אך לא אומר מה התקן המיוחד שחל, אל תמציא מספר - השאר שדה זה ללא ערך ושאל את המשתמש מפורשות מה התקן.
- יום קצר קבוע בשבוע, שאינו ערב יום המנוחה (shortWeekday 0-6, shortWeekdayStandardMinutes בדקות) - למשל ארגון שעובד א'-ה' עם יום חמישי מקוצר.
- שעת "כניסת" יום המנוחה (weeklyRestEntryTime, HH:MM) - אם מוגדר, שעות עבודה בערב יום המנוחה אחרי השעה הזו נחשבות כשעות יום מנוחה (גם אם היום הקלנדרי עדיין לא השתנה).
- שיעור תוספת יום המנוחה (shabbatPremiumRate, למשל 1.5).
- זכאות לתשלום חג: ותק מינימלי בחודשים (holidayPaySeniorityMonths), ואורך חלון הממוצע לחישוב תשלום החג בחודשים (holidayPayAveragingMonths) - תשלום החג מחושב כממוצע שעות רגילות בחלון הזה.

אם המשתמש מתאר כלל שאינו מתאים לאף שדה מהרשימה לעיל - אל תתעלם ממנו. הוסף אותו לאובייקט additionalFields בסיכום (ראה מבנה למטה), כדי שישמר לעתיד גם אם עדיין לא מחושב אוטומטית.

חשוב: שאל שאלה אחת או שתיים בכל תור שיחה, לא רשימה ארוכה בבת אחת - זה אמור להיות דיאלוג טבעי, לא שאלון.

כאשר, ורק כאשר, יש בידך מספיק מידע כדי לסכם את ההסכם (לפחות חמשת השדות הבסיסיים, ועוד כל שדה מתקדם שהוזכר בשיחה), סיים את תשובתך כך:

1. שורה שבדיוק אומרת:
${SUMMARY_MARKER}
2. מיד אחריה, אובייקט JSON יחיד ללא טקסט נוסף סביבו - כלול תמיד את חמשת השדות הבסיסיים, וכל שדה מתקדם שרלוונטי לשיחה (אל תכלול שדה מתקדם שלא עלה בשיחה כלל ושאינו רלוונטי). דוגמה למבנה מלא (כלול רק את מה שרלוונטי):
{"dayStandardMinutes": 480, "shortenedDayStandardMinutes": 420, "weeklyRestDay": 6, "workdaysPerWeek": 6, "holidayCalendar": "jewish", "breakMinutes": 30, "otTier1Minutes": 120, "otTier1Rate": 1.25, "otTier2Rate": 1.5, "nightStartTime": "22:00", "nightEndTime": "06:00", "nightMinOverlapMinutes": 120, "nightStandardMinutes": 420, "shortWeekday": 4, "shortWeekdayStandardMinutes": 510, "weeklyRestEntryTime": "16:00", "shabbatPremiumRate": 1.5, "holidayPaySeniorityMonths": 3, "holidayPayAveragingMonths": 3, "additionalFields": {"someRule": {"label": "שם הכלל בעברית", "value": "הערך או התיאור שלו"}}}
3. שורה שבדיוק אומרת:
${DOCUMENT_MARKER}
4. ואז מסמך תיעוד מסודר בעברית, עם כותרות ברורות (רק לסעיפים הרלוונטיים): "תקן שעות", "הפסקה", "שעות נוספות", "משמרת לילה", "יום מנוחה ושבת", "חגים", "שדות נוספים". כתוב בפרוזה ברורה ומסודרת, לא כהעתקה גולמית של השיחה.

אל תפיק את הבלוקים האלה עד שאתה בטוח שיש לך תשובה סבירה לכל השדות הרלוונטיים. אם המשתמש מבקש ממך לסכם למרות מידע חסר, השתמש בברירות מחדל סבירות (יום עבודה 8 שעות, יום מקוצר כמו יום רגיל, שבת כיום מנוחה, 6 ימי עבודה, לוח יהודי, ללא הפסקה, ללא כללי לילה/יום קצר/תוספת שבת/זכאות חג מיוחדים) עבור מה שחסר, וציין זאת בקצרה בתשובתך לפני הבלוקים.`;

class AgreementExpertError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isPositiveIntInDay(v) {
  return Number.isInteger(v) && v > 0 && v <= 24 * 60;
}

// Required fields (the original Phase 4b five) always validated; every advanced field is
// optional - present-but-invalid fails the whole summary (same strict all-or-nothing contract
// the UI already expects), absent means "no opinion" (edit mode: leave unchanged).
function validateSummary(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { dayStandardMinutes, shortenedDayStandardMinutes, weeklyRestDay, workdaysPerWeek, holidayCalendar } = raw;
  if (!isPositiveIntInDay(dayStandardMinutes)) return null;
  if (!isPositiveIntInDay(shortenedDayStandardMinutes)) return null;
  if (!Number.isInteger(weeklyRestDay) || weeklyRestDay < 0 || weeklyRestDay > 6) return null;
  if (!Number.isInteger(workdaysPerWeek) || workdaysPerWeek < 1 || workdaysPerWeek > 7) return null;
  if (!['jewish', 'christian', 'muslim', 'none'].includes(holidayCalendar)) return null;

  const result = { dayStandardMinutes, shortenedDayStandardMinutes, weeklyRestDay, workdaysPerWeek, holidayCalendar };

  const optionalChecks = {
    breakMinutes: (v) => Number.isInteger(v) && v >= 0 && v < 24 * 60,
    otTier1Minutes: (v) => Number.isInteger(v) && v > 0 && v < 24 * 60,
    otTier1Rate: (v) => typeof v === 'number' && v > 0 && v < 10,
    otTier2Rate: (v) => typeof v === 'number' && v > 0 && v < 10,
    nightStartTime: (v) => typeof v === 'string' && HHMM_RE.test(v),
    nightEndTime: (v) => typeof v === 'string' && HHMM_RE.test(v),
    nightMinOverlapMinutes: (v) => Number.isInteger(v) && v > 0 && v < 24 * 60,
    nightStandardMinutes: (v) => isPositiveIntInDay(v),
    shortWeekday: (v) => Number.isInteger(v) && v >= 0 && v <= 6,
    shortWeekdayStandardMinutes: (v) => isPositiveIntInDay(v),
    weeklyRestEntryTime: (v) => typeof v === 'string' && HHMM_RE.test(v),
    shabbatPremiumRate: (v) => typeof v === 'number' && v > 0 && v < 10,
    holidayPaySeniorityMonths: (v) => Number.isInteger(v) && v >= 0 && v <= 120,
    holidayPayAveragingMonths: (v) => Number.isInteger(v) && v > 0 && v <= 36
  };
  for (const [key, check] of Object.entries(optionalChecks)) {
    if (raw[key] === undefined || raw[key] === null) continue;
    if (!check(raw[key])) return null;
    result[key] = raw[key];
  }

  if (raw.additionalFields !== undefined && raw.additionalFields !== null) {
    if (typeof raw.additionalFields !== 'object' || Array.isArray(raw.additionalFields)) return null;
    const additionalFields = {};
    for (const [key, entry] of Object.entries(raw.additionalFields)) {
      if (!entry || typeof entry !== 'object' || typeof entry.label !== 'string') return null;
      additionalFields[key] = { label: entry.label, value: entry.value };
    }
    result.additionalFields = additionalFields;
  }

  return result;
}

// Splits the model's raw reply into the human-facing text, the structured summary (if present
// and valid), and the structured document write-up (if present). A marker with
// malformed/incomplete content after it is treated the same as no marker at all - raw marker
// text never leaks into the chat UI either way.
function parseReply(text) {
  const idx = text.indexOf(SUMMARY_MARKER);
  if (idx === -1) return { reply: text.trim(), summary: null };
  const before = text.slice(0, idx).trim();
  const rest = text.slice(idx + SUMMARY_MARKER.length);

  const docIdx = rest.indexOf(DOCUMENT_MARKER);
  const jsonPart = (docIdx === -1 ? rest : rest.slice(0, docIdx)).trim();
  const document = docIdx === -1 ? null : rest.slice(docIdx + DOCUMENT_MARKER.length).trim() || null;

  let parsed = null;
  try {
    parsed = JSON.parse(jsonPart);
  } catch (e) {
    parsed = null;
  }
  const summary = validateSummary(parsed);
  return { reply: before, summary, summaryFailed: !summary, document: summary ? document : null };
}

async function chatWithAgreementExpert(messages) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new AgreementExpertError('GEMINI_API_KEY is not configured', 'not_configured');

  const contents = messages.map((m) => ({
    role: m.role === 'model' ? 'model' : 'user',
    parts: [{ text: String(m.text || '') }]
  }));

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents
    })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const providerMessage = (data && data.error && data.error.message) || `Gemini API error (${res.status})`;
    throw new AgreementExpertError(providerMessage, 'provider_error');
  }
  const text = data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts && data.candidates[0].content.parts.map((p) => p.text || '').join('');
  if (!text) throw new AgreementExpertError('Gemini API returned no content', 'provider_error');

  return parseReply(text);
}

module.exports = { chatWithAgreementExpert, AgreementExpertError };
