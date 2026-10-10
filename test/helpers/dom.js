// Just enough browser for the front end's modules to import and run under Node.
//
// env.js reads `location` and looks up the camera elements at import time and caches them, so
// these stubs have to be installed before the first import and the element objects have to keep
// their identity for the life of the process - one registry per test file, reset between tests.

function makeElement(id = '') {
  const el = {
    id,
    tagName: 'DIV',
    textContent: '',
    innerHTML: '',
    className: '',
    hidden: false,
    disabled: false,
    value: '',
    type: '',
    srcObject: null,
    style: {},
    children: [],
    classes: new Set(),
    listeners: new Map(),
    append(...nodes) {
      this.children.push(...nodes);
    },
    remove() {},
    addEventListener(type, fn) {
      const list = this.listeners.get(type) ?? [];
      list.push(fn);
      this.listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      const list = this.listeners.get(type) ?? [];
      this.listeners.set(
        type,
        list.filter((other) => other !== fn),
      );
    },
    getContext: () => ({
      clearRect() {},
      fillRect() {},
      strokeRect() {},
      drawImage() {},
      fillText() {},
      beginPath() {},
      stroke() {},
      save() {},
      restore() {},
      setTransform() {},
    }),
  };
  el.classList = {
    add: (...names) => names.forEach((name) => el.classes.add(name)),
    remove: (...names) => names.forEach((name) => el.classes.delete(name)),
    contains: (name) => el.classes.has(name),
    toggle: (name, on) => (on ? el.classes.add(name) : el.classes.delete(name)),
  };
  return el;
}

// Must run before anything imports env.js.
export function installBrowserStubs({ search = '' } = {}) {
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };

  const windowListeners = new Map();
  const documentListeners = new Map();
  const listen = (map) => (type, fn) => {
    const list = map.get(type) ?? [];
    list.push(fn);
    map.set(type, list);
  };
  const unlisten = (map) => (type, fn) => {
    map.set(type, (map.get(type) ?? []).filter((other) => other !== fn));
  };

  globalThis.location = { search, href: `https://phone.test/${search}` };
  globalThis.document = {
    getElementById: el,
    createElement: (tag) => {
      const created = makeElement();
      created.tagName = tag.toUpperCase();
      return created;
    },
    addEventListener: listen(documentListeners),
    removeEventListener: unlisten(documentListeners),
    visibilityState: 'visible',
  };
  globalThis.window = {
    addEventListener: listen(windowListeners),
    removeEventListener: unlisten(windowListeners),
  };
  // Node has a getter-only `navigator` of its own, so this one has to be defined over it.
  Object.defineProperty(globalThis, 'navigator', {
    value: { vibrate() {}, wakeLock: null },
    writable: true,
    configurable: true,
  });
  globalThis.localStorage = {
    store: new Map(),
    getItem(key) {
      return this.store.has(key) ? this.store.get(key) : null;
    },
    setItem(key, value) {
      this.store.set(key, String(value));
    },
    removeItem(key) {
      this.store.delete(key);
    },
  };
  globalThis.requestAnimationFrame = (fn) => setImmediate(() => fn(0));
  globalThis.EventSource = class {
    constructor(url) {
      this.url = url;
      EventSource.opened.push(url);
    }
    addEventListener() {}
    close() {
      EventSource.closed.push(this.url);
    }
  };
  globalThis.EventSource.opened = [];
  globalThis.EventSource.closed = [];
  globalThis.Audio = class {
    play() {
      return Promise.resolve();
    }
  };
  globalThis.AudioContext = class {
    createOscillator() {
      return { connect() {}, start() {}, stop() {}, frequency: { value: 0, setValueAtTime() {} }, type: '' };
    }
    createGain() {
      return { connect() {}, gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} } };
    }
    get destination() {
      return {};
    }
    get currentTime() {
      return 0;
    }
    resume() {
      return Promise.resolve();
    }
  };

  // The handler a `pagehide` (or any other) window event would reach.
  const fire = (map) => (type, event = {}) => {
    for (const fn of map.get(type) ?? []) fn(event);
  };

  return {
    $: el,
    elements,
    windowListeners,
    documentListeners,
    fireWindow: fire(windowListeners),
    fireDocument: fire(documentListeners),
    reset() {
      for (const element of elements.values()) {
        element.textContent = '';
        element.innerHTML = '';
        element.hidden = false;
        element.disabled = false;
        element.children = [];
        element.classes.clear();
        element.srcObject = null;
      }
      globalThis.EventSource.opened.length = 0;
      globalThis.EventSource.closed.length = 0;
      globalThis.localStorage.store.clear();
    },
  };
}
