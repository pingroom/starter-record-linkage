import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const ROOM = /^[A-Z0-9]{12}$/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => record(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value);
const line = (value, max) => typeof value === 'string' && value.length <= max && /^[\x20-\x7e]+$/.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}

export function validateInput(input) {
  if (!keys(input, ['batchId', 'title', 'identityRule', 'records', 'pairs']) || !word(input.batchId) || !line(input.title, 60)
    || !line(input.identityRule, 80) || !Array.isArray(input.records) || input.records.length < 2 || input.records.length > 8
    || !Array.isArray(input.pairs) || input.pairs.length < 1 || input.pairs.length > 16) throw new Error('Provide a batch ID, identity rule, 2–8 records, and 1–16 explicit candidate pairs.');
  const ids = new Set();
  for (const item of input.records) {
    if (!keys(item, ['id', 'source', 'label', 'details']) || !word(item.id) || item.id.length > 24 || ids.has(item.id)
      || !line(item.source, 16) || !line(item.label, 24) || !line(item.details, 60)) throw new Error('Each record needs a unique ID and bounded source, label, and details.');
    ids.add(item.id);
  }
  const seen = new Set();
  for (const pair of input.pairs) {
    if (!keys(pair, ['left', 'right']) || !ids.has(pair.left) || !ids.has(pair.right) || pair.left === pair.right) throw new Error('Candidate pairs must reference two distinct known record IDs.');
    const key = [pair.left, pair.right].sort(compare).join('::');
    if (seen.has(key)) throw new Error('Each unordered candidate pair may appear only once.');
    seen.add(key);
  }
  return structuredClone(input);
}

export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id)
    || !line(config.participant.label, 60)) throw new Error('Config requires an exact resolver UUID and label.');
  return structuredClone(config);
}

export function pairsFor(rawInput) {
  const input = validateInput(rawInput);
  return input.pairs.map(({ left, right }) => {
    const sorted = [left, right].sort(compare);
    return { key: sorted.join('::'), left: sorted[0], right: sorted[1] };
  }).sort((a, b) => compare(a.key, b.key));
}

export function requestFor(input, config, pairKey, attemptId) {
  const pair = pairsFor(input).find((item) => item.key === pairKey);
  if (!pair || !isId(attemptId)) throw new Error('Invalid candidate pair or attempt.');
  const show = (id) => { const item = input.records.find((record) => record.id === id); return `[${item.id}] (${item.source}) ${item.label}: ${item.details}`; };
  const key = `linkage-${attemptId}`;
  const prompt = `${input.title}\nIdentity rule: ${input.identityRule}\nA ${show(pair.left)}\nB ${show(pair.right)}\nDo these describe the same entity?`;
  if (prompt.length > 500) throw new Error('Candidate prompt exceeds 500 characters.');
  return { prompt, context: `Linkage ${hash({ input, pairKey }).slice(0, 20)}`,
    options: [['same', 'Same entity'], ['different', 'Different entities'], ['unsure', 'Unsure']]
      .map(([value, label]) => ({ value, label, style: 'default' })),
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL, correlation_id: key,
    data: { input_hash: hash(input), pair_key: pairKey, attempt_id: attemptId }, idempotencyKey: key };
}

export function validateState(state, input) {
  validateInput(input);
  const pairs = pairsFor(input);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || !/^[0-9a-f]{64}$/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > pairs.length || iso(state.startedAt) !== state.startedAt) throw new Error('Invalid state or changed catalog input. Restore the original input and configuration.');
  validateConfig(state.config);
  const ids = new Set(), questionIds = new Set(); let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'pair', 'createdAt', 'request', 'questionId', 'status', 'observation']) || !isId(attempt.id) || ids.has(attempt.id)
      || attempt.pair !== pairs[index].key || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.pair, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) throw new Error('Invalid saved candidate.');
    ids.add(attempt.id); previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId); validateObservation(attempt.observation, attempt.status, attempt.request);
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS) throw new Error('Question predates its saved creation intent.');
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) throw new Error('Only the last candidate may be active.');
  }
  return state;
}

/** Identity is modeled as an equivalence relation; Different is a cannot-link constraint. */
export function analyze(records, judgments) {
  const ids = records.map((item) => item.id).sort(compare);
  const parent = new Map(ids.map((id) => [id, id]));
  const root = (id) => { while (parent.get(id) !== id) id = parent.get(id); return id; };
  const sameAssertions = judgments.filter((item) => item.choice === 'same').map(({ left, right, questionId }) => ({ left, right, questionId }));
  const differentAssertions = judgments.filter((item) => item.choice === 'different').map(({ left, right, questionId }) => ({ left, right, questionId }));
  for (const { left, right } of sameAssertions) { const a = root(left), b = root(right); if (a !== b) parent.set(b, a); }
  const map = new Map();
  for (const id of ids) { const key = root(id); if (!map.has(key)) map.set(key, []); map.get(key).push(id); }
  const components = [...map.values()].sort((a, b) => compare(a[0], b[0]));
  const conflicts = differentAssertions.filter(({ left, right }) => root(left) === root(right));
  const conflictComponents = components.filter((members) => conflicts.some(({ left }) => members.includes(left)))
    .map((members) => ({ members, cannotLinks: conflicts.filter(({ left }) => members.includes(left)) }));
  const consistent = conflicts.length === 0;
  const directSame = new Set(sameAssertions.map(({ left, right }) => `${left}::${right}`));
  const directKnown = new Set([...sameAssertions, ...differentAssertions].map(({ left, right }) => `${left}::${right}`));
  const inferredSamePairs = [], unknownEvidencePairs = [];
  for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
    const pair = { left: ids[a], right: ids[b] }, key = `${pair.left}::${pair.right}`;
    if (!directKnown.has(key)) unknownEvidencePairs.push(pair);
    if (consistent && root(pair.left) === root(pair.right) && !directSame.has(key)) inferredSamePairs.push(pair);
  }
  return { consistent, sameAssertions, differentAssertions, assertedComponents: components,
    conflictComponents, inferredSamePairs: consistent ? inferredSamePairs : null, unknownEvidencePairs,
    suggestedGroups: consistent ? components.filter((members) => members.length > 1) : null };
}

export function report(state, input) {
  validateState(state, input);
  const judgments = pairsFor(input).map((pair) => {
    const attempt = state.attempts.find((entry) => entry.pair === pair.key), answer = attempt?.observation?.answer;
    return { ...pair, status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
      choice: answer?.value ?? null, questionId: attempt?.questionId ?? null, attemptId: attempt?.id ?? null,
      responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null,
      askerId: attempt?.observation?.askerId ?? null, observedAt: attempt?.observation?.checkedAt ?? null };
  });
  const analysis = analyze(input.records, judgments);
  const active = judgments.find((item) => ['create_unknown', 'pending'].includes(item.status));
  const incomplete = judgments.some((item) => ['expired', 'cancelled', 'invalid_answer'].includes(item.status));
  const status = active?.status ?? (judgments.some((item) => item.status === 'unasked') ? 'ready' : incomplete || !analysis.consistent ? 'incomplete' : 'complete');
  const allCandidatesAnswered = judgments.every((item) => item.status === 'answered');
  return { batchId: input.batchId, title: input.title, identityRule: input.identityRule, inputHash: hash(input), status,
    participant: state.config.participant, judgments,
    allCandidatesAnswered,
    allCandidatesDecided: judgments.every((item) => ['same', 'different'].includes(item.choice)),
    unsurePairs: judgments.filter((item) => item.choice === 'unsure').map(({ left, right }) => ({ left, right })),
    unansweredPairs: judgments.filter((item) => item.choice === null).map(({ left, right, status }) => ({ left, right, status })),
    ...analysis, suggestedGroups: allCandidatesAnswered ? analysis.suggestedGroups : null,
    proposalBlockedReasons: [...(allCandidatesAnswered ? [] : ['incomplete_review']), ...(analysis.consistent ? [] : ['contradictory_evidence'])] };
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['value', 'label', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || !request.options.some((option) => option.value === answer.value && option.label === answer.label)
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved linkage evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered comparisons must not contain linkage evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || q.is_handoff !== false
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || q.results !== null || q.text_input !== null || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== request.options.length
    || q.options.some((option, index) => option?.value !== request.options[index].value || option?.label !== request.options[index].label
      || option?.primary !== false || option?.destructive !== false)) throw new Error('Question does not match the saved candidate pair, room, or participant.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.text !== null || answer.responder?.id !== request.target_user_id
        || !request.options.some((option) => option.value === answer.value && option.label === answer.label)) throw new Error('Invalid answer.');
      observation.answer = { value: answer.value, label: answer.label, responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}


export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
