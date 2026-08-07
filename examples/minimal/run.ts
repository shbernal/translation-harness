// A complete translation run, offline and free.
//
//   node examples/minimal/run.ts
//
// That is the whole setup. No API key, no CLI, no workbook, no network. The
// mock provider answers every row instantly so you can watch the machinery work
// before deciding whether you want it: the claim, the per-row transaction, the
// guardrails, the retained evidence, the resume.
//
// Run it twice. The second run translates nothing, because every row is already
// settled in the registry, which is the point of the whole library.

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import {
  hashInput,
  type RunEvent,
  registerMockProvider,
  runTranslation,
  type StoreRecord,
  sqliteStore,
  type TranslationJob,
} from '../../src/index.ts';

// ---------------------------------------------------------------------------
// 1. The job. Two translatable fields, one carried through untranslated.
// ---------------------------------------------------------------------------

const job: TranslationJob = {
  id: 'example',
  sourceLang: 'English',
  targetLang: 'French',
  fields: [
    { key: 'title', label: 'Control title', translate: true, required: true },
    { key: 'family', label: 'Control family', translate: false, required: false },
    { key: 'statement', label: 'Control statement', translate: true, required: false },
  ],
  promptTemplate: [
    'You are translating a catalogue of information security controls.',
    '',
    'Keep bracketed placeholders such as [Assignment: ...] exactly as they appear.',
    'Preserve every control reference (AC-2, SC-7(3)) unchanged.',
    'Match the register of the source: this is normative text, not marketing copy.',
  ].join('\n'),
  validators: [
    // A validator downgrades a row to review. It never fails one: the row is
    // still usable, it just wants a human to look at it.
    ({ source, translated }) => {
      const kept = Object.values(translated).some((v) => v?.includes('[Assignment:'));
      const had = Object.values(source).some((v) => v?.includes('[Assignment:'));
      return had && !kept ? ['a placeholder was dropped'] : [];
    },
  ],
};

// ---------------------------------------------------------------------------
// 2. The rows. Wherever yours come from (a spreadsheet, a database, an API),
//    they arrive here as plain objects. The library never reads your corpus.
// ---------------------------------------------------------------------------

const CORPUS: { identifier: string; title: string; family: string; statement: string }[] = [
  {
    identifier: 'AC-1',
    family: 'Access Control',
    title: 'Policy and Procedures',
    statement:
      'Develop, document, and disseminate an access control policy to [Assignment: organization-defined personnel].',
  },
  {
    identifier: 'AC-2',
    family: 'Access Control',
    title: 'Account Management',
    statement:
      'Define and document the types of accounts allowed and specifically prohibited for use within the system.',
  },
  {
    identifier: 'AC-3',
    family: 'Access Control',
    title: 'Access Enforcement',
    statement:
      'Enforce approved authorizations for logical access to information and system resources.',
  },
  {
    identifier: 'AU-2',
    family: 'Audit and Accountability',
    title: 'Event Logging',
    statement:
      'Identify the types of events that the system is capable of logging in support of the audit function.',
  },
  {
    identifier: 'AU-6',
    family: 'Audit and Accountability',
    title: 'Audit Record Review',
    statement:
      'Review and analyze system audit records for indications of inappropriate or unusual activity.',
  },
  {
    identifier: 'CM-2',
    family: 'Configuration Management',
    title: 'Baseline Configuration',
    statement:
      'Develop, document, and maintain under configuration control, a current baseline configuration of the system.',
  },
  {
    identifier: 'CP-9',
    family: 'Contingency Planning',
    title: 'System Backup',
    statement:
      'Conduct backups of user-level information contained in [Assignment: organization-defined system components].',
  },
  {
    identifier: 'IA-2',
    family: 'Identification',
    title: 'User Identification',
    statement:
      'Uniquely identify and authenticate organizational users and associate that identity with processes.',
  },
  {
    identifier: 'IR-4',
    family: 'Incident Response',
    title: 'Incident Handling',
    statement:
      'Implement an incident handling capability that is consistent with the incident response plan.',
  },
  {
    identifier: 'RA-5',
    family: 'Risk Assessment',
    title: 'Vulnerability Monitoring',
    statement: 'Monitor and scan for vulnerabilities in the system and hosted applications.',
  },
  {
    identifier: 'SA-8',
    family: 'System Acquisition',
    title: 'Security Engineering',
    statement:
      'Apply systems security and privacy engineering principles in the specification and design of the system.',
  },
  {
    identifier: 'SC-7',
    family: 'System Protection',
    title: 'Boundary Protection',
    statement:
      'Monitor and control communications at the external managed interfaces to the system.',
  },
  {
    identifier: 'SC-8',
    family: 'System Protection',
    title: 'Transmission Confidentiality',
    statement:
      'Protect the confidentiality and integrity of transmitted information, see also SC-7.',
  },
  {
    identifier: 'SI-2',
    family: 'System Integrity',
    title: 'Flaw Remediation',
    statement:
      'Identify, report, and correct system flaws within [Assignment: organization-defined time period].',
  },
  {
    identifier: 'SI-4',
    family: 'System Integrity',
    title: 'System Monitoring',
    statement: 'Monitor the system to detect attacks and indicators of potential attacks.',
  },
  {
    identifier: 'PL-2',
    family: 'Planning',
    title: 'System Security Plan',
    statement:
      'Develop security and privacy plans for the system that are consistent with the enterprise architecture.',
  },
  {
    identifier: 'PS-4',
    family: 'Personnel Security',
    title: 'Personnel Termination',
    statement:
      'Disable system access prior to or during personnel termination and retrieve organizational assets.',
  },
  {
    identifier: 'PE-3',
    family: 'Physical Protection',
    title: 'Physical Access Control',
    statement: 'Enforce physical access authorizations at entry and exit points to the facility.',
  },
  {
    identifier: 'MP-6',
    family: 'Media Protection',
    title: 'Media Sanitization',
    statement:
      'Sanitize system media prior to disposal, release out of organizational control, or release for reuse.',
  },
  {
    identifier: 'CA-7',
    family: 'Assessment',
    title: 'Continuous Monitoring',
    statement:
      'Develop a system-level continuous monitoring strategy and implement it, see also RA-5.',
  },
];

/** Turn your rows into what the registry stores. `rowNumber` is your key. */
const records: StoreRecord[] = CORPUS.map((row, i) => {
  const source = { title: row.title, family: row.family, statement: row.statement };
  return {
    rowNumber: i + 1,
    identifier: row.identifier,
    source,
    seedSucceeded: false,
    // The library's hash. Comparing it on a re-read is how a corpus that
    // changed under a half-finished run gets noticed instead of mixed.
    inputHash: hashInput(row.identifier, source),
  };
});

// ---------------------------------------------------------------------------
// 3. Run it.
// ---------------------------------------------------------------------------

// The offline provider is opt-in: nothing that fabricates plausible-looking
// translations should be one typo away from a real run.
registerMockProvider();

// A stable path, not a fresh temp directory, so the registry survives between
// runs. That is what makes the second run interesting: delete this directory to
// start over.
const workDir = join(tmpdir(), 'translation-harness-example');
mkdirSync(workDir, { recursive: true });
const store = sqliteStore(join(workDir, 'registry.sqlite3'), { pathBase: workDir });

// The library owns no output stream. This is where you decide what progress
// looks like: a log line, a progress bar, a metric, or nothing at all.
function render(event: RunEvent): void {
  switch (event.kind) {
    case 'row-settled':
      console.log(
        `[${event.completed}/${event.total}] ${event.identifier}: ${event.outcome}` +
          (event.precomputed ? ' (precomputed)' : ` (${event.durationSeconds.toFixed(1)}s)`),
      );
      break;
    case 'row-retrying':
      console.log(
        `[${event.completed}/${event.total}] ${event.identifier}: ${event.category}; ` +
          `retrying in ${(event.waitMs / 1000).toFixed(1)}s`,
      );
      break;
    case 'quota-paused':
      console.log(
        `[${event.completed}/${event.total}] ${event.identifier}: quota reached; pausing`,
      );
      break;
    case 'rows-released':
      console.log(`Released ${event.count} claimed rows back to pending`);
      break;
  }
}

// A library must not install a process-wide signal handler, so wiring one is
// yours. These two lines are the whole of it: in-flight rows still finish,
// because they are work already paid for.
const controller = new AbortController();
process.on('SIGINT', () => controller.abort());

const sync = await store.initialize(records);
console.log(`Registry at ${workDir}`);
console.log(`${sync.inserted} rows inserted, ${sync.reset} reset\n`);

const candidates = await store.selectCandidates({});
if (candidates.length === 0) {
  console.log('Nothing to do: every row is already settled.');
} else {
  const summary = await runTranslation(store, job, candidates, {
    cwd: workDir,
    workDir,
    provider: 'mock',

    // Swap the three lines above for these to use a real agent CLI. Nothing
    // else in this file changes. You will need `codex` (or `claude`) on PATH.
    //
    //   provider: 'codex',
    //   model: 'gpt-5.6-sol',
    //   reasoningEffort: 'high',
    //
    // Naming a model matters more than it looks: with none, the CLI falls back
    // to whatever that machine's own config says, and the run records its model
    // as `config-default`, which tells a later reader nothing.

    timeoutSeconds: 300,
    maxAttempts: 3,
    delaySeconds: 0,
    concurrency: 4,
    signal: controller.signal,
    onEvent: render,
  });

  console.log(
    `\n${summary.succeeded} succeeded, ${summary.review_required} need review, ` +
      `${summary.failed} failed`,
  );
}

const translations = await store.translationsByIdentifier();
const sample = translations.get('AC-1');
console.log(`\nAC-1 title  -> ${sample?.title}`);
console.log(`AC-1 family -> ${sample?.family ?? '(not translated: passthrough field)'}`);

const counts = await store.counts();
console.log(`\nRegistry: ${JSON.stringify(counts)}`);
console.log('Per-attempt evidence (stdout, stderr, the raw response) is under');
console.log(`  ${join(workDir, 'attempts')}`);

await store.close();
