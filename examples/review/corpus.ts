// The data the review CLI works on: a corpus, a translation job, and the review
// job that judges what the translation job produced.
//
// It is here rather than in `cli.ts` so that file is nothing but the lifecycle.
// Nothing in this file is library API; it is the part a host writes.
//
// Two things about the corpus are deliberate and would otherwise look like
// sloppiness:
//
//   * **Three rows carry stray whitespace.** The offline reviewer judges
//     whitespace and nothing else, so a corpus without any would review clean
//     and demonstrate nothing. It is also the most realistic defect there is:
//     text lifted out of a PDF or a spreadsheet is full of it, and a translation
//     pass carries it straight through.
//   * **One row is withdrawn**, and the job answers it itself. That is what
//     `precomputed` is for on the translate side and `settledByConstruction` on
//     the review side: a fixed string has nothing for a reviewer to judge, and
//     asking one to judge it once per row is as many chances to word it
//     differently as there are rows.

import {
  type Fields,
  hashInput,
  type ReviewJob,
  type StoreRecord,
  type TranslationJob,
} from '../../src/index.ts';

/** The rows, as this host happens to hold them. */
const CORPUS: { identifier: string; family: string; title: string; statement: string }[] = [
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
    // Two spaces after "allowed", carried in from the source document.
    statement:
      'Define and document the types of accounts allowed  and specifically prohibited for use within the system.',
  },
  {
    identifier: 'AC-3',
    family: 'Access Control',
    title: 'Access Enforcement',
    statement:
      'Enforce approved authorizations for logical access to information and system resources.',
  },
  {
    identifier: 'AU-6',
    family: 'Audit and Accountability',
    title: 'Audit Record Review',
    // Two spaces after "records".
    statement:
      'Review and analyze system audit records  for indications of inappropriate or unusual activity.',
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
    family: 'Identification and Authentication',
    // Two spaces, in a title rather than a statement, so one row proposes a
    // change to a field the others do not.
    title: 'User  Identification',
    statement:
      'Uniquely identify and authenticate organizational users and associate that identity with processes.',
  },
  {
    identifier: 'SC-7',
    family: 'System and Communications Protection',
    title: 'Boundary Protection',
    statement:
      'Monitor and control communications at the external managed interfaces to the system.',
  },
  {
    identifier: 'PS-2',
    family: 'Personnel Security',
    title: 'Withdrawn',
    statement: '[Withdrawn: Incorporated into PM-13.]',
  },
];

/**
 * The fixed answer for a withdrawn control.
 *
 * Exact rather than a prefix test, as `precomputed` asks: a row that merely
 * resembles the pattern should still reach the model. Every translatable field
 * has to be answered, because the engine puts what comes back through the same
 * guardrails a model answer faces.
 */
function withdrawn(source: Readonly<Fields>): Fields | null {
  if (source.title !== 'Withdrawn') return null;
  const match = source.statement?.match(/^\[Withdrawn: Incorporated into (.+)\.\]$/);
  if (!match) return null;
  return { title: 'Retiré', statement: `[Retiré : intégré à ${match[1]}.]` };
}

export const translationJob: TranslationJob = {
  id: 'controls',
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
  precomputed: withdrawn,
  validators: [],
};

/** The corpus as the registry stores it. `rowNumber` is the host's key. */
export const records: StoreRecord[] = CORPUS.map((row, i) => {
  const source = { title: row.title, family: row.family, statement: row.statement };
  return {
    rowNumber: i + 1,
    identifier: row.identifier,
    source,
    seedSucceeded: false,
    inputHash: hashInput(row.identifier, source),
  };
});

/**
 * Standing reference material, rendered as the prompt's TERMINOLOGY block.
 *
 * Text rather than a structure: what a term entry looks like is a judgement
 * about one language pair and one domain. It is hashed into the run id, so
 * editing a line here gives you a different run.
 */
const TERMINOLOGY = [
  'control -> contrôle',
  'system -> système',
  'policy -> politique',
  "audit record -> enregistrement d'audit",
].join('\n');

/**
 * The reviewer's standing guidance, bilingual.
 *
 * A separate text from the monolingual one below rather than one text with a
 * conditional sentence, because the two passes are asking different questions
 * and guidance that hedges between them is guidance for neither.
 */
const BILINGUAL_GUIDANCE = [
  'You are reviewing a French translation of an information security control catalogue',
  'against its English source.',
  '',
  'Judge fidelity first: a rendering that reads well and says something the source does',
  'not is worse than an awkward one that is accurate. Then judge terminology against the',
  'block above. Propose a rewrite only where you would change the published text.',
].join('\n');

/** The same corpus with the source withheld: a coherence judgement, not a fidelity one. */
const MONOLINGUAL_GUIDANCE = [
  'You are reviewing a French information security control catalogue on its own terms.',
  'You will not be shown a source text, and there is no fidelity question to answer.',
  '',
  'Judge whether each entry reads as normative French, is internally consistent with the',
  'rest of the catalogue, and uses the terminology above. Propose a rewrite only where',
  'you would change the published text.',
].join('\n');

/**
 * The review job for one of the two passes.
 *
 * `reviewFields` is left unset, so the reviewer judges the translatable fields:
 * `title` and `statement`, and not the passthrough `family`.
 */
export function reviewJobFor(showSource: boolean): ReviewJob {
  return {
    id: showSource ? 'controls-review' : 'controls-review-mono',
    translation: translationJob,
    promptTemplate: showSource ? BILINGUAL_GUIDANCE : MONOLINGUAL_GUIDANCE,
    showSource,
    terminology: TERMINOLOGY,
  };
}
