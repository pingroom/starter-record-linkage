# PingRoom record linkage

Review a small set of candidate matches between catalog exports. A named person
answers **Same entity / Different entities / Unsure** in PingRoom. Code groups
records connected by Same answers, detects contradictory Different answers, and
exports a proposal for inspection. Source records are never changed or combined.

Use this before a catalog migration when two sources may describe the same
item. You supply the candidates and define what “same” means: for example, the
same edition of a work. The template does not search for candidates or decide
which record's fields should win.

## Try it offline

Requires Node.js 22 or newer on macOS or Linux and persistent private storage.
Choose **Use this template**, clone your repository, then:

```sh
npm ci
npm test
npm run demo
```

The demo uses the real pinned SDK with an in-memory HTTP transport: two Same
answers create a three-record group, a Different answer rejects a match for another edition,
and an Unsure answer remains unknown. It needs no credentials, makes no network
requests, and removes its temporary state. Installation requires npm access.

## Prepare and connect

```sh
cp examples/catalog.json catalog.json
cp config.example.json config.json
cp .env.example .env
npm run plan
npm run connect
npm run inspect
```

Edit `catalog.json` before starting. Give the batch a new ID, a title, a precise
`identityRule`, 2–8 records, and 1–16 explicit candidate pairs. Each record has a
stable ID, source label, display label, and short details. Each pair references
two record IDs. Reverse duplicates, self-pairs, and unknown IDs are rejected.
`plan` prints the ordered candidate pairs offline without creating state.

Install [PingRoom](https://pingroom.io/i), approve the printed pairing link, and
choose a **standard private room** containing the reviewer. The connection needs
`pingroom:rooms:read`, `pingroom:questions:ask`, and a grant for that room. Normal
permissions and quotas apply. Connecting sends no record comparison.

`inspect` lists member UUIDs and lookup names. Verify the intended person in the
app, then set their exact UUID and a local label in `config.json`. Names and
labels are lookup aids, not identity checks. Keep record details appropriate for
the reviewer and room: each question includes the identity rule and both records.

Pairing saves private `.pingroom/credentials.json`. Creation intent is saved
before registering a robot. Pending setup reuses its saved link; an existing
connection is never overwritten. A lost creation response blocks new setup.
Keep `.pingroom/pairing.json`, inspect Connected Agents, and resolve or revoke
any created robot before intentionally archiving that file for new setup. Follow
the same recovery when a link expires; keep workflow evidence and credentials.

For an existing connection or unattended run, set **both** `PINGROOM_TOKEN` and
`PINGROOM_ROOM` in `.env` or the process environment. A complete pair overrides
saved credentials; partial or blank pairs fail. Defining either shell variable
selects the entire shell pair, without borrowing a missing value from `.env`.
All paths resolve from this project, regardless of the working directory.

## Review and export

```sh
npm start          # Ask the next candidate, or read the active Question.
# Answer in PingRoom, then rerun:
npm start
npm run status     # Local report; no network or credentials needed.
npm run report     # Also write private .linkage/report.json.
```

Each invocation creates or reads at most one Question. A later invocation asks
the next candidate in sorted record-ID order. Every listed pair is asked once,
even if earlier answers already imply a relationship. At most one Question is
active; each lasts 15 minutes. No scheduler or background wait is installed.
Serialize invocations from your workflow if you want periodic checks.

The report separates evidence from deductions:

- `judgments` preserves each candidate's status, attributed choice, Question ID,
  asking registration, and timestamps. `sameAssertions` and `differentAssertions`
  contain only explicit valid answers.
- `assertedComponents` follows chains of Same answers. Identity is modeled as an
  equivalence relation: A same as B and B same as C implies A same as C. This is
  a modeling assumption applied to human judgments, not proof of identity.
- `inferredSamePairs` contains those additional relationships, without inventing
  extra answers. `unknownEvidencePairs` retains every pair without an explicit
  Same or Different answer, including unlisted and Unsure pairs. A pair can be
  unknown as direct evidence and separately inferred through other records.
- `conflictComponents` identifies any Different answer whose endpoints fall in
  one Same component. Such a contradiction makes `consistent` false and
  suppresses **all** `suggestedGroups` and `inferredSamePairs` for the batch.
  Different answers are never treated as transitive.
- `suggestedGroups` is also `null` until every candidate has a valid attributed
  answer. Expired, cancelled, invalid, pending, unasked, or uncertain comparisons
  block it. Unsure counts as answered but asserts neither Same nor Different.
  `proposalBlockedReasons` explains withheld suggestions.

`complete` means the candidate review finished without detected contradictions;
it does not mean every identity is known or any merge is safe. `allCandidatesDecided`
is false when a person chose Unsure. Unconnected components are not proof of
different entities, and a consistent group can still be factually wrong. Reports
are proposals for inspection, never authorization to modify a source system.

Question requests, room, target UUID, options, asking registration, and lifetime
are checked. Answers must resolve within the Question lifetime; expiry may be
observed later. Timestamps allow 60 seconds of local clock skew. Terminal evidence
is reused locally, without rechecking historical responses or current room access.
Keep the original asking connection: another robot cannot read its Questions.

`start` and `recover` exit `0` for complete, `2` for incomplete or a newly observed
expired/cancelled/invalid outcome, `3` for ready/pending/interrupted, `4` for
uncertain creation, and `1` for errors. Local commands return `0` when readable;
inspect the report fields before consuming proposals.

## Recover an interrupted creation

The journal syncs the exact request, candidate, target, TTL, correlation, and
idempotency key before sending. A lost response, malformed response, crash, or
failed save can leave `create_unknown`. Later invocations neither resend the
request nor start another candidate while this remains unresolved.

```sh
npm run status
npm run find-id
npm run recover -- EXACT_QUESTION_UUID
```

`find-id` reads a bounded recent window of at most 200 Questions. An empty result
does not prove creation failed. Obtain the original ID from the originating
robot's history or saved response when needed. `recover` reads that exact ID and
verifies its complete request and provenance before attaching it; it sends no
question. Deleting uncertain state or starting another checkout can duplicate it.

The input, identity rule, participant, room, and credential are bound to the
journal. Changes are refused. Expired, cancelled, invalid, and Unsure comparisons
are not asked again in the batch. To gather revised judgments, resolve active or
uncertain work, archive the entire private `.linkage/` directory, and start a new
batch ID while keeping the old evidence. There is no automatic migration.

## Adapt and check

`src/linkage.js` exports the durable `step` function; `src/model.js` owns input
validation, pair order, equivalence closure, and contradiction checks. Export a
small candidate batch from your database, adapt the identity rule and record
summaries, and consume the local report. Any source update needs its own reviewed
integration, current revision checks, field-selection policy, and concurrency
control. No source writes, deployments, shell commands, or AI services are included.

IDs start with a lowercase letter and contain lowercase letters, digits, `_`, or
`-`: batch IDs allow 40 characters and record IDs 24. Printable ASCII text limits
are title 60, identity rule 80, source 16, label 24, and details 60 characters;
leading/trailing spaces and empty values fail. Input/config files are limited to
16 KiB each; state/reports to 1 MiB; HTTP bodies to 512 KiB. Source text is data;
it is never executed or fetched as a URL.

Private writes use file sync, rename, and directory sync. A lock excludes
concurrent commands. After a crash, inspect `.linkage/.lock/owner.json` or
`.pingroom/.lock/owner.json`, confirm the old process stopped, and remove only the
stale lock. Restore corrupt state from a valid backup. Local files are mutable;
this is not a tamper-proof audit or distributed exactly-once delivery guarantee.
Server idempotency retention is not assumed permanent. Credentials, inputs,
state, and reports are ignored by Git; keep backups private. Files use `0600`
and private directories `0700` on POSIX.

The [official SDK](https://github.com/pingroom/sdk) is pinned to **0.6.0** with a
lockfile and a 14-day minimum release age. Requests use the official API origin,
reject redirects, and have a five-second deadline through body consumption.
CI checks Node 22 and 24 with mocked success, failure, recovery, transport, and
storage cases. Live phone delivery is not tested.

Unlike [preference ranking](https://github.com/pingroom/starter-preference-ranking),
this workflow establishes proposed identity groups rather than an ordering.
Unlike [three-way merge](https://github.com/pingroom/starter-three-way-merge), it
compares distinct source records to decide identity, without selecting field values.

MIT licensed; see [LICENSE](LICENSE).
