// Just enough browser for the front end's modules to import and run under Node.
//
// env.js reads `location` and looks up the camera elements at import time and caches them, so
// these stubs have to be installed before the first import and the element objects have to keep
// their identity for the life of the process - one registry per test file, reset between tests.
//
// Elements here form a real tree: `append`/`insertBefore` record a parent, `remove()` detaches,
// and `closest()` walks the parents. That is not decoration. Two things the game screen does now
// depend on it - the HUD keeps a row per player and moves it with `insertBefore` rather than
// rebuilding the bar, and a tap anywhere on the game screen fires *except* on a control, which is
// `event.target.closest('button, dialog')`. A registry of parentless elements cannot tell those
// apart, so `fireAt()` below dispatches the way a browser does: the target first, then up through
// its parents, which is also what keeps a tap on an overlay that is *not* inside #game-screen
// (the debug readout, a direct child of <body>) from reaching the game screen's listener.

// Taking a node out of wherever it currently is. `indexOf` has to be checked rather than passed
// straight to splice: a -1 would splice from the end and quietly take a *sibling* out of the tree
// instead, which is exactly the kind of helper bug that makes a test pass for the wrong reason.
function detach(node) {
  const siblings = node.parentElement?.children;
  const at = siblings?.indexOf(node) ?? -1;
  if (at >= 0) siblings.splice(at, 1);
  node.parentElement = null;
}

function matches(el, selector) {
  return selector
    .split(',')
    .map((part) => part.trim())
    .some((part) => {
      if (part.startsWith('#')) return el.id === part.slice(1);
      if (part.startsWith('.')) return el.classes.has(part.slice(1));
      return el.tagName === part.toUpperCase();
    });
}

function makeElement(id = '', tagName = 'DIV') {
  const el = {
    id,
    tagName,
    textContent: '',
    className: '',
    hidden: false,
    disabled: false,
    open: false,
    value: '',
    type: '',
    srcObject: null,
    style: { setProperty(name, value) { this[name] = value; } },
    dataset: {},
    children: [],
    parentElement: null,
    classes: new Set(),
    listeners: new Map(),
    // Markup set as a string is not parsed; querySelector below answers for it instead.
    innerHTMLValue: '',
    get innerHTML() {
      return this.innerHTMLValue;
    },
    set innerHTML(value) {
      this.innerHTMLValue = value;
      if (!value) this.replaceChildren();
    },
    get firstChild() {
      return this.children[0] ?? null;
    },
    get lastChild() {
      return this.children.at(-1) ?? null;
    },
    append(...nodes) {
      for (const node of nodes) {
        detach(node);
        node.parentElement = this;
        this.children.push(node);
      }
    },
    insertBefore(node, before) {
      detach(node);
      node.parentElement = this;
      const at = before ? this.children.indexOf(before) : -1;
      if (at === -1) this.children.push(node);
      else this.children.splice(at, 0, node);
      return node;
    },
    replaceChildren(...nodes) {
      for (const child of this.children) child.parentElement = null;
      this.children = [];
      this.append(...nodes);
    },
    remove() {
      const siblings = this.parentElement?.children;
      if (siblings) siblings.splice(siblings.indexOf(this), 1);
      this.parentElement = null;
    },
    closest(selector) {
      for (let node = el; node; node = node.parentElement) if (matches(node, selector)) return node;
      return null;
    },
    querySelectorAll(selector) {
      const found = [];
      const walk = (node) => {
        for (const child of node.children) {
          if (matches(child, selector)) found.push(child);
          walk(child);
        }
      };
      walk(this);
      return found;
    },
    // A real querySelector would find the nodes an innerHTML string created, and several of the
    // screens build their inner markup that way (the health bar's fill and chip, the copy
    // button's <use>). Parsing HTML is far more than these tests need, so a selector that matches
    // no real child gets a stub element, remembered so the same selector keeps the same object.
    querySelector(selector) {
      const [real] = this.querySelectorAll(selector);
      if (real) return real;
      this.stubs ??= new Map();
      if (!this.stubs.has(selector)) this.stubs.set(selector, makeElement('', 'DIV'));
      return this.stubs.get(selector);
    },
    setAttribute(name, value) {
      this.attributes ??= {};
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return this.attributes?.[name] ?? null;
    },
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
    },
    focus() {},
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
  // Elements start parentless and as plain divs. A test that cares about the tree - which, since
  // `closest('button, dialog')` became the guard on firing, means anything about the game screen -
  // builds it, and `buildPage()` in tap-to-fire.test.js builds it out of index.html itself so the
  // tags and the nesting are the page's own rather than a guess.
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
    createElement: (tag) => makeElement('', tag.toUpperCase()),
    body: makeElement('body', 'BODY'),
    addEventListener: listen(documentListeners),
    removeEventListener: unlisten(documentListeners),
    visibilityState: 'visible',
  };
  globalThis.window = {
    addEventListener: listen(windowListeners),
    removeEventListener: unlisten(windowListeners),
    // sound.js reaches for `window.AudioContext`, and app.js now unlocks audio from a document
    // listener on every tap and key, so any test that dispatches one reaches it.
    get AudioContext() {
      return globalThis.AudioContext;
    },
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
  globalThis.Audio = class {
    play() {
      return Promise.resolve();
    }
  };
  // Enough of Web Audio for sound.js's one `tone()` helper to run for real. It only ever runs
  // once something has called `unlock()`, which app.js now does from a document listener on every
  // tap and key - so any test that dispatches one plays sound, and a half-built node throws.
  const param = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} });
  globalThis.AudioContext = class {
    constructor() {
      this.state = 'running';
    }
    createOscillator() {
      // connect() returns the node it connected to, which is how `osc.connect(gain).connect(…)`
      // reaches the destination.
      return { connect: (to) => to, start() {}, stop() {}, frequency: param(), type: '' };
    }
    createGain() {
      return { connect: (to) => to, gain: param() };
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
    // Dispatch at an element and let the event bubble, which is the only way to ask "does a tap
    // here reach that listener?" - the question tap-to-fire turns on. Parent elements are set by
    // append/insertBefore, so a test has to build the bit of tree it cares about (see
    // tap-to-fire.test.js).
    fireAt(target, type, event = {}) {
      const dispatched = { type, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...event };
      for (let node = target; node; node = node.parentElement) {
        dispatched.currentTarget = node;
        for (const fn of node.listeners.get(type) ?? []) fn(dispatched);
      }
      return dispatched;
    },
    reset() {
      for (const element of elements.values()) {
        element.textContent = '';
        element.innerHTML = '';
        element.hidden = false;
        element.disabled = false;
        element.open = false;
        element.replaceChildren();
        element.classes.clear();
        element.dataset = {};
        element.srcObject = null;
      }
      globalThis.localStorage.store.clear();
    },
  };
}
