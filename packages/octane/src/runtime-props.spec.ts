import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defineUniversalComponent,
  universalPlan,
  universalProps,
  universalValue,
  type UniversalHostCommand,
} from 'octane/universal/native';

vi.mock(
  '@nativescript/core/ui/core/properties',
  async () => import('@nativescript/core'),
);
vi.mock('@nativescript/core', async () =>
  (await import('../tests/core-mock.js')).createCoreMock(),
);

import type { ViewBase } from '@nativescript/core';
import { MockLayoutBase } from '../tests/core-mock.js';
import { NATIVESCRIPT_RENDERER_ID } from './config.js';
import { createNativeScriptRoot, nativeScriptDriver } from './driver.js';

const RID = NATIVESCRIPT_RENDERER_ID;

afterEach(() => vi.restoreAllMocks());

describe('Octane runtime prop snapshots', () => {
  it('keeps compiled static props in a dynamic binding update', () => {
    const plan = universalPlan(RID, {
      kind: 'host',
      type: 'label',
      props: { width: 120 },
      bindings: [['text', 0]],
    });
    const Scene = defineUniversalComponent(RID, (props: { text: string }) =>
      universalValue(plan, [props.text]),
    );
    const prepare = vi.spyOn(nativeScriptDriver, 'prepareBatch');
    const root = createNativeScriptRoot(
      new MockLayoutBase() as unknown as ViewBase,
    );
    try {
      root.render(Scene, { text: 'before' });
      prepare.mockClear();
      root.render(Scene, { text: 'after' });
      const updates = prepare.mock.calls
        .flatMap(([, batch]) => batch.commands)
        .filter((command) => command.op === 'update');
      expect(updates).toHaveLength(1);
      expect(updates[0].props).toEqual({ width: 120, text: 'after' });
    } finally {
      root.unmount();
    }
  });

  it('omits removed spread keys while preserving authored static props', () => {
    const plan = universalPlan(RID, {
      kind: 'host',
      type: 'label',
      propsSlot: 0,
    });
    const Scene = defineUniversalComponent(
      RID,
      (props: { extra: Record<string, unknown> }) =>
        universalValue(plan, [
          universalProps([
            ['set', 'width', 120],
            ['spread', props.extra],
          ]),
        ]),
    );
    const prepare = vi.spyOn(nativeScriptDriver, 'prepareBatch');
    const root = createNativeScriptRoot(
      new MockLayoutBase() as unknown as ViewBase,
    );
    try {
      root.render(Scene, { extra: { text: 'before', opacity: 0.5 } });
      prepare.mockClear();
      root.render(Scene, { extra: { text: 'after' } });
      const updates = prepare.mock.calls
        .flatMap(([, batch]) => batch.commands)
        .filter(
          (
            command,
          ): command is Extract<UniversalHostCommand, { op: 'update' }> =>
            command.op === 'update',
        );
      expect(updates).toHaveLength(1);
      expect(updates[0].props).toEqual({ width: 120, text: 'after' });
      expect(Object.hasOwn(updates[0].props, 'opacity')).toBe(false);
    } finally {
      root.unmount();
    }
  });
});
