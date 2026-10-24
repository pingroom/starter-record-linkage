import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport } from '../src/linkage.js';
import { readJson, atomicJson, acquireLock } from '../src/storage.js';
import { validateInput, validateState, pairsFor, hash, iso } from '../src/model.js';
import { loadConnection, loadEnvironment } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, ASKER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/catalog.json', import.meta.url), 16384);
const simple = () => ({ ...structuredClone(example), records: structuredClone(example.records.slice(0, 2)), pairs: [{ left: 'a', right: 'b' }] });
const twoPairs = () => ({ ...structuredClone(example), records: structuredClone(example.records.slice(0, 3)), pairs: [{ left: 'a', right: 'b' }, { left: 'b', right: 'c' }] });
async function setup(t, input = simple()) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-linkage-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now);
  const options = { client: api.client, directory, input, config: structuredClone(CONFIG), token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;
async function decide(s, decisions) {
  let result;
  for (const value of decisions) {
    result = await s.run();
    const pending = result.judgments.find(item => item.status === 'pending');
    s.api.answer(pending.questionId, value); result = await s.run();
  }
  return result;
}

test('lost response blocks later pairs; exact-ID recovery reads the original request without resend', async (t) => {
  const s = await setup(t, twoPairs()); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.deepEqual((await s.run({ command: 'find' })).candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), 'same'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'ready');
  assert.equal(sends(s.api), 1);
});

test('malformed create response and empty search never authorize a new POST', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true; await assert.rejects(s.run());
  assert.equal((await s.saved()).attempts[0].status, 'creating'); s.api.questions.clear();
  assert.deepEqual((await s.run({ command: 'find' })).candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('recovery validates exact target, room, request, options, data and non-handoff provenance', async (t) => {
  for (const mutate of [
    (q) => { q.target_user_id = OTHER; }, (q) => { q.room.code = 'WRONG1234567'; }, (q) => { q.prompt = 'Other prompt'; },
    (q) => { q.options[0].primary = true; }, (q) => { q.options[0].destructive = true; }, (q) => { q.options.reverse(); },
    (q) => { q.data.pair_key = 'other'; }, (q) => { q.data.input_hash = 'changed'; }, (q) => { delete q.is_handoff; },
    (q) => { q.is_handoff = true; }, (q) => { q.asker.type = 'user'; }, (q) => { q.resolution_policy = 'all'; },
  ]) {
    const s = await setup(t); s.api.controls.loseNext = true; await s.run(); mutate(s.api.questions.get(id(1)));
    await assert.rejects(s.run({ command: 'recover', attachId: id(1) })); assert.equal((await s.saved()).attempts[0].status, 'creating');
    assert.equal(sends(s.api), 1);
  }
});

test('wrong, missing, typed or unknown answers never resolve an identity judgment', async (t) => {
  for (const mutate of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = 'same'; }, (q) => { q.answer.value = 'unknown'; }, (q) => { q.answer.label = 'Wrong'; },
  ]) {
    const s = await setup(t); await s.run(); s.api.answer(id(1), 'same'); mutate(s.api.questions.get(id(1)));
    const result = await s.run(); assert.equal(result.observedStatus, 'invalid_answer'); assert.equal(result.suggestedGroups, null);
    await s.run(); assert.equal(sends(s.api), 1);
  }
});

test('original asker, lifetime and intent remain bound across reads and across pairs', async (t) => {
  for (const mutate of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); await s.run(); mutate(s.api.questions.get(id(1))); await assert.rejects(s.run(), /identity or lifetime/);
  }
  const s = await setup(t, twoPairs()); await s.run(); s.api.answer(id(1), 'same'); await s.run();
  s.api.controls.loseNext = true; await s.run(); s.api.questions.get(id(2)).asker.id = OTHER;
  await assert.rejects(s.run({ command: 'recover', attachId: id(2) }), /different asking registrations/);
  const other = await setup(t); other.api.controls.loseNext = true; await other.run();
  const q = other.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(other.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('expiry accepts delayed processing but rejects premature and implausibly future resolution on replay', async (t) => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
  s.api.terminal(id(1), 'expired'); s.api.questions.get(id(1)).resolved_at = '2026-01-01T09:15:30.000Z';
  assert.equal((await s.run()).status, 'incomplete'); assert.equal((await localReport(s.directory, s.options.input)).suggestedGroups, null);
  const original = await s.saved();
  for (const timestamp of ['2026-01-01T09:14:59.999Z', '2026-01-01T09:17:00.001Z']) {
    const saved = structuredClone(original); saved.attempts[0].observation.resolvedAt = timestamp;
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run(), /resolution time/); assert.equal(s.api.calls.length, calls);
    const live = await setup(t); await live.run(); live.clock.value = s.clock.value; live.api.terminal(id(1), 'expired');
    live.api.questions.get(id(1)).resolved_at = timestamp; await assert.rejects(live.run(), /resolution time/);
  }
});

test('answer and resolution times must agree and answer/cancellation cannot occur after expiry', async (t) => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), 'same');
  s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const terminal of ['answered', 'cancelled']) {
    const other = await setup(t); await other.run(); other.clock.value = '2026-01-01T09:16:00.000Z';
    if (terminal === 'answered') other.api.answer(id(1), 'same'); else other.api.terminal(id(1), terminal);
    await assert.rejects(other.run(), /resolution time/);
  }
});

test('checked time follows response; future creation, wrong TTL and answer on pending fail', async (t) => {
  const s = await setup(t); await s.run(); const get = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), 'same'); return get(...args); };
  await s.run(); assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  for (const mutate of [
    (q) => { q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z'; },
    (q) => { q.expires_at = '2026-01-01T10:00:00.000Z'; }, (q) => { q.answer = {}; },
  ]) { const other = await setup(t); await other.run(); mutate(other.api.questions.get(id(1))); await assert.rejects(other.run()); }
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z'); assert.throws(() => iso('2026-02-30T09:00:00Z'));
});

test('room preflight refuses public/unsupported rooms and missing resolver before a POST', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].type = 'dm'; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('reservation write failure sends nothing; answer save failure resumes the original question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), 'same');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'complete'); assert.equal(sends(s.api), 1);
});

test('post-create save failure leaves uncertain intent for verified recovery without another POST', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads preserve evidence and corrupted request/provenance fail before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  s.api.controls.readError = false; s.api.answer(id(1), 'same'); await s.run(); const original = await s.saved();
  for (const mutate of [
    (saved) => { saved.attempts[0].request.ttl = 60; }, (saved) => { saved.attempts.push(saved.attempts[0]); },
    (saved) => { saved.attempts[0].pair = 'other::pair'; }, (saved) => { saved.attempts[0].observation.answer.responderId = OTHER; },
  ]) {
    const saved = structuredClone(original); mutate(saved); assert.throws(() => validateState(saved, s.options.input));
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
  }
});

test('bounded file reads reject malformed, oversized, invalid UTF-8 and symlink data without revealing contents', async (t) => {
  const s = await setup(t), path = join(s.directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",bad');
  await assert.rejects(readJson(path), (error) => !error.message.includes('PRIVATE_TOKEN') && error.message.includes('malformed'));
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path), /UTF-8/);
  await writeFile(path, 'x'.repeat(100)); await assert.rejects(readJson(path, 50), /size limit/);
  await symlink(path, join(s.directory, 'linked')); await assert.rejects(readJson(join(s.directory, 'linked')));
});

test('private lock excludes other commands; report is offline and private', async (t) => {
  const s = await setup(t); await s.run(); const release = await acquireLock(s.directory);
  await assert.rejects(s.run(), /lock exists/); await assert.rejects(localReport(s.directory, s.options.input), /lock exists/);
  await release(); const before = s.api.calls.length;
  assert.equal((await localReport(s.directory, s.options.input, { save: true })).suggestedGroups, null); assert.equal(s.api.calls.length, before);
  assert.equal((await stat(join(s.directory, 'report.json'))).mode & 0o777, 0o600);
});

test('partial or blank environment overrides never combine with saved credentials', async (t) => {
  const s = await setup(t); await atomicJson(s.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(s.directory, { PINGROOM_TOKEN: '' })); await assert.rejects(loadConnection(s.directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.equal((await loadConnection(s.directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() })).token, 'explicit');
});

test('transport rejects unrelated writes, redirects and oversized responses', async () => {
  let count = 0; const client = makeClient({ token: 'fixture', fetchImpl: async () => { count++; return new Response(null, { status: 302 }); } });
  await assert.rejects(client.questions.get(id(1))); assert.equal(count, 1); await assert.rejects(client.questions.cancel(id(1))); assert.equal(count, 1);
  const large = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) }); await assert.rejects(large.questions.get(id(1)));
});

test('transport deadlines bound stalled fetch/body and allow abort through infinite ready empty chunks', async () => {
  const stalled = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) }); await assert.rejects(stalled.questions.get(id(1)));
  const body = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) }); await assert.rejects(body.questions.get(id(1)));
  const controller = new AbortController();
  const empty = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (out) => out.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20); try { await assert.rejects(empty.questions.get(id(1))); } finally { clearTimeout(timer); }
});

test('abort before reservation sends nothing; after reservation it preserves unresolved intent', async (t) => {
  const s = await setup(t), stopped = new AbortController(); stopped.abort(); await assert.rejects(s.run({ signal: stopped.signal })); assert.equal(sends(s.api), 0);
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(s.run({ signal: controller.signal, write: async (...args) => { await atomicJson(...args); if (++writes === 2) controller.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});


test('partial external credentials cannot borrow the room from dotenv', async (t) => {
  const s = await setup(t), path = join(s.directory, '.env');
  await writeFile(path, 'PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = { PINGROOM_TOKEN: 'shell-token' }; await loadEnvironment(partial, path);
  assert.equal(partial.PINGROOM_ROOM, undefined); await assert.rejects(loadConnection(s.directory, partial));
  const env = {}; await loadEnvironment(env, path); assert.deepEqual(await loadConnection(s.directory, env), { token: 'file-token', room: ROOM_CODE });
});

test('identity assertions generate separate transitive deductions, without editing inputs', async t => {
  const s = await setup(t, structuredClone(example)), before = structuredClone(s.options.input);
  const result = await decide(s, ['same', 'different', 'unsure', 'same']);
  assert.equal(result.status, 'complete'); assert.equal(result.consistent, true);
  assert.deepEqual(result.suggestedGroups, [['a', 'b', 'c']]);
  assert.deepEqual(result.inferredSamePairs, [{ left: 'a', right: 'c' }]);
  assert.deepEqual(result.unsurePairs, [{ left: 'a', right: 'e' }]);
  assert.equal(result.allCandidatesAnswered, true); assert.equal(result.allCandidatesDecided, false);
  assert.ok(result.unknownEvidencePairs.some(pair => pair.left === 'a' && pair.right === 'c'));
  assert.ok(result.unknownEvidencePairs.some(pair => pair.left === 'b' && pair.right === 'd'));
  assert.deepEqual(result.sameAssertions.map(pair => [pair.left, pair.right]), [['a', 'b'], ['b', 'c']]);
  assert.equal(result.judgments[0].askerId, ASKER); assert.equal(result.judgments[0].responderId, CONFIG.participant.id);
  assert.deepEqual(s.options.input, before);
  const calls = s.api.calls.length; await s.run(); assert.equal(s.api.calls.length, calls);
});

test('different within a transitive Same component blocks all suggestions, including unrelated groups', async t => {
  const input = structuredClone(example);
  input.pairs = [{ left: 'a', right: 'b' }, { left: 'a', right: 'c' }, { left: 'b', right: 'c' }, { left: 'd', right: 'e' }];
  const s = await setup(t, input), result = await decide(s, ['same', 'different', 'same', 'same']);
  assert.equal(result.status, 'incomplete'); assert.equal(result.consistent, false);
  assert.equal(result.suggestedGroups, null); assert.equal(result.inferredSamePairs, null);
  assert.deepEqual(result.assertedComponents, [['a', 'b', 'c'], ['d', 'e']]);
  assert.deepEqual(result.conflictComponents[0].members, ['a', 'b', 'c']);
  assert.deepEqual(result.conflictComponents[0].cannotLinks, [{ left: 'a', right: 'c', questionId: id(2) }]);
  assert.deepEqual(result.proposalBlockedReasons, ['contradictory_evidence']);
});

test('Unsure remains unknown direct evidence even where other Same assertions imply identity', async t => {
  const input = twoPairs(); input.pairs.push({ left: 'a', right: 'c' });
  const s = await setup(t, input), result = await decide(s, ['same', 'unsure', 'same']);
  assert.deepEqual(result.suggestedGroups, [['a', 'b', 'c']]);
  assert.deepEqual(result.inferredSamePairs, [{ left: 'a', right: 'c' }]);
  assert.deepEqual(result.unknownEvidencePairs, [{ left: 'a', right: 'c' }]);
  assert.deepEqual(result.unsurePairs, [{ left: 'a', right: 'c' }]);
  assert.equal(result.judgments[1].choice, 'unsure');
});

test('Different is not transitive: two cannot-links never invent a third inequality', async t => {
  const s = await setup(t, twoPairs()), result = await decide(s, ['different', 'different']);
  assert.deepEqual(result.suggestedGroups, []); assert.deepEqual(result.assertedComponents, [['a'], ['b'], ['c']]);
  assert.deepEqual(result.unknownEvidencePairs, [{ left: 'a', right: 'c' }]);
  assert.equal(result.differentAssertions.length, 2); assert.deepEqual(result.inferredSamePairs, []);
});

test('a candidate that becomes transitively implied is still asked exactly once', async t => {
  const input = twoPairs(); input.pairs.push({ left: 'a', right: 'c' });
  const s = await setup(t, input); let result = await s.run(); assert.equal(result.suggestedGroups, null);
  s.api.answer(id(1), 'same'); result = await s.run(); assert.equal(result.status, 'ready'); assert.equal(sends(s.api), 1);
  assert.equal(result.suggestedGroups, null);
  await s.run(); s.api.answer(id(2), 'same'); await s.run();
  await s.run(); assert.equal(s.api.questions.get(id(3)).data.pair_key, 'b::c');
  s.api.answer(id(3), 'different'); result = await s.run(); assert.equal(result.consistent, false); assert.equal(sends(s.api), 3);
});

test('unasked, pending, expired and cancelled comparisons cannot produce a suggested merge', async t => {
  for (const terminal of ['expired', 'cancelled']) {
    const s = await setup(t, twoPairs()); await decide(s, ['same']);
    assert.deepEqual((await localReport(s.directory, s.options.input)).proposalBlockedReasons, ['incomplete_review']);
    await s.run(); if (terminal === 'expired') s.clock.value = '2026-01-01T09:16:00.000Z';
    s.api.terminal(id(2), terminal); const result = await s.run();
    assert.equal(result.status, 'incomplete'); assert.equal(result.suggestedGroups, null);
    assert.deepEqual(result.unansweredPairs, [{ left: 'b', right: 'c', status: terminal }]);
    await s.run(); assert.equal(sends(s.api), 2);
  }
});

test('changed data, meaning, session or participant cannot reuse saved evidence', async t => {
  const s = await setup(t); await s.run();
  for (const mutate of [input => { input.batchId = 'other'; }, input => { input.identityRule = 'Same author'; },
    input => { input.records[0].details = 'Different source fact'; }, input => { input.records.reverse(); }]) {
    const input = structuredClone(s.options.input); mutate(input);
    await assert.rejects(s.run({ input }), /changed catalog input/);
  }
  await assert.rejects(s.run({ config: { participant: { id: OTHER, label: 'Other' } } }), /another connection/);
  await assert.rejects(s.run({ token: 'other' }), /another connection/); assert.equal(sends(s.api), 1);
});

test('schema rejects unknown, duplicate and self pairs, oversized fields, controls and extra keys', () => {
  for (const mutate of [
    p => { p.pairs.push({ left: 'b', right: 'a' }); }, p => { p.pairs[0].right = 'a'; }, p => { p.pairs[0].right = 'missing'; },
    p => { p.records[1].id = 'a'; }, p => { p.records[0].details = 'line\nbreak'; }, p => { p.records[0].details = 'x'.repeat(61); },
    p => { p.records[0].id = 1; }, p => { p.records[0].source = 'x'.repeat(17); }, p => { p.identityRule = ''; },
    p => { p.script = 'anything'; }, p => { p.pairs = []; }, p => { p.pairs = Array(17).fill(p.pairs[0]); },
    p => { p.records[0].label = 'x'.repeat(25); }, p => { p.records = p.records.slice(0, 1); },
  ]) { const input = simple(); mutate(input); assert.throws(() => validateInput(input)); }
});

test('pair orientation and ordering are deterministic but records and decision evidence retain their IDs', () => {
  const input = twoPairs(); input.pairs = [{ left: 'c', right: 'b' }, { left: 'b', right: 'a' }];
  assert.deepEqual(pairsFor(input), [{ key: 'a::b', left: 'a', right: 'b' }, { key: 'b::c', left: 'b', right: 'c' }]);
});

test('maximum sixteen comparisons fit prompt, state and report bounds', async t => {
  const input = { batchId: 'b'.repeat(40), title: 't'.repeat(60), identityRule: 'i'.repeat(80),
    records: Array.from({ length: 8 }, (_, i) => ({ id: `r${i}${'x'.repeat(22)}`, source: 's'.repeat(16), label: 'l'.repeat(24), details: 'd'.repeat(60) })), pairs: [] };
  for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8 && input.pairs.length < 16; b++) input.pairs.push({ left: input.records[a].id, right: input.records[b].id });
  const s = await setup(t, input), result = await decide(s, Array(16).fill('same'));
  assert.equal(result.status, 'complete'); assert.equal(sends(s.api), 16);
  for (const q of s.api.questions.values()) assert.ok(q.prompt.length <= 500);
  assert.ok(Buffer.byteLength(JSON.stringify(await s.saved(), null, 2)) + 4096 < 1024 * 1024);
  await localReport(s.directory, input, { save: true }); assert.ok((await stat(join(s.directory, 'report.json'))).size < 1024 * 1024);
});
