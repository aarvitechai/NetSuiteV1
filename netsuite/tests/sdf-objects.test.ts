/**
 * Consistency checks between scripts and SDF objects.
 * WHY: a field ID used in a script but missing from SDF would deploy fine and then silently return
 * empty values at runtime. This test catches that before deployment.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSuiteScript } from './harness/amd-loader';

const OBJECTS = resolve(__dirname, '../src/Objects');

type Constants = {
  BODY: Record<string, string>;
  ENTITY: Record<string, string>;
  RECORD: Record<string, string>;
  INT_LOG_FIELD: Record<string, string>;
};

describe('SDF objects', () => {
  const C = loadSuiteScript<Constants>('lib/nsd_constants.js');

  it('has an object XML for every body, entity field and custom record in nsd_constants', () => {
    for (const id of [...Object.values(C.BODY), ...Object.values(C.ENTITY), ...Object.values(C.RECORD)]) {
      expect(existsSync(resolve(OBJECTS, `${id}.xml`)), `${id}.xml missing`).toBe(true);
    }
  });

  it('declares every integration-log field inside the custom record XML', () => {
    const xml = readFileSync(resolve(OBJECTS, 'customrecord_nsd_int_log.xml'), 'utf8');
    for (const id of Object.values(C.INT_LOG_FIELD)) expect(xml).toContain(`scriptid="${id}"`);
  });

  it('uses the file name as the scriptid (SDF requirement)', () => {
    for (const file of readdirSync(OBJECTS).filter((f) => f.endsWith('.xml'))) {
      const xml = readFileSync(resolve(OBJECTS, file), 'utf8');
      expect(xml).toContain(`scriptid="${file.replace('.xml', '')}"`);
    }
  });

  it('uses the nsd prefix for every custom object (avoids clashes with other SuiteApps)', () => {
    for (const file of readdirSync(OBJECTS))
      expect(file).toMatch(
        /^(custbody|custentity|customrecord|customscript|customdeploy|customworkflow)_nsd_/,
      );
  });
});
