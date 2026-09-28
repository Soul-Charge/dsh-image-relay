// Client-half tests for dsh-image-relay.
//
// The bundle is browser code in the pre-built __ModuleLoader__ form. These tests
// load it with a stub loader and a fake slots registry, then RENDER the captured
// component through a miniature React runtime (component functions, hook state,
// dep-keyed effects, microtask flushing) and walk the host tree it produced.
// That exercises the same pure function the browser calls, including the async
// attachment load, with no build step and no DOM.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(here, '..', 'src', 'client.js');

let passed = 0;
let failed = 0;
const queue = [];

/** Register a test; sync and async bodies both work. */
function test(name, fn) {
  queue.push({ name, fn });
}

function sameDeps(left, right) {
  if (left === undefined || right === undefined) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => Object.is(value, right[index]));
}

/**
 * Miniature React: component functions render directly, hooks persist per
 * component path, effects are dep-keyed, and the driver flushes microtasks so a
 * resolved attachment loader produces a real second pass.
 */
class Runtime {
  constructor() {
    this.boxes = new Map();
    this.current = null;
    this.dirty = false;
  }

  useState(initial) {
    const box = this.current;
    const index = box.cursor++;
    if (!Object.hasOwn(box.state, index)) {
      box.state[index] = typeof initial === 'function' ? initial() : initial;
    }
    const set = (value) => {
      const next = typeof value === 'function' ? value(box.state[index]) : value;
      if (Object.is(next, box.state[index])) return;
      box.state[index] = next;
      this.dirty = true;
    };
    return [box.state[index], set];
  }

  useEffect(fn, deps) {
    const box = this.current;
    const index = box.cursor++;
    box.effectSlots[index] = { fn, deps };
  }

  /** The React-shaped object the bundle's factory receives. */
  get react() {
    const self = this;
    return {
      createElement(type, props, ...children) {
        return { type, props: props ?? {}, children };
      },
      Fragment: Symbol('Fragment'),
      useState: (initial) => self.useState(initial),
      useEffect: (fn, deps) => self.useEffect(fn, deps)
    };
  }

  renderTree(node, path) {
    if (node === null || node === undefined || typeof node === 'boolean') return [];
    if (typeof node === 'string' || typeof node === 'number') return [String(node)];
    if (Array.isArray(node)) return node.flatMap((child, index) => this.renderTree(child, path + '.' + index));
    const type = node.type;
    if (typeof type === 'function') {
      let box = this.boxes.get(path);
      if (box === undefined) {
        box = { state: {}, effectSlots: [], effectRecords: [], cursor: 0 };
        this.boxes.set(path, box);
      }
      box.cursor = 0;
      box.effectSlots = [];
      const previous = this.current;
      this.current = box;
      let out;
      try {
        out = type({ ...node.props, children: node.children });
      } finally {
        this.current = previous;
      }
      return this.renderTree(out, path + '/out');
    }
    return [
      {
        type,
        props: node.props,
        children: node.children.flatMap((child, index) => this.renderTree(child, path + '#' + index))
      }
    ];
  }

  /** Run every effect whose deps changed since its last run. */
  runEffects() {
    const due = [];
    for (const box of this.boxes.values()) {
      for (let index = 0; index < box.effectSlots.length; index++) {
        const slot = box.effectSlots[index];
        if (slot === undefined) continue;
        const previous = box.effectRecords[index];
        if (previous !== undefined && sameDeps(previous.deps, slot.deps)) continue;
        due.push({ box, index, slot, previous });
      }
    }
    for (const { box, index, slot, previous } of due) {
      if (previous !== undefined && typeof previous.cleanup === 'function') previous.cleanup();
      const cleanup = slot.fn();
      box.effectRecords[index] = { deps: slot.deps, cleanup };
    }
  }

  /** Render until no state change follows a microtask flush. */
  async mount(component, props) {
    let tree = [];
    for (let pass = 0; pass < 12; pass++) {
      this.dirty = false;
      tree = this.renderTree(component(props), 'root');
      this.runEffects();
      await Promise.resolve();
      await Promise.resolve();
      if (!this.dirty) return tree;
    }
    throw new Error('component never settled');
  }
}

/** Load the bundle and return its exports. */
function loadBundle(runtime) {
  let registration = null;
  const windowStub = {
    __ModuleLoader__: {
      load(def) {
        registration = def;
      }
    }
  };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', readFileSync(bundlePath, 'utf8'))(windowStub, undefined);
  assert.ok(registration !== null, 'bundle must register via __ModuleLoader__.load');
  assert.equal(registration.id, 'dsh-image-relay');
  const mod = registration.factory((spec) => {
    if (spec === 'react') return runtime.react;
    throw new Error('unexpected require: ' + spec);
  });
  return { mod, registration };
}

/** Register the toolview through a fake slots service and capture the component. */
function captureComponent(mod) {
  const registrations = [];
  const slots = {
    inject(name, callback) {
      callback();
    },
    register(declaration, component) {
      registrations.push({ declaration, component });
    }
  };
  mod.apply({ slots, plugin: (child) => child.apply({ slots }) });
  assert.equal(registrations.length, 1, 'exactly one toolview registration');
  return registrations[0];
}
/** All rendered host nodes with the given tag, depth-first. */
function findAll(nodes, tag) {
  const found = [];
  const walk = (list) => {
    for (const node of list) {
      if (typeof node === 'string') continue;
      if (node.type === tag) found.push(node);
      walk(node.children);
    }
  };
  walk(nodes);
  return found;
}

/** Concatenated text of the whole rendered tree. */
function textOf(nodes) {
  const parts = [];
  const walk = (list) => {
    for (const node of list) {
      if (typeof node === 'string') parts.push(node);
      else walk(node.children);
    }
  };
  walk(nodes);
  return parts.join(' ');
}

/** Build a settled tool-result block carrying the given content blocks. */
function settled(content, extra = {}) {
  return {
    kind: 'tool-result',
    callId: 'call_1',
    seq: 1,
    time: 0,
    call: { name: 'relay_image_generate', argsRaw: JSON.stringify({ prompt: 'a red apple' }) },
    callTime: 0,
    content,
    isError: false,
    subCalls: [],
    ...extra
  };
}

const ATTACHMENT = {
  attachmentId: 'sha256:abc',
  mediaType: 'image/png',
  bytes: 1234,
  width: 1024,
  height: 1024,
  name: 'relay-gpt-image-2.png'
};

function ownerProps(block, overrides = {}) {
  return {
    callId: 'call_1',
    toolName: 'relay_image_generate',
    block,
    loadImage: Object.assign(
      (attachment) => Promise.resolve('blob:' + attachment.attachmentId),
      { peek: () => null }
    ),
    openFile: () => {},
    t: (key) => key,
    ...overrides
  };
}

const runtime = new Runtime();
const { mod, registration } = loadBundle(runtime);
const { declaration, component } = captureComponent(mod);
const renderRow = (block, overrides) => runtime.mount(component, ownerProps(block, overrides));
// ---------------------------------------------------------------------------
// Manifest / registration
// ---------------------------------------------------------------------------

test('bundle registers under the package name', () => {
  assert.equal(registration.id, 'dsh-image-relay');
});

test('exports the cordis plugin surface', () => {
  assert.equal(typeof mod.apply, 'function');
  assert.deepEqual(mod.inject, ['slots']);
});

test('registers exactly the relay_image_generate keyed toolview', () => {
  assert.equal(declaration.name, 'tool.call.toolview');
  assert.equal(declaration.key, 'relay_image_generate');
  assert.equal(declaration.locale, 'conversation');
  assert.equal(typeof component, 'function');
});

test('does not declare the single-child tool.call.images slot (read_image owns it)', () => {
  assert.equal(declaration.children, undefined);
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test('renders an <img> for a result carrying an image block', async () => {
  const tree = await renderRow(
    settled([
      { type: 'text', text: 'Generated image for: a red apple' },
      { type: 'image', attachment: ATTACHMENT }
    ])
  );
  const images = findAll(tree, 'img');
  assert.equal(images.length, 1);
  assert.equal(images[0].props.alt, 'relay-gpt-image-2.png');
  assert.equal(images[0].props.src, 'blob:sha256:abc');
});

test('renders the eager <img> when the loader already peeked the attachment', async () => {
  const tree = await renderRow(settled([{ type: 'image', attachment: ATTACHMENT }]), {
    loadImage: Object.assign(() => Promise.resolve('blob:x'), { peek: () => 'blob:cached' })
  });
  const images = findAll(tree, 'img');
  assert.equal(images.length, 1);
  assert.equal(images[0].props.src, 'blob:cached');
});

test('shows a retry control when the attachment loader rejects', async () => {
  const tree = await renderRow(settled([{ type: 'image', attachment: ATTACHMENT }]), {
    loadImage: Object.assign(() => Promise.reject(new Error('nope')), { peek: () => null })
  });
  assert.equal(findAll(tree, 'img').length, 0);
  assert.ok(textOf(tree).includes('failed'), 'expected a load-failure message');
  assert.equal(findAll(tree, 'button').length, 1);
});

test('renders every image when several are returned', async () => {
  const tree = await renderRow(
    settled([
      { type: 'image', attachment: ATTACHMENT },
      { type: 'image', attachment: { ...ATTACHMENT, attachmentId: 'sha256:def', name: 'b.png' } }
    ])
  );
  assert.equal(findAll(tree, 'img').length, 2);
});

test('renders no <img> for an error result', async () => {
  const block = settled([{ type: 'text', text: 'Image generation failed' }], {
    isError: true,
    error: { name: 'HarnessError', code: 'X' }
  });
  const tree = await renderRow(block);
  assert.equal(findAll(tree, 'img').length, 0);
  assert.ok(textOf(tree).includes('failed'), 'expected a failure label');
});

test('shows the prompt alongside the image', async () => {
  const tree = await renderRow(settled([{ type: 'image', attachment: ATTACHMENT }]));
  assert.ok(textOf(tree).includes('a red apple'), 'expected the prompt in the label');
});

test('reports a running call before any result settles', async () => {
  const running = {
    callId: 'call_1',
    name: 'relay_image_generate',
    argsRaw: JSON.stringify({ prompt: 'a cat' }),
    subCalls: []
  };
  const tree = await renderRow(running);
  assert.equal(findAll(tree, 'img').length, 0);
  assert.ok(textOf(tree).includes('Generating'), 'expected a generating label');
});

test('survives malformed call arguments', async () => {
  const block = settled([{ type: 'image', attachment: ATTACHMENT }], {
    call: { name: 'relay_image_generate', argsRaw: 'not json' }
  });
  assert.equal(findAll(await renderRow(block), 'img').length, 1);
});

test('ignores content parts that are not well-formed image blocks', async () => {
  const tree = await renderRow(
    settled([
      { type: 'image', attachment: null },
      { type: 'image' },
      { type: 'text', text: 'ok' },
      { type: 'image', attachment: ATTACHMENT }
    ])
  );
  assert.equal(findAll(tree, 'img').length, 1);
});

test('renders no gallery when the result carries no image at all', async () => {
  const tree = await renderRow(settled([{ type: 'text', text: 'Saved to: /w/a.png' }]));
  assert.equal(findAll(tree, 'img').length, 0);
  assert.ok(textOf(tree).includes('no image'), 'expected a no-image label');
});

test('renders the saved path text so the result is actionable', async () => {
  const tree = await renderRow(
    settled([
      { type: 'text', text: 'Generated image for: x\nSaved to: /w/temp/imagegen/a.png' },
      { type: 'image', attachment: ATTACHMENT }
    ])
  );
  assert.ok(textOf(tree).includes('/w/temp/imagegen/a.png'));
});

// ---------------------------------------------------------------------------
// Saved-path recovery (the open-file affordance)
// ---------------------------------------------------------------------------

test('opens the file recovered from the "Saved to:" line', async () => {
  const opened = [];
  const tree = await renderRow(
    settled([
      { type: 'text', text: 'Generated image for: x\nSaved to: /w/temp/imagegen/a.png' },
      { type: 'image', attachment: ATTACHMENT }
    ]),
    { openFile: (path) => opened.push(path) }
  );
  const buttons = findAll(tree, 'button');
  assert.equal(buttons.length, 1, 'expected one open-file button');
  buttons[0].props.onClick();
  assert.deepEqual(opened, ['/w/temp/imagegen/a.png']);
});

test('prefers presentation metadata when DSH supplies it', async () => {
  const opened = [];
  const block = settled(
    [{ type: 'text', text: 'Saved to: /w/wrong.png' }, { type: 'image', attachment: ATTACHMENT }],
    { meta: { path: '/w/from-meta.png' } }
  );
  const tree = await renderRow(block, { openFile: (path) => opened.push(path) });
  findAll(tree, 'button')[0].props.onClick();
  assert.deepEqual(opened, ['/w/from-meta.png']);
});

test('renders no open-file button when the owner supplies no openFile', async () => {
  const tree = await renderRow(
    settled([{ type: 'text', text: 'Saved to: /w/a.png' }, { type: 'image', attachment: ATTACHMENT }]),
    { openFile: undefined }
  );
  assert.equal(findAll(tree, 'button').length, 0);
});

test('recovers the path from a <path> envelope as a fallback', async () => {
  const opened = [];
  const envelope =
    '<path>/w/envelope.png</path>\n<type>image</type>\n<content>\nsize\n</content>';
  const tree = await renderRow(
    settled([{ type: 'text', text: envelope }, { type: 'image', attachment: ATTACHMENT }]),
    { openFile: (path) => opened.push(path) }
  );
  findAll(tree, 'button')[0].props.onClick();
  assert.deepEqual(opened, ['/w/envelope.png']);
});

// ---------------------------------------------------------------------------

for (const { name, fn } of queue) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.log('FAIL  ' + name);
    console.log('      ' + (error && error.message ? String(error.message).split('\n')[0] : String(error)));
  }
}
console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
