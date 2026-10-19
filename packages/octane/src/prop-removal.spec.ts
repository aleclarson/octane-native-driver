import { cssTreeParse } from '@nativescript/core/css/css-tree-parser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  UniversalHostCommand,
  UniversalRoot,
} from 'octane/universal/native';

const registry = vi.hoisted(() => ({
  properties: [] as unknown[],
  styles: [{ name: 'width', cssName: 'width' }],
}));
vi.mock(
  '@nativescript/core/ui/core/properties',
  async () => import('@nativescript/core'),
);
vi.mock('@nativescript/core', async () => ({
  ...(await import('../tests/core-mock.js')).createCoreMock(),
  _getProperties: () => registry.properties,
  _getStyleProperties: () => registry.styles,
}));

import { unsetValue } from '@nativescript/core';
import { MockLayoutBase, MockView } from '../tests/core-mock.js';
import {
  createNativeScriptContainer,
  nativeScriptDriver,
  releaseNativeScriptContainer,
  type NativeScriptContainer,
} from './driver.js';
import { registerElement, type ElementConstructor } from './elements.js';

/** Models core's sentinel-consuming Property/CssProperty accessors, rather
 * than accepting nullish assignments as ordinary JavaScript field writes. */
class ResetHost extends MockView {
  readonly writes: unknown[] = [];
  ordinary = 'constructor default';
  #value: unknown = 'registered default';
  #width: unknown = 'auto';
  #hasLocalWidth = false;
  #class: unknown = '';
  classWidth: unknown = 'auto';
  cssRefreshes = 0;
  readonly variables = new Map<string, unknown>();

  constructor() {
    super();
    delete (this as unknown as Record<string, unknown>).className;
    Object.defineProperty(this, 'className', {
      get: () => this.#class,
      set: (value: unknown) => {
        this.writes.push(['className', value]);
        this.#class = value === unsetValue ? '' : value;
        this.classWidth = this.#class === 'wide' ? 80 : 'auto';
        this._cssState.onChange();
      },
    });
    this.style.customField = 'style constructor default';
    this.style.removeUnscopedCssVariable = (name: string) =>
      this.variables.delete(name);
    Object.defineProperty(this.style, 'width', {
      configurable: true,
      get: () => this.#width,
      set: (value: unknown) => {
        this.writes.push(['width', value]);
        // Core clears its cached CSS value when a local value is removed;
        // matching selectors must run again to restore the cascade.
        this.#hasLocalWidth = value !== unsetValue;
        this.#width = value === unsetValue ? 'auto' : value;
      },
    });
  }

  override setInlineStyle(css: string): void {
    super.setInlineStyle(css);
    const sheet = cssTreeParse(`local { ${css} }`, undefined);
    for (const declaration of sheet.stylesheet.rules[0].declarations) {
      if (declaration.type !== 'declaration') continue;
      const key: string = declaration.property;
      const raw: string = declaration.value;
      if (key.startsWith('--')) this.variables.set(key, raw);
      else this.style[key] = /^\d+$/.test(raw) ? Number(raw) : raw;
    }
  }

  readonly _cssState = {
    onChange: () => {
      this.cssRefreshes++;
      if (!this.#hasLocalWidth) this.#width = this.classWidth;
    },
  };

  get width(): unknown {
    return this.style.width;
  }
  set width(value: unknown) {
    this.style.width = value;
  }

  get value(): unknown {
    return this.#value;
  }
  set value(value: unknown) {
    this.writes.push(['value', value]);
    this.#value = value === unsetValue ? 'registered default' : value;
    this.notify({ eventName: 'valueChange', object: this, value: this.#value });
  }
}

registry.properties.push({
  name: 'value',
  set: Object.getOwnPropertyDescriptor(ResetHost.prototype, 'value')!.set,
});

const live: NativeScriptContainer[] = [];
afterEach(() => {
  for (const container of live.splice(0))
    releaseNativeScriptContainer(container);
});

function mount() {
  registerElement(
    'reset-regression',
    ResetHost as unknown as ElementConstructor,
  );
  const container = createNativeScriptContainer(new MockLayoutBase() as never);
  live.push(container);
  const dispatched: unknown[] = [];
  container.root = {
    eventScope: <T>(_priority: unknown, run: () => T) => run(),
    dispatchEvent: (_id: number, data: unknown) => dispatched.push(data),
  } as unknown as UniversalRoot;
  const apply = (...commands: UniversalHostCommand[]) =>
    nativeScriptDriver
      .prepareBatch(
        container,
        { renderer: 'nativescript', version: 1, commands },
        {} as never,
      )
      .apply();
  const update = (props: Record<string, unknown>) =>
    apply({ op: 'update', id: 1, props });
  const view = () =>
    nativeScriptDriver.getPublicInstance(container, 1) as unknown as ResetHost;
  const create = (props: Record<string, unknown>) =>
    apply(
      { op: 'create', id: 1, type: 'reset-regression', props },
      { op: 'insert', id: 1, parent: null, before: null },
    );
  return { apply, create, update, view, dispatched };
}

describe('prop removal', () => {
  it('never invokes a native setter for an initially undefined prop', () => {
    const { create, update, view } = mount();
    create({ value: undefined, className: undefined });
    update({ value: undefined, className: undefined });
    expect(view().writes).toEqual([]);
    expect(view().value).toBe('registered default');
  });

  it.each([
    {},
    { value: undefined, ordinary: undefined },
    { value: null, ordinary: null },
  ])('restores registered and ordinary defaults for %j', (next) => {
    const { create, update, view } = mount();
    create({ value: 'authored', ordinary: 'authored' });
    update(next);
    expect(view().value).toBe('registered default');
    expect(view().ordinary).toBe('constructor default');
    expect(view().writes).toContainEqual(['value', unsetValue]);
    update({ value: 'again', ordinary: 'again' });
    update({});
    expect(view().ordinary).toBe('constructor default');
  });

  it('replaces authored style keys and restores matching class CSS after removal', () => {
    const { create, update, view } = mount();
    create({ className: 'wide', style: { width: 120, color: 'red' } });
    expect(view().style.width).toBe(120);
    update({ className: 'wide', style: { color: 'blue' } });
    expect(view().style.width).toBe(80);
    expect(view().style.color).toBe('blue');
    expect(view().writes).toContainEqual(['width', unsetValue]);
    update({ className: 'wide', style: { width: 140, color: null } });
    expect(view().style.color).toBeUndefined();
    update({ className: 'wide', style: null });
    expect(view().style.width).toBe(80);
    update({});
    expect(view().className).toBe('');
    expect(view().style.width).toBe('auto');
  });

  it('replaces string styles with objects and removes the remaining inline override', () => {
    const { create, update, view } = mount();
    create({
      className: 'wide',
      style: '/* inline */ width: 120; color: red; --image: url("data:x;a:b")',
    });
    expect(view().style.width).toBe(120);
    expect(view().style.color).toBe('red');
    update({ className: 'wide', style: { width: 140 } });
    expect(view().style.width).toBe(140);
    expect(view().style.color).toBeUndefined();
    expect(view().variables.has('--image')).toBe(false);
    update({ className: 'wide' });
    expect(view().style.width).toBe(80);
  });

  it('resets forwarded CssProperty props and restores their class value', () => {
    const { create, update, view } = mount();
    create({ className: 'wide', width: 120 });
    expect(view().width).toBe(120);
    update({ className: 'wide' });
    expect(view().width).toBe(80);
    expect(view().writes).toContainEqual(['width', unsetValue]);
  });

  it('restores the captured default for ordinary style fields', () => {
    const { create, update, view } = mount();
    create({ style: { customField: 'authored' } });
    update({ style: {} });
    expect(view().style.customField).toBe('style constructor default');
    update({ style: { customField: 'again' } });
    update({ style: { customField: undefined } });
    expect(view().style.customField).toBe('style constructor default');
    update({ style: { customField: 'again' } });
    update({});
    expect(view().style.customField).toBe('style constructor default');
  });

  it('mutes reset echoes while continuing to dispatch user changes', () => {
    const { create, apply, update, view, dispatched } = mount();
    create({ value: 'authored' });
    apply({
      op: 'event',
      id: 1,
      type: 'valueChange',
      listener: { id: 1, priority: 'discrete' },
    });
    update({});
    expect(view().value).toBe('registered default');
    expect(dispatched).toEqual([]);
    view().value = 'user edit';
    expect(dispatched).toEqual([
      expect.objectContaining({ value: 'user edit' }),
    ]);
  });

  it('does not replay removed props when a live element is replaced', () => {
    const { create, update, view } = mount();
    create({ ordinary: 'authored', value: 'authored', style: { width: 120 } });
    update({ className: 'wide' });
    class Replacement extends ResetHost {
      override ordinary = 'replacement default';
    }
    registerElement(
      'reset-regression',
      Replacement as unknown as ElementConstructor,
    );
    expect(view()).toBeInstanceOf(Replacement);
    expect(view().ordinary).toBe('replacement default');
    expect(view().value).toBe('registered default');
    expect(view().style.width).toBe(80);
  });
});
