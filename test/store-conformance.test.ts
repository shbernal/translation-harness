// The exported conformance suite, run against the store this package ships.
//
// It is not extra surface maintained for a hypothetical third party: it is this
// package's own regression net for the registry, and running it here is what
// keeps it honest for anyone else who implements the interface.

import { describe, test } from 'node:test';
import { storeConformance } from '../src/store/conformance.ts';
import { sqliteStore } from '../src/store/sqlite.ts';

describe('sqliteStore satisfies the TranslationStore contract', () => {
  for (const { name, run } of storeConformance(async () => sqliteStore(':memory:'))) {
    test(name, run);
  }
});
