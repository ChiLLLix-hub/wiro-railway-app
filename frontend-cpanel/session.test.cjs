const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(__dirname + '/session.js', 'utf8');
const response = (status = 200, data = { success: true }) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const storage = (values = new Map()) => ({
  getItem: key => values.get(key) || null,
  setItem: (key, value) => values.set(key, value),
  removeItem: key => values.delete(key)
});
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

let harnessSerial = 0;
function harness({ token = 'token-a', tab = 'tab-a', locks = new Set(), fetch, broadcast } = {}) {
  const instance = ++harnessSerial;
  const calls = [];
  const events = new Map();
  const timers = new Map();
  const elements = [];
  let serial = 0;
  let reloads = 0;
  const document = {
    createElement(tag) {
      const element = {
        tagName: tag.toUpperCase(), children: [], style: {}, textContent: '',
        setAttribute() {}, focus() {}, append(...children) { this.children.push(...children); },
        get firstChild() { return this.children[0]; }
      };
      elements.push(element);
      return element;
    }
  };
  document.body = document.createElement('body');
  const heldLocks = [];
  const window = {
    crypto: { randomUUID: () => `generated-${instance}-${tab}-${++serial}` },
    localStorage: storage(new Map(token ? [['wiroAuthToken', token]] : [])),
    sessionStorage: storage(new Map([['wiroTabId', tab]])),
    navigator: { locks: { request: async (key, options, callback) => {
      if (locks.has(key)) return callback(null);
      locks.add(key);
      heldLocks.push(key);
      return callback({ name: key });
    } } },
    setTimeout,
    setInterval(callback, delay) { assert.equal(delay, 25000); timers.set(1, callback); return 1; },
    clearInterval: id => timers.delete(id),
    addEventListener(name, callback) { events.set(name, callback); },
    location: { href: '', reload() { reloads++; } },
    async fetch(url, init = {}) {
      calls.push({ url, init });
      return fetch ? fetch(url, init) : response();
    }
  };
  if (broadcast) {
    delete window.navigator.locks;
    window.BroadcastChannel = broadcast;
  }
  vm.runInNewContext(source, { window, document, Headers, Response, console });
  const controller = window.WiroSession.create({ baseUrl: 'https://api.example/' });
  return {
    window, controller, calls, events, timers, document,
    panel: () => document.body.firstChild?.firstChild?.children,
    reloads: () => reloads,
    unload: () => heldLocks.forEach(key => locks.delete(key))
  };
}

test('serializes initial claim before concurrent protected calls and preserves headers', async () => {
  const started = deferred();
  const finish = deferred();
  const app = harness({ fetch: async url => {
    if (url.endsWith('/claim')) { started.resolve(); await finish.promise; }
    return response();
  } });
  const first = app.controller.fetch('/me', { headers: { 'Content-Type': 'application/json' } });
  const second = app.controller.fetch('/me/summary');
  await started.promise;
  assert.equal(app.calls.length, 1);
  assert.deepEqual(JSON.parse(app.calls[0].init.body), { takeover: false });
  finish.resolve();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  for (const { init } of app.calls) {
    assert.equal(init.headers.get('Authorization'), ['Bearer', 'token-a'].join(' '));
    assert.equal(init.headers.get('X-Tab-Id'), 'tab-a');
  }
  assert.equal(app.calls[1].init.headers.get('Content-Type'), 'application/json');
  assert.equal(app.timers.size, 1);
});

test('claim conflict stays blocked without retries; only an explicit click takes over', async () => {
  const app = harness({ fetch: async (url, init) => {
    if (url.endsWith('/claim') && !JSON.parse(init.body).takeover) {
      return response(409, { code: 'TAB_CONFLICT' });
    }
    return response();
  } });
  assert.equal((await app.controller.fetch('/me')).status, 409);
  assert.equal((await app.controller.fetch('/generate', { method: 'POST' })).status, 409);
  assert.equal(app.calls.length, 1);
  assert.equal(app.panel()[0].textContent, 'Already open in another tab');
  assert.equal(app.panel()[2].textContent, 'Use this tab instead');
  await app.panel()[2].onclick();
  assert.equal(app.calls.length, 2);
  assert.equal(JSON.parse(app.calls[1].init.body).takeover, true);
  assert.equal(app.reloads(), 1);
});

test('a newly logged-in token claims before /me; stale 401 cannot erase it', async () => {
  const started = deferred();
  const finish = deferred();
  const app = harness({ fetch: async (url, init) => {
    if (url === '/old') { started.resolve(); return finish.promise; }
    return response();
  } });
  const old = app.controller.fetch('/old');
  await started.promise;
  app.controller.setToken('token-new');
  assert.equal((await app.controller.fetch('/me')).status, 200);
  assert.equal(app.calls[2].url, 'https://api.example/auth/session/claim');
  assert.equal(app.calls[2].init.headers.get('Authorization'), ['Bearer', 'token-new'].join(' '));
  finish.resolve(response(401, { code: 'SESSION_REPLACED' }));
  await old;
  assert.equal(app.window.localStorage.getItem('wiroAuthToken'), 'token-new');
  assert.equal(app.controller.getToken(), 'token-new');
});

test('changed shared token is not adopted, even before the storage event arrives', async () => {
  const app = harness();
  await app.controller.fetch('/me');
  app.window.localStorage.setItem('wiroAuthToken', 'another-login');
  assert.equal((await app.controller.fetch('/me')).status, 401);
  assert.equal(app.calls.length, 2);
  assert.equal(app.controller.getToken(), '');
  assert.equal(app.panel()[0].textContent, 'Signed in elsewhere');
  assert.equal(app.window.localStorage.getItem('wiroAuthToken'), 'another-login');
});

test('storage events stop heartbeat immediately, without deleting the new shared token', async () => {
  const app = harness();
  await app.controller.fetch('/me');
  app.window.localStorage.setItem('wiroAuthToken', 'another-login');
  app.events.get('storage')({ key: 'wiroAuthToken' });
  assert.equal(app.timers.size, 0);
  assert.equal(app.controller.getToken(), '');
  assert.equal(app.window.localStorage.getItem('wiroAuthToken'), 'another-login');
});

test('a stale request cannot clear a newer token from another tab, even without a storage event', async () => {
  const started = deferred();
  const finish = deferred();
  const app = harness({ fetch: async url => {
    if (url === '/me') { started.resolve(); return finish.promise; }
    return response();
  } });
  const pending = app.controller.fetch('/me');
  await started.promise;
  app.window.localStorage.setItem('wiroAuthToken', 'another-login');
  finish.resolve(response(401, { code: 'SESSION_REPLACED' }));
  await pending;
  assert.equal(app.window.localStorage.getItem('wiroAuthToken'), 'another-login');
  assert.equal(app.panel()[0].textContent, 'Signed in elsewhere');
});

test('claim network failures resolve safely and only retry after explicit action', async () => {
  const app = harness({ fetch: async () => { throw new Error('offline'); } });
  assert.equal((await app.controller.fetch('/me')).status, 503);
  assert.equal((await app.controller.fetch('/me')).status, 503);
  assert.equal(app.calls.length, 1);
  assert.equal(app.panel()[2].textContent, 'Retry');
  await app.panel()[2].onclick();
  assert.equal(app.calls.length, 2);
  for (const call of app.calls) assert.equal(JSON.parse(call.init.body).takeover, false);
});

test('heartbeat carries identity and blocks on conflict without automatic takeover', async () => {
  const app = harness({ fetch: async url => url.endsWith('/heartbeat')
    ? response(409, { code: 'TAB_CONFLICT' }) : response() });
  await app.controller.fetch('/me');
  await app.timers.get(1)();
  assert.equal(app.calls.at(-1).init.headers.get('X-Tab-Id'), 'tab-a');
  assert.equal(app.calls.at(-1).init.method, 'POST');
  assert.equal(app.timers.size, 0);
  assert.equal((await app.controller.fetch('/me')).status, 409);
  assert.equal(app.calls.length, 3);
});

test('session replacement and ordinary expiry display appropriate messages', async () => {
  for (const [code, title] of [['SESSION_REPLACED', 'Signed in elsewhere'], ['TOKEN_EXPIRED', 'Session expired']]) {
    const app = harness({ fetch: async url => url.endsWith('/claim') ? response() : response(401, { code }) });
    assert.equal((await app.controller.fetch('/me')).status, 401);
    assert.equal(app.panel()[0].textContent, title);
    assert.equal(app.window.localStorage.getItem('wiroAuthToken'), null);
    assert.equal(app.timers.size, 0);
  }
});

test('logout sends token and tab headers without first claiming a lease', async () => {
  const app = harness();
  assert.equal(await app.controller.logout(), true);
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].url, 'https://api.example/auth/logout');
  assert.equal(app.calls[0].init.headers.get('Authorization'), ['Bearer', 'token-a'].join(' '));
  assert.equal(app.calls[0].init.headers.get('X-Tab-Id'), 'tab-a');
  assert.equal(app.window.localStorage.getItem('wiroAuthToken'), null);
});

test('logout waits for server confirmation and serializes repeated clicks', async () => {
  const started = deferred();
  const finish = deferred();
  const app = harness({ fetch: async () => { started.resolve(); return finish.promise; } });
  const first = app.controller.logout();
  const second = app.controller.logout();
  await started.promise;
  assert.equal(app.calls.length, 1);
  assert.equal(app.window.localStorage.getItem('wiroAuthToken'), 'token-a');
  assert.equal(app.controller.getToken(), 'token-a');
  finish.resolve(response());
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(app.window.localStorage.getItem('wiroAuthToken'), null);
});

test('logout 503 retains session and offers explicit revoke retry without claiming', async () => {
  let attempts = 0;
  const app = harness({ fetch: async () => ++attempts === 1 ? response(503) : response() });
  assert.equal(await app.controller.logout(), false);
  assert.equal(app.window.localStorage.getItem('wiroAuthToken'), 'token-a');
  assert.equal(app.controller.getToken(), 'token-a');
  assert.equal(app.panel()[0].textContent, 'Unable to log out');
  assert.match(app.panel()[1].textContent, /still signed in/);
  assert.equal(app.panel()[2].textContent, 'Retry logout');
  assert.equal((await app.controller.fetch('/me')).status, 503);
  assert.equal(app.calls.length, 1);
  await app.panel()[2].onclick();
  assert.equal(app.window.location.href, 'index.html');
  assert.equal(app.window.localStorage.getItem('wiroAuthToken'), null);
  assert.equal(app.calls.length, 2);
  assert.ok(app.calls.every(call => call.url.endsWith('/auth/logout')));
});

test('offline logout does not falsely claim that server sign-out succeeded', async () => {
  const app = harness({ fetch: async () => { throw new Error('offline'); } });
  assert.equal(await app.controller.logout(), false);
  assert.equal(app.window.localStorage.getItem('wiroAuthToken'), 'token-a');
  assert.equal(app.panel()[0].textContent, 'Unable to log out');
  assert.equal(app.window.location.href, '');
});

test('logout response cannot clear a newer token written while revoke was pending', async () => {
  const started = deferred();
  const finish = deferred();
  const app = harness({ fetch: async () => { started.resolve(); return finish.promise; } });
  const pending = app.controller.logout();
  await started.promise;
  app.window.localStorage.setItem('wiroAuthToken', 'new-account');
  finish.resolve(response());
  assert.equal(await pending, false);
  assert.equal(app.window.localStorage.getItem('wiroAuthToken'), 'new-account');
  assert.equal(app.panel()[0].textContent, 'Signed in elsewhere');
});

test('logout can complete locally if the server confirms the session is already invalid', async () => {
  const app = harness({ fetch: async () => response(401, { code: 'SESSION_REPLACED' }) });
  assert.equal(await app.controller.logout(), true);
  assert.equal(app.window.localStorage.getItem('wiroAuthToken'), null);
});

test('outgoing navigation lock is retried briefly before assigning a different tab identity', async () => {
  const locks = new Set(['wiro-tab:tab-a']);
  const app = harness({ locks });
  setTimeout(() => locks.delete('wiro-tab:tab-a'), 20);
  assert.equal((await app.controller.fetch('/me')).status, 200);
  assert.equal(app.calls[0].init.headers.get('X-Tab-Id'), 'tab-a');
  assert.equal(app.window.sessionStorage.getItem('wiroTabId'), 'tab-a');
});

test('blocked requests and stale timers never reclaim; takeover ignores stale pending 409 and 401', async () => {
  const pending409 = deferred();
  const pending401 = deferred();
  const started409 = deferred();
  const started401 = deferred();
  const app = harness({ fetch: async url => {
    if (url === '/slow409') { started409.resolve(); return pending409.promise; }
    if (url === '/slow401') { started401.resolve(); return pending401.promise; }
    if (url.endsWith('/heartbeat')) return response(409, { code: 'TAB_CONFLICT' });
    return response();
  } });
  await app.controller.fetch('/me');
  const stale409 = app.controller.fetch('/slow409');
  const stale401 = app.controller.fetch('/slow401');
  await Promise.all([started409.promise, started401.promise]);
  const oldHeartbeat = app.timers.get(1);
  await oldHeartbeat();
  const callsWhenBlocked = app.calls.length;
  await oldHeartbeat();
  assert.equal((await app.controller.fetch('/generate', { method: 'POST' })).status, 409);
  assert.equal((await app.controller.fetch('/me')).status, 409);
  assert.equal(app.calls.length, callsWhenBlocked);
  await app.panel()[2].onclick();
  assert.equal(app.reloads(), 1);
  pending409.resolve(response(409, { code: 'TAB_CONFLICT' }));
  pending401.resolve(response(401, { code: 'SESSION_REPLACED' }));
  await Promise.all([stale409, stale401]);
  assert.equal(app.controller.getToken(), 'token-a');
  assert.equal(app.window.localStorage.getItem('wiroAuthToken'), 'token-a');
  assert.equal((await app.controller.fetch('/me')).status, 200);
  const claims = app.calls.filter(call => call.url.endsWith('/claim'));
  assert.equal(claims.length, 2);
  assert.equal(claims.filter(call => JSON.parse(call.init.body).takeover).length, 1);
});

test('duplicate tabs get different IDs; navigation reuses ID without releasing server lease', async () => {
  const locks = new Set();
  const first = harness({ locks });
  const duplicate = harness({ locks });
  await Promise.all([first.controller.fetch('/me'), duplicate.controller.fetch('/me')]);
  const firstId = first.calls[0].init.headers.get('X-Tab-Id');
  const duplicateId = duplicate.calls[0].init.headers.get('X-Tab-Id');
  assert.notEqual(firstId, duplicateId);
  first.unload();
  const refreshed = harness({ locks, tab: firstId });
  await refreshed.controller.fetch('/me');
  assert.equal(refreshed.calls[0].init.headers.get('X-Tab-Id'), firstId);
  assert.equal(first.calls.some(call => call.url.endsWith('/logout')), false);
});

test('BroadcastChannel fallback separates simultaneous duplicated identities', async () => {
  const channels = [];
  class Channel {
    constructor() { channels.push(this); }
    postMessage(data) {
      for (const other of channels) {
        if (other !== this) queueMicrotask(() => other.onmessage?.({ data }));
      }
    }
    close() {}
  }
  const first = harness({ broadcast: Channel });
  const duplicate = harness({ broadcast: Channel });
  await Promise.all([first.controller.fetch('/me'), duplicate.controller.fetch('/me')]);
  assert.notEqual(first.calls[0].init.headers.get('X-Tab-Id'), duplicate.calls[0].init.headers.get('X-Tab-Id'));
});
