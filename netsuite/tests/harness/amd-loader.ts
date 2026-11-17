/**
 * Tiny AMD loader for unit-testing SuiteScript files outside NetSuite.
 *
 * WHY: SuiteScript 2.x files are AMD modules: `define(['N/record', './lib'], (record, lib) => {...})`.
 * NetSuite provides the `N/*` modules at runtime. Here we provide FAKE `N/*` modules (stubs) so that
 * our business logic can be tested on a laptop in milliseconds, without a NetSuite account.
 *
 * IMPORTANT: passing tests here proves our *logic* is right. It does NOT prove NetSuite behaves like
 * our stubs. Real behaviour (governance, permissions, field availability) must be verified in a sandbox.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

export const SUITESCRIPTS_ROOT = resolve(__dirname, '../../src/FileCabinet/SuiteScripts/northstar');

export type Stubs = Record<string, unknown>;

/**
 * Loads a SuiteScript file and returns what its `define` factory returned.
 * @param relPath path relative to SUITESCRIPTS_ROOT, e.g. "user-events/nsd_ue_vendor_bill.js"
 * @param stubs fake implementations of N/* modules, e.g. { 'N/log': fakeLog }
 */
export function loadSuiteScript<T = Record<string, unknown>>(relPath: string, stubs: Stubs = {}): T {
  const cache = new Map<string, unknown>();

  function load(absPath: string): unknown {
    if (cache.has(absPath)) return cache.get(absPath);
    const code = readFileSync(absPath, 'utf8');
    let exported: unknown;

    // `define` is what the SuiteScript file calls. We resolve each dependency, then run the factory.
    const define = (deps: string[], factory: (...args: unknown[]) => unknown) => {
      const resolved = deps.map((dep) => {
        if (dep.startsWith('N/')) {
          if (!(dep in stubs)) throw new Error(`No stub provided for ${dep} (needed by ${relPath})`);
          return stubs[dep];
        }
        // Relative module, e.g. '../lib/nsd_constants'
        return load(resolve(dirname(absPath), dep.endsWith('.js') ? dep : `${dep}.js`));
      });
      exported = factory(...resolved);
    };

    // Run the file in an isolated context that only knows about `define` and basic globals.
    vm.runInNewContext(code, { define, Date, JSON, Math, Object, Array, String, Number, Error }, { filename: absPath });
    cache.set(absPath, exported);
    return exported;
  }

  return load(resolve(SUITESCRIPTS_ROOT, relPath)) as T;
}

/** A fake N/log that records calls so tests can assert on them. */
export function fakeLog() {
  const entries: { level: string; title: string; details: unknown }[] = [];
  const make = (level: string) => (title: string | { title: string; details: unknown }, details?: unknown) => {
    // N/log accepts either (title, details) or ({ title, details }).
    if (typeof title === 'object') entries.push({ level, title: title.title, details: title.details });
    else entries.push({ level, title, details });
  };
  return { entries, debug: make('debug'), audit: make('audit'), error: make('error'), emergency: make('emergency') };
}
