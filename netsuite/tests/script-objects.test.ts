/**
 * Every SDF script object must point to a script file that exists, and every script file must
 * declare a matching @NScriptType. This catches typos in paths before `suitecloud project:deploy`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '../src');
const TYPE_BY_TAG: Record<string, string> = {
  usereventscript: 'UserEventScript',
  clientscript: 'ClientScript',
  scheduledscript: 'ScheduledScript',
  mapreducescript: 'MapReduceScript',
  suitelet: 'Suitelet',
  restlet: 'Restlet',
};

describe('SDF script objects', () => {
  const files = readdirSync(resolve(SRC, 'Objects')).filter((f) => f.startsWith('customscript_'));

  it('defines one object per script type', () => {
    expect(files).toHaveLength(Object.keys(TYPE_BY_TAG).length);
  });

  it.each(files)('%s references an existing file with the right @NScriptType', (file) => {
    const xml = readFileSync(resolve(SRC, 'Objects', file), 'utf8');
    const tag = /<(\w+) scriptid="customscript_/.exec(xml)?.[1] ?? '';
    const path = /<scriptfile>\[(.+)]<\/scriptfile>/.exec(xml)?.[1] ?? '';
    const scriptPath = resolve(SRC, 'FileCabinet', `.${path}`);
    expect(existsSync(scriptPath), scriptPath).toBe(true);
    expect(readFileSync(scriptPath, 'utf8')).toContain(`@NScriptType ${TYPE_BY_TAG[tag]}`);
  });
});
