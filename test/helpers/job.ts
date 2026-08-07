// A small job used across the contract tests, and by the golden-file generator.
//
// Deliberately boring: two translatable fields and one passthrough, which is the
// smallest shape that can go wrong in an interesting way. The passthrough field
// is what catches a change that starts asking the model to translate everything
// it was handed.

import type { TranslationJob } from '../../src/job.ts';

export const TEST_JOB: TranslationJob = {
  id: 'test',
  sourceLang: 'English',
  targetLang: 'French',
  fields: [
    { key: 'name', label: 'Name', translate: true, required: true },
    { key: 'type', label: 'Type', translate: false, required: false },
    { key: 'description', label: 'Description', translate: true, required: false },
  ],
  promptTemplate: 'DOMAIN GUIDANCE',
  validators: [],
};

/** The row the golden files are generated from. */
export const GOLDEN_ROW = {
  identifier: 'AC-1',
  source: {
    name: 'Access Control Policy',
    type: 'passthrough',
    description: 'The organization develops [Assignment: organization-defined] procedures.',
  },
} as const;
