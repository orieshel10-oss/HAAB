// Conversational "attendance & absence agreement expert" backing the AI-assist chat in
// agreements.html. Stateless by design - the caller (the browser) resends the full conversation
// each turn; this module holds no session/DB state of its own. Talks to Google's Gemini API,
// chosen specifically because it has a genuine no-billing-required free tier (see GEMINI_MODEL
// below for how to swap models/plans later without a code change).

// gemini-flash-latest / gemini-3.8-flash return 503 "high demand" fairly often right now (newest
// models, heaviest traffic) - gemini-3.5-flash is a solid, currently-reliable fallback default.
// Override with GEMINI_MODEL any time without a code change.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const SUMMARY_MARKER = '---SUMMARY---';

const SYSTEM_PROMPT = `אתה עוזר AI המתמחה בהגדרת הסכמי נוכחות והיעדרות במערכת HAAB, מערכת לניהול נוכחות עובדים.
תפקידך: לשוחח עם מנהל מערכת (System Admin) שרוצה להגדיר הסכם נוכחות חדש, ולעזור לו לגבש את פרטי ההסכם.

עליך לברר בשיחה, בעברית, בטון ידידותי ותכליתי:
- כמה שעות עבודה התקן ביום רגיל.
- כמה שעות עבודה התקן ביום מקוצר (למשל ערב שבת/חג).
- מהו יום המנוחה השבועי (בדרך כלל שבת, אך יכול להיות שונה).
- כמה ימי עבודה יש בשבוע.
- לאיזה לוח חגים ההסכם מקושר: יהודי, נוצרי, מוסלמי, או ללא לוח חגים מיוחד.
- אפשר לשאול גם על ימים מיוחדים נוספים בשנה ועל הפסקה יומית, כדי להבין את ההקשר המלא - אך שדות אלו אינם חלק מהסיכום המובנה שתפיק (עדיין אין להם עמודה במערכת), הם רק עוזרים לך להבין את ההסכם לעומק.

חשוב: שאל שאלה אחת או שתיים בכל תור שיחה, לא רשימה ארוכה בבת אחת - זה אמור להיות דיאלוג טבעי, לא שאלון.

כאשר, ורק כאשר, יש בידך מספיק מידע כדי למלא בביטחון את חמשת השדות הבאים, סיים את תשובתך בשורה הבאה בדיוק:
${SUMMARY_MARKER}
ומיד אחריה, בשורה נפרדת, אובייקט JSON יחיד (ללא טקסט נוסף אחריו) עם המפתחות המדויקים הבאים:
{"dayStandardMinutes": <מספר דקות תקן ליום רגיל>, "shortenedDayStandardMinutes": <מספר דקות תקן ליום מקוצר>, "weeklyRestDay": <0 עד 6, כאשר 0=ראשון ... 6=שבת>, "workdaysPerWeek": <מספר ימי עבודה בשבוע>, "holidayCalendar": <"jewish" או "christian" או "muslim" או "none">}

אל תפיק את בלוק הסיכום הזה עד שאתה בטוח שיש לך תשובה סבירה לכל חמשת השדות. אם המשתמש מבקש ממך לסכם למרות מידע חסר, השתמש בברירות מחדל סבירות (יום עבודה 8 שעות, יום מקוצר 7 שעות, שבת כיום מנוחה, 6 ימי עבודה, לוח יהודי) עבור מה שחסר, וציין זאת בקצרה בתשובתך לפני בלוק הסיכום.`;

class AgreementExpertError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function validateSummary(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { dayStandardMinutes, shortenedDayStandardMinutes, weeklyRestDay, workdaysPerWeek, holidayCalendar } = raw;
  if (!Number.isInteger(dayStandardMinutes) || dayStandardMinutes <= 0 || dayStandardMinutes > 24 * 60) return null;
  if (!Number.isInteger(shortenedDayStandardMinutes) || shortenedDayStandardMinutes <= 0 || shortenedDayStandardMinutes > 24 * 60) return null;
  if (!Number.isInteger(weeklyRestDay) || weeklyRestDay < 0 || weeklyRestDay > 6) return null;
  if (!Number.isInteger(workdaysPerWeek) || workdaysPerWeek < 1 || workdaysPerWeek > 7) return null;
  if (!['jewish', 'christian', 'muslim', 'none'].includes(holidayCalendar)) return null;
  return { dayStandardMinutes, shortenedDayStandardMinutes, weeklyRestDay, workdaysPerWeek, holidayCalendar };
}

// Splits the model's raw reply into the human-facing text and (if present and valid) the
// structured summary. A marker with malformed/incomplete JSON after it is treated the same as
// no marker at all - the raw block is stripped either way so it never leaks into the chat UI.
function parseReply(text) {
  const idx = text.indexOf(SUMMARY_MARKER);
  if (idx === -1) return { reply: text.trim(), summary: null };
  const before = text.slice(0, idx).trim();
  const after = text.slice(idx + SUMMARY_MARKER.length).trim();
  let parsed = null;
  try {
    parsed = JSON.parse(after);
  } catch (e) {
    parsed = null;
  }
  return { reply: before, summary: validateSummary(parsed) };
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
