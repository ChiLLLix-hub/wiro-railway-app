(() => {
  'use strict';

  const TOKEN_KEY = 'wiroAuthToken';
  const TAB_KEY = 'wiroTabId';
  const randomId = () => window.crypto.randomUUID
    ? window.crypto.randomUUID()
    : Array.from(window.crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16)).join('-');
  const readToken = () => {
    try { return window.localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
  };

  async function identifyTab() {
    let id;
    try { id = window.sessionStorage.getItem(TAB_KEY); } catch { /* Memory-only identity. */ }
    id = id || randomId();
    const save = () => {
      try { window.sessionStorage.setItem(TAB_KEY, id); } catch { /* Memory-only identity. */ }
    };

    // A duplicated tab inherits sessionStorage, but cannot inherit a live lock.
    if (window.navigator.locks) {
      try {
        while (true) {
          const acquired = await new Promise((resolve, reject) => {
            window.navigator.locks.request(`wiro-tab:${id}`, { ifAvailable: true }, lock => {
              resolve(Boolean(lock));
              if (lock) return new Promise(() => {});
            }).catch(reject);
          });
          if (acquired) {
            save();
            return id;
          }
          id = randomId();
        }
      } catch { /* BroadcastChannel also works without Web Locks. */ }
    }

    if (window.BroadcastChannel) {
      const channel = new window.BroadcastChannel('wiro-tab-identity');
      const instance = randomId();
      let probing = true;
      let collision = false;
      channel.onmessage = ({ data }) => {
        if (!data || data.tab !== id || data.instance === instance) return;
        if (data.type === 'probe' && (!probing || instance < data.instance)) {
          channel.postMessage({ type: 'occupied', tab: id, instance, target: data.instance });
        }
        if (data.type === 'occupied' && data.target === instance) collision = true;
      };
      do {
        collision = false;
        channel.postMessage({ type: 'probe', tab: id, instance });
        await new Promise(resolve => window.setTimeout(resolve, 180));
        if (collision) id = randomId();
      } while (collision);
      probing = false;
      // Keep responding for the lifetime of this document, not just at startup.
      window.addEventListener('pagehide', event => {
        if (!event.persisted) channel.close();
      });
    } else {
      throw new Error('This browser cannot safely identify duplicate tabs.');
    }
    save();
    return id;
  }

  window.WiroSession = {
    create({ baseUrl }) {
      const base = String(baseUrl).replace(/\/+$/, '');
      let token = readToken();
      let state = token ? 'idle' : 'signedout';
      let version = 0;
      let tabId = '';
      let claimPromise = null;
      let heartbeatTimer = null;
      let heartbeatPending = false;
      let renewedAt = 0;
      let overlay = null;
      const identity = identifyTab().then(id => { tabId = id; return id; }).catch(() => null);

      function clearStoredToken(expected) {
        try {
          if (expected && readToken() === expected) window.localStorage.removeItem(TOKEN_KEY);
        } catch { /* Storage may be disabled. */ }
      }

      function showMessage() {
        if (!document.body) return;
        if (!overlay) {
          overlay = document.createElement('div');
          overlay.setAttribute('role', 'dialog');
          overlay.setAttribute('aria-modal', 'true');
          overlay.setAttribute('aria-labelledby', 'wiro-session-title');
          overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(2,6,23,.95);padding:24px;color:#f8fafc;font:16px/1.5 system-ui';
          const panel = document.createElement('div');
          panel.style.cssText = 'max-width:440px;padding:32px;border:1px solid #475569;border-radius:16px;background:#0f172a';
          const title = document.createElement('h2');
          title.id = 'wiro-session-title';
          title.style.cssText = 'font-size:24px;font-weight:700;margin:0 0 12px';
          const message = document.createElement('p');
          message.style.cssText = 'margin:0 0 24px;color:#cbd5e1';
          const button = document.createElement('button');
          button.type = 'button';
          button.style.cssText = 'background:#2563eb;color:white;border:0;border-radius:8px;padding:12px 18px;cursor:pointer;font:inherit';
          panel.append(title, message, button);
          overlay.append(panel);
          document.body.append(overlay);
        }
        const [title, message, button] = overlay.firstChild.children;
        const conflict = state === 'blocked';
        const unavailable = state === 'unavailable';
        title.textContent = conflict ? 'Already open in another tab'
          : state === 'replaced' ? 'Signed in elsewhere' : unavailable ? 'Unable to connect' : 'Session expired';
        message.textContent = conflict
          ? 'This account is active in another tab. Use this tab instead to move the session here.'
          : state === 'replaced' ? 'Your session was replaced or another account signed in. This tab will not switch accounts automatically.'
          : unavailable ? 'The session could not be checked. Please retry when your connection is available.'
          : 'Your session is no longer valid. Please sign in again.';
        button.textContent = conflict ? 'Use this tab instead' : unavailable ? 'Retry'
          : state === 'replaced' ? 'Reload to continue' : 'Sign in';
        button.disabled = false;
        button.onclick = async () => {
          if (state !== 'blocked' && state !== 'unavailable') {
            window.location.href = 'index.html';
            return;
          }
          const takeover = state === 'blocked';
          button.disabled = true;
          // Only this explicit click may ever send takeover:true.
          version++;
          state = 'idle';
          claimPromise = null;
          if (await claim(takeover)) window.location.reload();
        };
        for (const child of document.body.children) {
          if (child !== overlay && child.tagName !== 'SCRIPT') child.inert = true;
        }
        button.focus();
      }

      function stop(nextState, expected = token) {
        state = nextState;
        window.clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        if (nextState === 'expired') clearStoredToken(expected);
        showMessage();
      }

      function stillCurrent(expected, revision) {
        if (token !== expected || revision !== version) return false;
        if (state === 'expired' || state === 'replaced' || state === 'signedout') return false;
        if (readToken() !== token) {
          version++;
          stop('replaced');
          return false;
        }
        return true;
      }

      function headersFor(expected, init = {}) {
        const headers = new Headers(init.headers || {});
        headers.set('Authorization', 'Bearer ' + expected);
        headers.set('X-Tab-Id', tabId);
        return headers;
      }

      async function handleResponse(response, expected, revision) {
        if (!stillCurrent(expected, revision)) return false;
        if (response.status !== 401 && response.status !== 409) return true;
        const data = await response.clone().json().catch(() => ({}));
        if (!stillCurrent(expected, revision)) return false;
        if (response.status === 409 && data.code === 'TAB_CONFLICT') stop('blocked');
        if (response.status === 401) {
          if (data.code === 'SESSION_REPLACED') {
            clearStoredToken(expected);
            stop('replaced');
          } else stop('expired', expected);
        }
        return true;
      }

      async function heartbeat() {
        if (state !== 'active' || heartbeatPending) return;
        const expected = token;
        const revision = version;
        if (!stillCurrent(expected, revision)) return;
        heartbeatPending = true;
        try {
          const response = await window.fetch(`${base}/auth/session/heartbeat`, {
            method: 'POST', headers: headersFor(expected)
          });
          if (await handleResponse(response, expected, revision) && response.ok && state === 'active') {
            renewedAt = Date.now();
          }
        } catch { /* Retry at the next heartbeat; the server still enforces lease expiry. */ }
        finally { heartbeatPending = false; }
      }

      function claim(takeover = false) {
        if (claimPromise) return claimPromise;
        const expected = token;
        const revision = version;
        const pending = (async () => {
          try {
            await identity;
            if (!stillCurrent(expected, revision) || !expected) return false;
            if (!tabId) {
              stop('unavailable');
              return false;
            }
            const response = await window.fetch(`${base}/auth/session/claim`, {
              method: 'POST',
              headers: headersFor(expected, { headers: { 'Content-Type': 'application/json' } }),
              body: JSON.stringify({ takeover })
            });
            if (!await handleResponse(response, expected, revision)) return false;
            if (!response.ok) {
              if (state === 'idle' || state === 'active') stop('unavailable');
              return false;
            }
            if (state !== 'idle' && state !== 'active') return false;
            state = 'active';
            renewedAt = Date.now();
            if (!heartbeatTimer) heartbeatTimer = window.setInterval(heartbeat, 25000);
            return true;
          } catch {
            if (stillCurrent(expected, revision)) stop('unavailable');
            return false;
          }
        })();
        claimPromise = pending;
        pending.then(() => { if (claimPromise === pending) claimPromise = null; });
        return pending;
      }

      function failure() {
        const conflict = state === 'blocked';
        return new Response(JSON.stringify({
          success: false,
          code: conflict ? 'TAB_CONFLICT' : state === 'replaced' ? 'SESSION_REPLACED' : 'SESSION_UNAVAILABLE',
          error: conflict ? 'Already open in another tab.' : 'Session unavailable. Please check the session message.'
        }), { status: conflict ? 409 : state === 'unavailable' ? 503 : 401,
          headers: { 'Content-Type': 'application/json' } });
      }

      window.addEventListener('storage', event => {
        if ((event.key === TOKEN_KEY || event.key === null) && readToken() !== token) {
          version++;
          stop('replaced');
        }
      });

      return {
        getToken: () => ['idle', 'active', 'blocked', 'unavailable'].includes(state) ? token : '',
        setToken(nextToken) {
          version++;
          window.clearInterval(heartbeatTimer);
          heartbeatTimer = null;
          claimPromise = null;
          token = String(nextToken || '');
          state = token ? 'idle' : 'signedout';
          try {
            if (token) window.localStorage.setItem(TOKEN_KEY, token);
            else window.localStorage.removeItem(TOKEN_KEY);
          } catch { /* Auth requests will fail closed if storage is unavailable. */ }
        },
        async fetch(url, init = {}) {
          const expected = token;
          const revision = version;
          if (!expected || !stillCurrent(expected, revision)) return failure();
          if (state === 'idle' || (state === 'active' && Date.now() - renewedAt > 50000)) {
            if (!await claim()) return failure();
          }
          if (state !== 'active' || !stillCurrent(expected, revision)) return failure();
          const response = await window.fetch(url, { ...init, headers: headersFor(expected, init) });
          if (!await handleResponse(response, expected, revision)) return failure();
          return response;
        },
        async logout() {
          const expected = token;
          version++;
          state = 'signedout';
          window.clearInterval(heartbeatTimer);
          heartbeatTimer = null;
          clearStoredToken(expected);
          token = '';
          try {
            await identity;
            if (expected && tabId) await window.fetch(`${base}/auth/logout`, {
              method: 'POST', headers: headersFor(expected)
            });
          } catch { /* Local sign-out still succeeds when offline. */ }
        }
      };
    }
  };
})();
