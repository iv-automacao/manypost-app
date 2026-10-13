import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { FlowV2Schema } from '@manypost/contracts';
import { simulateFlow, type SimInput } from './flow-simulate';
import { validateFlow } from './flow-validate';

/** fixtures compartilhadas com a web (apps/web/src/features/automation/flow/logic.test.ts) */
const DIR = new URL('../../../../../testdata/automation-flows/', import.meta.url);
const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();

describe('fixtures de fluxo', () => {
  test('existem fixtures', () => expect(files.length).toBeGreaterThanOrEqual(9));
  for (const file of files) {
    const fx = JSON.parse(readFileSync(new URL(file, DIR), 'utf8')) as {
      name: string;
      username?: string;
      flow: unknown;
      inputs?: SimInput[];
      expect: { problems?: unknown[]; messages?: unknown[]; status?: string; answers?: Record<string, string> };
    };
    test(`${file}: ${fx.name}`, () => {
      const flow = FlowV2Schema.parse(fx.flow);
      expect(validateFlow(flow)).toEqual((fx.expect.problems ?? []) as ReturnType<typeof validateFlow>);
      if (fx.expect.messages) {
        const r = simulateFlow(flow, fx.inputs ?? [], { username: fx.username ?? null });
        expect(r.messages).toEqual(fx.expect.messages as typeof r.messages);
        expect(r.status).toBe(fx.expect.status as typeof r.status);
        if (fx.expect.answers) expect(r.answers).toEqual(fx.expect.answers);
      }
    });
  }
});
