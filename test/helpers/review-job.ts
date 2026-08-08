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

/**
 * The corpus the consistency golden is built from, and the corpus
 * {@link GOLDEN_EVIDENCE} is the analysis of - which is the point of it being
 * four rows rather than two. `AC-1` is {@link GOLDEN_REVIEW_ROW}, so the
 * evidence in the bilingual golden prompt is a value this corpus produces
 * rather than a value a test author typed.
 *
 * Between them the rows cover every branch of the analysis: one source rendered
 * two ways (`name` on AC-1 and AC-2), one rendered consistently (`name` on AC-3
 * and AC-4, which produces no entry at all), one whose target value is missing
 * (`description` on AC-4, which renders as the empty string rather than
 * vanishing), and one source that appears once (`description` on AC-1).
 */
export const GOLDEN_CORPUS = [
  GOLDEN_REVIEW_ROW,
  {
    identifier: 'AC-2',
    source: {
      name: 'Access Control Policy',
      type: 'passthrough',
      description: 'The organization reviews the policy.',
    },
    target: {
      name: 'Politique de gestion des acces',
      type: 'passthrough',
      description: 'L organisation reexamine la politique.',
    },
  },
  {
    identifier: 'AU-1',
    source: {
      name: 'Audit Records',
      type: 'passthrough',
      description: 'The system retains records.',
    },
    target: {
      name: 'Registres d audit',
      type: 'passthrough',
      description: 'Le systeme conserve les enregistrements.',
    },
  },
  {
    identifier: 'AU-2',
    source: {
      name: 'Audit Records',
      type: 'passthrough',
      description: 'The system retains records.',
    },
    target: { name: 'Registres d audit', type: 'passthrough' },
  },
] as const;
