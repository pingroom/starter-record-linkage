import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson } from './storage.js';
import { step, localReport } from './linkage.js';
import { mockApi, CONFIG, ROOM_CODE } from './mock.js';

const directory = await mkdtemp(join(tmpdir(), 'pingroom-linkage-demo-'));
const input = await readJson(new URL('../examples/catalog.json', import.meta.url), 16384);
const now = () => '2026-01-01T09:00:00.000Z';
const api = mockApi(now);
const options = { client: api.client, directory, input, config: CONFIG, token: 'offline-fixture-token', room: ROOM_CODE, now };
const decisions = { 'a::b': 'same', 'a::d': 'different', 'a::e': 'unsure', 'b::c': 'same' };
try {
  for (let i = 0; i < input.pairs.length; i++) {
    const pending = await step(options);
    const pair = pending.judgments.find((item) => item.status === 'pending');
    api.answer(pair.questionId, decisions[pair.key]);
    await step(options);
  }
  const result = await localReport(directory, input, { save: true });
  console.log(JSON.stringify({ demo: 'Mocked catalog alignment: two identity links, one cannot-link, one Unsure. No source records changed.',
    status: result.status, consistent: result.consistent, suggestedGroups: result.suggestedGroups,
    directSame: result.sameAssertions, directDifferent: result.differentAssertions,
    inferredSamePairs: result.inferredSamePairs, unsurePairs: result.unsurePairs,
    unknownEvidencePairs: result.unknownEvidencePairs }, null, 2));
  const sends = api.calls.filter((call) => call.method === 'POST').length;
  await step(options);
  if (api.calls.filter((call) => call.method === 'POST').length !== sends) throw new Error('Replay sent another question.');
} finally { await rm(directory, { recursive: true, force: true }); }
