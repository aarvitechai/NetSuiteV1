/**
 * Parity test: the middleware and the NetSuite Map/Reduce must compute the SAME collection stage.
 * Both systems update the stage. If their rules drifted apart, an invoice could flip between stages.
 */
import { describe, expect, it } from 'vitest';
import { loadSuiteScript } from '../../../netsuite/tests/harness/amd-loader';
import { collectionStage } from '../../src/domain/ar';

const nsRules = loadSuiteScript<{ collectionStage(days: number, disputed: boolean): string }>(
  'lib/nsd_rules.js',
);

describe('collection stage parity (middleware vs SuiteScript)', () => {
  it('agrees for every day from -5 to 120, disputed or not', () => {
    for (let days = -5; days <= 120; days++) {
      for (const disputed of [false, true]) {
        expect(collectionStage(days, disputed), `days=${days} disputed=${disputed}`).toBe(
          nsRules.collectionStage(days, disputed),
        );
      }
    }
  });
});
