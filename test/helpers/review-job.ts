// The review jobs the review golden files are generated from.
//
// Built on `TEST_JOB` rather than beside it, which is the point: a review job
// carries the translation job it judges, so the fields and the language pair
// cannot drift from the pass that produced them. The bilingual and monolingual
// forms differ only in `showSource` and the guidance, because R7's whole claim
// is that the two are the same job with a different framing.
//
// Between them the two golden prompts cover every optional block: the bilingual
// one carries terminology and consistency evidence, the monolingual one carries
// neither, so a change to when a block appears moves a golden either way.

import type { ReviewJob } from '../../src/review/job.ts';
import type { RowEvidence } from '../../src/review/prompt.ts';
import { TEST_JOB } from './job.ts';

/** The plain job: no terminology, both fields, source visible. */
export const REVIEW_TEST_JOB: ReviewJob = {
  id: 'test-review',
  translation: TEST_JOB,
  promptTemplate: 'REVIEWER GUIDANCE',
  showSource: true,
};

/** The same job with every optional block populated. */
export const FULL_FRAME_TEST_JOB: ReviewJob = {
  ...REVIEW_TEST_JOB,
  id: 'test-review-full',
  terminology: 'policy -> politique\naccess control -> controle d acces\n',
};

export const MONOLINGUAL_TEST_JOB: ReviewJob = {
  ...REVIEW_TEST_JOB,
  id: 'test-review-monolingual',
  promptTemplate: 'COHERENCE GUIDANCE',
  showSource: false,
};

/** The row the review golden files are generated from. */
export const GOLDEN_REVIEW_ROW = {
  identifier: 'AC-1',
  source: {
    name: 'Access Control Policy',
    type: 'passthrough',
    description: 'The organization develops [Assignment: organization-defined] procedures.',
  },
  target: {
    name: "Politique de controle d'acces",
    type: 'passthrough',
    description: 'L organisation elabore des procedures [Assignment: organization-defined].',
  },
} as const;

/** The evidence the bilingual golden is composed with. */
export const GOLDEN_EVIDENCE: RowEvidence = {
  name: ["Politique de controle d'acces", 'Politique de gestion des acces'],
};
