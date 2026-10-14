// Match a stored answer to its question - see events-rsvp-question-editing.md (D3, D7). Pure + shared
// so the free/paid controllers, the attendees endpoint, and the CSV all resolve answers the same way.
//
// Rule: prefer the stable question id (qid); fall back to the question label (fieldName) for answers
// stored before ids landed. The fallback is permanent - old answers are never migrated in place.

const nameKey = (v) => String(v ?? '').trim().toLowerCase();

// Return the question an answer belongs to, or null. qid first, name fallback.
export const matchAnswerToQuestion = (answer, questions = []) => {
  if (!answer) return null;
  const qs = Array.isArray(questions) ? questions : [];
  if (answer.qid != null && String(answer.qid) !== '') {
    const byId = qs.find((q) => q && q.qid != null && String(q.qid) === String(answer.qid));
    if (byId) return byId;
  }
  const key = nameKey(answer.fieldName);
  return qs.find((q) => nameKey(q?.fieldName) === key) || null;
};

// The label to DISPLAY for an answer: the question's CURRENT label (by id), else the label the answer
// was stored under (a rename never rewrites old answers, so displays relabel by id at read time).
export const displayLabelForAnswer = (answer, questions = []) => {
  const q = matchAnswerToQuestion(answer, questions);
  return (q && q.fieldName) || (answer && answer.fieldName) || '';
};

// Stamp the question id onto each answer for storage (events-rsvp-question-editing.md D2): additive -
// the fieldName text stays, a qid is added when the answer's question is found (by name at submit
// time). Used by the paid checkout; the free path stamps ids from the event fields directly.
export const stampAnswerIds = (answers = [], questions = []) =>
  (Array.isArray(answers) ? answers : []).map((a) => {
    const q = matchAnswerToQuestion(a, questions);
    return q && q.qid != null ? { ...a, qid: q.qid } : { ...a };
  });
