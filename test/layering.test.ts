// The layer boundaries of `src/`, enforced mechanically.
//
// The package sells a provider layer that knows nothing about translation
// (that is what the `translation-harness/providers` subpath export promises),
// and a store layer that knows nothing about providers. A rule like that is not
// kept by review: the codebase this was extracted from broke exactly this rule
// once, silently, with one attentive author reading it daily. So it is a test.
//
// Deliberately not Biome's `noRestrictedImports`: that rule matches specifier
// *strings*, and a relative specifier varies with the importing file's depth
// (`../contract/prompt.ts` versus `../../contract/prompt.ts`), so the pattern
// set is fragile and incomplete in a way nothing reports. It also cannot
// express "every file belongs to a known layer", which is the assertion that
// keeps this test from quietly dying the first time someone adds `src/util/`.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

type Layer =
  | 'errors'
  | 'provider'
  | 'batch'
  | 'job'
  | 'contract'
  | 'store'
  | 'review'
  | 'pipeline'
  | 'index';

/**
 * The rule, as data. Each layer may import the layers listed and nothing else
 * inside `src/`; a layer may always import itself. Widening the rule is a
 * visible diff on this literal, which is the point of writing it as one.
 *
 * Three edges are worth stating out loud, because each has been got wrong:
 *
 * - `contract` may import `provider`. The mock provider registers itself and
 *   needs the invoker types, and it lives in `contract/` because it parses the
 *   prompt payload, which is translation knowledge the provider layer must not
 *   have. That is the allowed direction.
 * - `store` may **not** import `provider`. The registry records a provider name
 *   and a model id as strings. If a store method ever wants a provider type,
 *   that is a design change and it should cost an edit here.
 * - `provider` may **not** import `job`. `job.ts` sits at the root next to
 *   `errors.ts` and looks equally neutral. It is not: it is where translation
 *   is defined, and the subpath export promises a translation-free provider.
 * - `batch` may **not** import `job`, `contract` or `store`. Those are where
 *   translation is defined, and `translation-harness/batch` promises a runner
 *   that has never heard of it. `store` importing `batch` is the allowed
 *   direction of that edge: `TranslationStore` extends `BatchStore`.
 * - `review` may **not** import `pipeline`. Both are lifecycles built on
 *   `batch`, and they are siblings: a review that reached into the translation
 *   runner would be the beginning of a third runner nobody decided to write.
 *   Its list is deliberately narrow and grows one edge at a time, so each new
 *   dependency is a diff on this literal rather than a licence granted early.
 *   It gained `store` when `initializeReview` landed, which is the direction
 *   `pipeline` already takes: the lifecycle names the seam it writes through.
 *   The reverse edge is the one to watch - `store` must not import `review`,
 *   or the SQLite implementation and the lifecycle it stores become one thing.
 *
 * `index` appears in no allow-list, which is how "nothing imports the barrel"
 * is enforced without a second rule.
 */
const MAY_IMPORT: Record<Layer, readonly Layer[]> = {
  errors: [],
  provider: ['errors'],
  batch: ['errors', 'provider'],
  job: ['errors'],
  contract: ['errors', 'job', 'provider'],
  store: ['errors', 'job', 'batch'],
  review: ['errors', 'job', 'store'],
  pipeline: ['errors', 'job', 'provider', 'batch', 'contract', 'store'],
  index: ['errors', 'job', 'provider', 'batch', 'contract', 'store', 'review', 'pipeline'],
};

/** Single-file layers, keyed by their path relative to `src/`. */
const FILE_LAYERS: ReadonlyMap<string, Layer> = new Map([
  ['errors.ts', 'errors'],
  ['job.ts', 'job'],
  ['index.ts', 'index'],
]);

/** Directory layers, keyed by their first path segment under `src/`. */
const DIR_LAYERS: ReadonlyMap<string, Layer> = new Map([
  ['provider', 'provider'],
  ['batch', 'batch'],
  ['contract', 'contract'],
  ['store', 'store'],
  ['review', 'review'],
  ['pipeline', 'pipeline'],
]);

/** The layer a file belongs to, or `null` if the table does not claim it. */
export function layerOf(relPath: string): Layer | null {
  const posix = relPath.split(sep).join('/');
  const direct = FILE_LAYERS.get(posix);
  if (direct) return direct;
  const [head] = posix.split('/');
  if (head === undefined || head === posix) return null; // a root file, not in FILE_LAYERS
  return DIR_LAYERS.get(head) ?? null;
}

/** Every `.ts` file under `src/`, as paths relative to `src/`. */
function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.ts')) found.push(relative(SRC, full));
    }
  };
  walk(SRC);
  return found.sort();
}

/**
 * Blank out comments and regular-expression literals, leaving string and
 * template literals in place, since the specifier we are after lives inside
 * one. Without this a doc comment that names a sibling module (and this
 * codebase's doc comments do) would read as an import edge.
 *
 * Exported for the self-test below. TypeScript 7's `typescript` package
 * publishes no compiler JS API (its only exports are `version` and
 * `versionMajorMinor`), so `ts.preProcessFile` is not an option here and this
 * scanner is the alternative.
 */
export function blankNonCode(source: string): string {
  // A `/` opens a regular expression only where a value may begin. Tracking the
  // last non-whitespace character that survived approximates that well enough:
  // after something a value can end with, the `/` is division.
  const DIVIDES_AFTER = /[\w$)\]]/;
  const WHITESPACE = /\s/;

  const out: string[] = [];
  let i = 0;
  let prev = '';

  /** Emit the character at `i` verbatim and advance. */
  const keep = (): void => {
    const ch = source[i] as string;
    out.push(ch);
    if (!WHITESPACE.test(ch)) prev = ch;
    i += 1;
  };
  /** Replace the character at `i` with a space (newlines survive) and advance. */
  const blank = (): void => {
    out.push(source[i] === '\n' ? '\n' : ' ');
    i += 1;
  };

  while (i < source.length) {
    const ch = source[i] as string;
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') blank();
      continue;
    }

    if (ch === '/' && next === '*') {
      blank();
      blank();
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) blank();
      if (i < source.length) {
        blank();
        blank();
      }
      continue;
    }

    if (ch === '/' && !DIVIDES_AFTER.test(prev)) {
      // A regular expression literal. Blanked wholesale: its body is not code
      // and could otherwise contain anything, including a quote or a `//`.
      blank();
      let inClass = false;
      while (i < source.length) {
        const c = source[i] as string;
        if (c === '\\') {
          blank();
          if (i < source.length) blank();
          continue;
        }
        if (c === '\n') break; // unterminated; bail rather than eat the rest of the file
        blank();
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
      }
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      // Kept, not blanked: the specifier we are looking for is a string body.
      // Template substitutions are not parsed, which is fine, because nothing
      // inside one can be a static import.
      keep();
      while (i < source.length) {
        const c = source[i] as string;
        if (c === '\\') {
          keep();
          if (i < source.length) keep();
          continue;
        }
        keep();
        if (c === ch) break;
        if (c === '\n' && ch !== '`') break; // unterminated single-line string
      }
      continue;
    }

    keep();
  }
  return out.join('');
}

/**
 * Relative import specifiers in a module. `node:` builtins and bare package
 * specifiers are not our business and are dropped.
 *
 * The two static forms are anchored to the start of a line. Every static import
 * and re-export in ESM is a statement, and this tree is Biome-formatted, so
 * they always are; anchoring means a quoted specifier appearing mid-expression
 * cannot be mistaken for one. The dynamic form is matched anywhere, which is
 * safe because comments are already blanked.
 */
export function relativeSpecifiers(source: string): string[] {
  const code = blankNonCode(source);
  const patterns = [
    /^[ \t]*(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/gm,
    /^[ \t]*import\s*['"]([^'"]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  const found = new Set<string>();
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const spec = match[1];
      if (spec?.startsWith('.')) found.add(spec);
    }
  }
  return [...found].sort();
}

describe('the import scanner', () => {
  it('ignores specifiers that only appear in comments', () => {
    const src = [
      "// see `import { x } from './ghost.ts'` for the shape",
      '/**',
      ' * Mirrors ./ghost.ts, which is not imported here.',
      ' */',
      "import { real } from './real.ts';",
    ].join('\n');
    assert.deepEqual(relativeSpecifiers(src), ['./real.ts']);
  });

  it('is not confused by a URL or a regular expression', () => {
    const src = [
      "const docs = 'https://example.invalid/a//b';",
      "const pattern = /['\"]\\/\\/from '.\\/ghost.ts'/g;",
      "import { real } from './real.ts';",
    ].join('\n');
    assert.deepEqual(relativeSpecifiers(src), ['./real.ts']);
  });

  it('finds every import form and drops bare and builtin specifiers', () => {
    const src = [
      "import { readFileSync } from 'node:fs';",
      "import yaml from 'yaml';",
      "import type { A } from './a.ts';",
      'import {',
      '  b,',
      "} from './deep/b.ts';",
      "export * from '../c.ts';",
      "export type { D } from './d.ts';",
      "import './side-effect.ts';",
      "const e = await import('./e.ts');",
    ].join('\n');
    assert.deepEqual(relativeSpecifiers(src), [
      '../c.ts',
      './a.ts',
      './d.ts',
      './deep/b.ts',
      './e.ts',
      './side-effect.ts',
    ]);
  });
});

describe('the layer map', () => {
  // Without these, every assertion below passes vacuously while `src/` is still
  // being filled in, and nobody finds out until the rule has already been broken.
  it('claims the files and directories the table declares', () => {
    assert.equal(layerOf('errors.ts'), 'errors');
    assert.equal(layerOf('job.ts'), 'job');
    assert.equal(layerOf('index.ts'), 'index');
    assert.equal(layerOf(join('provider', 'run.ts')), 'provider');
    assert.equal(layerOf(join('batch', 'run.ts')), 'batch');
    assert.equal(layerOf(join('contract', 'mock.ts')), 'contract');
    assert.equal(layerOf(join('store', 'sqlite.ts')), 'store');
    assert.equal(layerOf(join('review', 'prompt.ts')), 'review');
    assert.equal(layerOf(join('pipeline', 'run.ts')), 'pipeline');
  });

  it('claims nothing else, so a new directory cannot opt out by existing', () => {
    assert.equal(layerOf(join('util', 'helpers.ts')), null);
    assert.equal(layerOf('stray.ts'), null);
  });

  it('forbids the edges the boundary exists to forbid', () => {
    assert.ok(!MAY_IMPORT.provider.includes('job'), 'provider must not know about translation');
    assert.ok(!MAY_IMPORT.store.includes('provider'), 'the store records names, not providers');
    for (const domain of ['job', 'contract', 'store'] as const) {
      assert.ok(
        !MAY_IMPORT.batch.includes(domain),
        `the batch runner must not know about ${domain}: that is what its subpath export promises`,
      );
    }
    assert.ok(
      !MAY_IMPORT.review.includes('pipeline'),
      'the two lifecycles are siblings over batch, not one built on the other',
    );
    assert.ok(
      !MAY_IMPORT.store.includes('review'),
      'the review lifecycle names the store seam; the store must not name the lifecycle',
    );
    for (const [layer, allowed] of Object.entries(MAY_IMPORT)) {
      if (layer === 'index') continue;
      assert.ok(!allowed.includes('index'), `${layer} must not import the barrel`);
    }
  });
});

describe('src/ layering', () => {
  it('maps every file to exactly one declared layer', () => {
    const unclaimed = sourceFiles().filter((file) => layerOf(file) === null);
    assert.deepEqual(
      unclaimed,
      [],
      `these files under src/ belong to no declared layer:\n  ${unclaimed.join('\n  ')}\n` +
        'Add the directory to DIR_LAYERS (or the file to FILE_LAYERS) and give it a row ' +
        'in MAY_IMPORT and in docs/architecture.md. A new directory must not opt itself ' +
        'out of this check by existing.',
    );
  });

  it('resolves every relative import to a file that exists inside src/', () => {
    const dangling: string[] = [];
    for (const file of sourceFiles()) {
      const from = join(SRC, file);
      for (const spec of relativeSpecifiers(readFileSync(from, 'utf8'))) {
        const target = resolve(dirname(from), spec);
        if (!target.startsWith(SRC + sep) || !existsSync(target)) {
          dangling.push(`${file} -> ${spec}`);
        }
      }
    }
    assert.deepEqual(
      dangling,
      [],
      `these relative imports do not resolve to a file inside src/:\n  ${dangling.join('\n  ')}`,
    );
  });

  it('allows no import edge the layer table forbids', () => {
    const violations: string[] = [];
    for (const file of sourceFiles()) {
      const fromLayer = layerOf(file);
      if (fromLayer === null) continue; // reported by the mapping test
      const from = join(SRC, file);

      for (const spec of relativeSpecifiers(readFileSync(from, 'utf8'))) {
        const target = resolve(dirname(from), spec);
        if (!target.startsWith(SRC + sep)) continue; // reported by the resolution test
        const toLayer = layerOf(relative(SRC, target));
        if (toLayer === null) continue;
        if (toLayer === fromLayer) continue; // within a layer, always fine
        if (MAY_IMPORT[fromLayer].includes(toLayer)) continue;
        violations.push(
          `${file} (${fromLayer}) -> ${relative(SRC, target).split(sep).join('/')} (${toLayer})`,
        );
      }
    }
    assert.deepEqual(
      violations.sort(),
      [],
      `these imports cross a layer boundary the table forbids:\n  ${violations.join('\n  ')}\n` +
        'Either move the code, or change MAY_IMPORT above and say why in the commit.',
    );
  });
});
