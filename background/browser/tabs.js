(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.CrawlerBrowserTabs = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function registerTabHandlers(handlers, chromeApi, cdpManager, utils) {
    if (!chromeApi || !chromeApi.tabs) throw new Error('chromeApi with tabs is required');
    utils = utils || (typeof globalThis !== 'undefined' && globalThis.CrawlerBrowserUtils) || (typeof require === 'function' && require('./utils.js'));
    const callChrome = utils.callChrome;
    const paramsObject = utils.paramsObject;
    const positiveTabId = utils.positiveTabId;
    const httpUrl = utils.httpUrl;
    const pick = utils.pick;
    const isPlainObject = utils.isPlainObject;
    const CREATE_FIELDS = utils.CREATE_FIELDS;
    const UPDATE_FIELDS = utils.UPDATE_FIELDS;

    const tabs = chromeApi.tabs;
    const tabLeases = cdpManager ? cdpManager.tabLeases : null;
    const ensureWorkerTabGroup = cdpManager ? cdpManager.ensureWorkerTabGroup : function () { return Promise.resolve(null); };

    handlers.set('getTabs', function (params) {
      params = paramsObject(params);
      if (params.query !== undefined && !isPlainObject(params.query)) throw new Error('query must be a plain object');
      return callChrome(chromeApi, tabs.query, [params.query || {}], 'Browser tabs.query failed');
    });

    handlers.set('getCurrentTab', function () {
      return callChrome(chromeApi, tabs.query, [{ active: true, currentWindow: true }], 'Browser tabs.query failed').then(function (result) {
        return (result && result[0]) || null;
      });
    });

    handlers.set('createTab', function (params) {
      params = paramsObject(params);
      const properties = pick(params, CREATE_FIELDS);
      if (properties.url !== undefined) httpUrl(properties.url);
      return callChrome(chromeApi, tabs.create, [properties], 'Browser tabs.create failed').then(function (tab) {
        const tabId = tab && tab.id;
        if (tabId && params.sessionId && typeof params.sessionId === 'string' && tabLeases) {
          tabLeases.set(tabId, {
            sessionId: params.sessionId,
            turnId: typeof params.turnId === 'string' ? params.turnId : '',
            source: 'created',
            createdAt: Date.now()
          });
          ensureWorkerTabGroup(tabId);
        }
        return { tabId: tabId, tab: tab };
      });
    });

    handlers.set('updateTab', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined || params.tabId === 0) throw new Error('tabId is required');
      positiveTabId(params.tabId);
      const updateProps = params.updateProps === undefined ? {} : params.updateProps;
      if (!isPlainObject(updateProps)) throw new Error('updateProps must be a plain object');
      const properties = pick(updateProps, UPDATE_FIELDS);
      if (properties.url !== undefined) httpUrl(properties.url);
      return callChrome(chromeApi, tabs.update, [params.tabId, properties], 'Browser tabs.update failed');
    });

    handlers.set('closeTab', function (params) {
      params = paramsObject(params);
      if (params.tabIds === undefined || (Array.isArray(params.tabIds) && params.tabIds.length === 0)) throw new Error('tabIds is required');
      const ids = Array.isArray(params.tabIds) ? params.tabIds : [params.tabIds];
      ids.forEach(function (id) { positiveTabId(id, 'tabIds'); });
      return callChrome(chromeApi, tabs.remove, [params.tabIds], 'Browser tabs.remove failed').then(function () {
        return { success: true };
      });
    });

    handlers.set('navigate', function (params) {
      params = paramsObject(params);
      if (!params.url) throw new Error('url is required');
      httpUrl(params.url);
      if (params.tabId !== undefined) positiveTabId(params.tabId);
      if (params.newTab) {
        return callChrome(chromeApi, tabs.create, [{ url: params.url }], 'Browser tabs.create failed').then(function (tab) {
          return { tabId: tab.id, title: tab.title || '', url: tab.url || params.url };
        });
      }
      const update = function (tabId) {
        return callChrome(chromeApi, tabs.update, [tabId, { url: params.url }], 'Browser tabs.update failed').then(function (tab) {
          return { tabId: tab.id, title: tab.title || '', url: tab.url || params.url };
        });
      };
      if (params.tabId !== undefined) return update(params.tabId);
      return callChrome(chromeApi, tabs.query, [{ active: true, currentWindow: true }], 'Browser tabs.query failed').then(function (result) {
        if (!result || !result[0]) throw new Error('No active tab found');
        return update(result[0].id);
      });
    });

    handlers.set('screenshot', function (params) {
      params = paramsObject(params);
      const captureVisible = function (windowId) {
        return callChrome(chromeApi, tabs.captureVisibleTab, [windowId, {}], 'Browser tabs.captureVisibleTab failed');
      };

      const captureCdp = function (targetId) {
        if (!cdpManager || typeof cdpManager.callDebuggerCommand !== 'function') {
          return Promise.reject(new Error('cdpManager not available'));
        }
        return cdpManager.ensureDebuggerAttached(targetId).then(function () {
          return cdpManager.callDebuggerCommand(targetId, 'Page.captureScreenshot', {
            format: 'png',
            fromSurface: true,
            captureBeyondViewport: false
          });
        }).then(function (res) {
          if (!res || !res.data) throw new Error('Empty screenshot data from CDP');
          return 'data:image/png;base64,' + res.data;
        });
      };

      const resolveAndCapture = function (tab) {
        // 若目标 Tab 在后台或非活动，优先使用 CDP Page.captureScreenshot 截图
        if (tab && !tab.active && cdpManager && typeof cdpManager.callDebuggerCommand === 'function') {
          return captureCdp(tab.id).catch(function () {
            return captureVisible(tab.windowId);
          });
        }
        // 前台活动 Tab 先尝试 captureVisibleTab，失败时回退到 CDP 截图
        return captureVisible(tab ? tab.windowId : null).catch(function (err) {
          if (tab && tab.id && cdpManager && typeof cdpManager.callDebuggerCommand === 'function') {
            return captureCdp(tab.id);
          }
          throw err;
        });
      };

      if (params.tabId === undefined) {
        return callChrome(chromeApi, tabs.query, [{ active: true, currentWindow: true }], 'Browser tabs.query failed')
          .then(function (result) {
            const activeTab = result && result[0];
            return resolveAndCapture(activeTab || null);
          }).catch(function () {
            return captureVisible(null);
          });
      }

      positiveTabId(params.tabId);
      return callChrome(chromeApi, tabs.get, [params.tabId], 'Browser tabs.get failed').then(function (tab) {
        return resolveAndCapture(tab);
      });
    });

    handlers.set('activateTab', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined || params.tabId === 0) throw new Error('tabId is required');
      positiveTabId(params.tabId);
      return callChrome(chromeApi, tabs.update, [params.tabId, { active: true }], 'Browser tabs.update failed').then(function (tab) {
        return { tabId: tab.id, active: tab.active, title: tab.title || '', url: tab.url || '' };
      });
    });

    handlers.set('reloadTab', function (params) {
      params = paramsObject(params);
      if (params.tabId !== undefined) positiveTabId(params.tabId);
      const reloadOptions = params.bypassCache ? { bypassCache: true } : {};
      const doReload = function (targetId) {
        return callChrome(chromeApi, tabs.reload, [targetId, reloadOptions], 'Browser tabs.reload failed').then(function () {
          return { success: true, tabId: targetId };
        });
      };
      if (params.tabId !== undefined) return doReload(params.tabId);
      return callChrome(chromeApi, tabs.query, [{ active: true, currentWindow: true }], 'Browser tabs.query failed').then(function (result) {
        if (!result || !result[0]) throw new Error('No active tab found');
        return doReload(result[0].id);
      });
    });

    handlers.set('getContent', function (params) {
      params = paramsObject(params);
      if (params.tabId !== undefined) positiveTabId(params.tabId);
      const format = params.format === 'html' ? 'html' : 'text';
      if (!chromeApi.scripting || typeof chromeApi.scripting.executeScript !== 'function') {
        throw new Error('chrome.scripting API is not available');
      }
      const extractContent = function (targetId) {
        return callChrome(
          chromeApi,
          chromeApi.scripting.executeScript,
          [{
            target: { tabId: targetId },
            func: function (fmt) {
              var doc = typeof document !== 'undefined' ? document : null;
              var loc = typeof location !== 'undefined' ? location : null;
              return {
                title: (doc && doc.title) || '',
                url: (loc && loc.href) || '',
                content: fmt === 'html'
                  ? (doc && doc.documentElement ? doc.documentElement.outerHTML : '')
                  : (doc && doc.body ? doc.body.innerText : '')
              };
            },
            args: [format]
          }],
          'Browser scripting.executeScript failed'
        ).then(function (injectionResults) {
          if (!injectionResults || !injectionResults[0] || !injectionResults[0].result) {
            return { tabId: targetId, format: format, content: '', title: '', url: '' };
          }
          const data = injectionResults[0].result;
          return {
            tabId: targetId,
            format: format,
            content: data.content || '',
            title: data.title || '',
            url: data.url || ''
          };
        });
      };
      if (params.tabId !== undefined) return extractContent(params.tabId);
      return callChrome(chromeApi, tabs.query, [{ active: true, currentWindow: true }], 'Browser tabs.query failed').then(function (result) {
        if (!result || !result[0]) throw new Error('No active tab found');
        return extractContent(result[0].id);
      });
    });
  }

  return {
    registerTabHandlers: registerTabHandlers
  };
});
