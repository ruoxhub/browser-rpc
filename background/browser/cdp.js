(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.CrawlerBrowserCdp = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createCdpManager(chromeApi, utils) {
    if (!chromeApi) throw new Error('chromeApi is required');
    utils = utils || (typeof globalThis !== 'undefined' && globalThis.CrawlerBrowserUtils) || (typeof require === 'function' && require('./utils.js'));
    const callChrome = utils.callChrome;
    const paramsObject = utils.paramsObject;
    const positiveTabId = utils.positiveTabId;
    const isPlainObject = utils.isPlainObject;

    const tabs = chromeApi.tabs;
    const tabGroups = chromeApi.tabGroups;
    const attachedDebuggers = new Set();
    const pendingAttaches = new Map();
    const tabLeases = new Map();

    if (chromeApi.debugger && chromeApi.debugger.onDetach && typeof chromeApi.debugger.onDetach.addListener === 'function') {
      try {
        chromeApi.debugger.onDetach.addListener(function (source) {
          if (source && typeof source.tabId === 'number') {
            attachedDebuggers.delete(source.tabId);
            pendingAttaches.delete(source.tabId);
          }
        });
      } catch (_) {}
    }

    function ensureDebuggerAttached(tabId) {
      if (attachedDebuggers.has(tabId)) {
        return Promise.resolve();
      }
      if (pendingAttaches.has(tabId)) {
        return pendingAttaches.get(tabId);
      }
      const attachPromise = new Promise(function (resolve, reject) {
        try {
          chromeApi.debugger.attach({ tabId: tabId }, '1.3', function () {
            const lastError = chromeApi.runtime && chromeApi.runtime.lastError;
            if (lastError && !String(lastError.message).includes('already attached')) {
              reject(new Error('Browser debugger.attach failed'));
            } else {
              attachedDebuggers.add(tabId);
              resolve();
            }
          });
        } catch (err) {
          reject(err);
        }
      }).then(function () {
        // 仅开启 Page 域。不带它时 Chrome 会在调试器已附着的情况下直接自动关闭
        // alert/confirm/prompt，且不发 Page.javascriptDialogOpening，
        // 于是 dialog 动作永远拿不到 currentDialog、也无法响应弹窗。
        // 这里只开 Page（不开 Log/Runtime/Network，避免无谓缓存）。
        return callDebuggerCommand(tabId, 'Page.enable').catch(function () {});
      }).finally(function () {
        pendingAttaches.delete(tabId);
      });
      pendingAttaches.set(tabId, attachPromise);
      return attachPromise;
    }

    function callDebuggerCommand(tabId, method, commandParams, timeoutMs) {
      timeoutMs = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : 30000;
      const ensureAttached = ensureDebuggerAttached(tabId);

      return ensureAttached.then(function () {
        let timerId;
        const timeoutPromise = new Promise(function (_, reject) {
          timerId = setTimeout(function () {
            reject(new Error('CDP command ' + method + ' timed out after ' + timeoutMs + 'ms'));
          }, timeoutMs);
        });
        const commandPromise = callChrome(
          chromeApi,
          chromeApi.debugger.sendCommand,
          [{ tabId: tabId }, method, commandParams || {}],
          'Browser debugger.sendCommand failed'
        );
        return Promise.race([commandPromise, timeoutPromise]).finally(function () {
          if (timerId) clearTimeout(timerId);
        });
      });
    }

    const cdpClient = {
      sendCommand: function (target, method, params, timeoutMs) {
        const tabId = (target && target.tabId) || target;
        return callDebuggerCommand(tabId, method, params, timeoutMs);
      }
    };

    function ensureWorkerTabGroup(tabId) {
      if (!tabGroups || typeof tabs.group !== 'function') return Promise.resolve(null);
      const WORKER_GROUP_TITLE = '[Browser-RPC Worker]';
      const queryGroups = typeof tabGroups.query === 'function'
        ? callChrome(chromeApi, tabGroups.query, [{ title: WORKER_GROUP_TITLE }], 'Browser tabGroups.query failed').catch(function () { return []; })
        : Promise.resolve([]);

      return queryGroups.then(function (groups) {
        const existing = groups && groups[0];
        if (existing && existing.id !== undefined) {
          return callChrome(chromeApi, tabs.group, [{ tabIds: tabId, groupId: existing.id }], 'Browser tabs.group failed')
            .catch(function () { return existing.id; });
        }
        return callChrome(chromeApi, tabs.group, [{ tabIds: tabId }], 'Browser tabs.group failed').then(function (newGroupId) {
          if (typeof tabGroups.update === 'function' && newGroupId !== undefined) {
            return callChrome(chromeApi, tabGroups.update, [newGroupId, { title: WORKER_GROUP_TITLE, color: 'purple' }], 'Browser tabGroups.update failed')
              .then(function () { return newGroupId; })
              .catch(function () { return newGroupId; });
          }
          return newGroupId;
        }).catch(function () { return null; });
      });
    }

    function registerHandlers(handlers) {
      handlers.set('executeCdp', function (params) {
        params = paramsObject(params);
        if (params.tabId === undefined || params.tabId === 0) throw new Error('tabId is required');
        positiveTabId(params.tabId);
        if (typeof params.method !== 'string' || !params.method.trim()) throw new Error('method is required');
        if (params.params !== undefined && !isPlainObject(params.params)) throw new Error('params must be a plain object');
        if (!chromeApi.debugger || typeof chromeApi.debugger.sendCommand !== 'function') {
          throw new Error('chrome.debugger API is not available');
        }
        const tabId = params.tabId;
        const method = params.method.trim();
        const commandParams = params.params || {};
        const timeoutMs = (typeof params.timeoutMs === 'number' && params.timeoutMs > 0) ? params.timeoutMs : 30000;

        return callDebuggerCommand(tabId, method, commandParams, timeoutMs);
      });

      handlers.set('claimTab', function (params) {
        params = paramsObject(params);
        if (!params.sessionId || typeof params.sessionId !== 'string' || !params.sessionId.trim()) {
          throw new Error('sessionId is required');
        }
        if (params.tabId === undefined || params.tabId === 0) throw new Error('tabId is required');
        positiveTabId(params.tabId);
        const tabId = params.tabId;
        const sessionId = params.sessionId.trim();
        const turnId = typeof params.turnId === 'string' ? params.turnId.trim() : '';

        tabLeases.set(tabId, {
          sessionId: sessionId,
          turnId: turnId,
          source: 'claimed',
          createdAt: Date.now()
        });

        return ensureWorkerTabGroup(tabId).then(function (groupId) {
          return {
            success: true,
            tabId: tabId,
            sessionId: sessionId,
            turnId: turnId,
            groupId: groupId
          };
        });
      });

      handlers.set('releaseTabs', function (params) {
        params = paramsObject(params);
        if (!params.sessionId || typeof params.sessionId !== 'string' || !params.sessionId.trim()) {
          throw new Error('sessionId is required');
        }
        const sessionId = params.sessionId.trim();
        const turnId = typeof params.turnId === 'string' ? params.turnId.trim() : null;
        const keepTabIds = Array.isArray(params.keepTabIds) ? params.keepTabIds : [];

        const toClose = [];
        const released = [];

        tabLeases.forEach(function (lease, tabId) {
          if (lease.sessionId !== sessionId) return;
          if (turnId && lease.turnId !== turnId) return;

          released.push(tabId);
          if (lease.source === 'created' && !keepTabIds.includes(tabId)) {
            toClose.push(tabId);
          }
        });

        released.forEach(function (tabId) {
          tabLeases.delete(tabId);
        });

        const closePromise = toClose.length > 0
          ? callChrome(chromeApi, tabs.remove, [toClose], 'Browser tabs.remove failed').catch(function () {})
          : Promise.resolve();

        return closePromise.then(function () {
          return {
            success: true,
            closedCount: toClose.length,
            releasedCount: released.length
          };
        });
      });
    }

    return {
      attachedDebuggers: attachedDebuggers,
      pendingAttaches: pendingAttaches,
      tabLeases: tabLeases,
      ensureDebuggerAttached: ensureDebuggerAttached,
      callDebuggerCommand: callDebuggerCommand,
      cdpClient: cdpClient,
      ensureWorkerTabGroup: ensureWorkerTabGroup,
      registerHandlers: registerHandlers
    };
  }

  return {
    createCdpManager: createCdpManager
  };
});
