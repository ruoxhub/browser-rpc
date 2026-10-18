(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.CrawlerBrowserDevTools = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function registerDevToolsHandlers(handlers, cdpManager, devToolsCollector, utils) {
    utils = utils || (typeof globalThis !== 'undefined' && globalThis.CrawlerBrowserUtils) || (typeof require === 'function' && require('./utils.js'));
    const paramsObject = utils.paramsObject;
    const positiveTabId = utils.positiveTabId;
    const isPlainObject = utils.isPlainObject;

    const ensureDebuggerAttached = cdpManager ? cdpManager.ensureDebuggerAttached : function () { return Promise.reject(new Error('cdpManager not available')); };

    handlers.set('listConsoleMessages', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined || params.tabId === 0) throw new Error('tabId is required');
      positiveTabId(params.tabId);
      if (params.pageSize !== undefined && (!Number.isInteger(params.pageSize) || params.pageSize <= 0)) {
        throw new Error('pageSize must be a positive integer');
      }
      if (params.pageIdx !== undefined && (!Number.isInteger(params.pageIdx) || params.pageIdx < 0)) {
        throw new Error('pageIdx must be a non-negative integer');
      }
      if (params.types !== undefined && !Array.isArray(params.types)) {
        throw new Error('types must be an array of strings');
      }
      if (!devToolsCollector) throw new Error('DevToolsCollector is not available');
      return ensureDebuggerAttached(params.tabId).then(function () {
        return devToolsCollector.enableForTab(params.tabId);
      }).then(function () {
        return devToolsCollector.listConsoleMessages(params.tabId, params);
      });
    });
    handlers.set('list_console_messages', handlers.get('listConsoleMessages'));

    handlers.set('getConsoleMessage', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined || params.tabId === 0) throw new Error('tabId is required');
      positiveTabId(params.tabId);
      const msgid = params.msgid !== undefined ? params.msgid : params.messageId;
      if (msgid === undefined || typeof msgid !== 'number') {
        throw new Error('msgid is required');
      }
      if (!devToolsCollector) throw new Error('DevToolsCollector is not available');
      return ensureDebuggerAttached(params.tabId).then(function () {
        return devToolsCollector.getConsoleMessage(params.tabId, msgid);
      });
    });
    handlers.set('get_console_message', handlers.get('getConsoleMessage'));

    handlers.set('listNetworkRequests', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined || params.tabId === 0) throw new Error('tabId is required');
      positiveTabId(params.tabId);
      if (params.pageSize !== undefined && (!Number.isInteger(params.pageSize) || params.pageSize <= 0)) {
        throw new Error('pageSize must be a positive integer');
      }
      if (params.pageIdx !== undefined && (!Number.isInteger(params.pageIdx) || params.pageIdx < 0)) {
        throw new Error('pageIdx must be a non-negative integer');
      }
      if (params.resourceTypes !== undefined && !Array.isArray(params.resourceTypes)) {
        throw new Error('resourceTypes must be an array of strings');
      }
      if (!devToolsCollector) throw new Error('DevToolsCollector is not available');
      return ensureDebuggerAttached(params.tabId).then(function () {
        return devToolsCollector.enableForTab(params.tabId);
      }).then(function () {
        return devToolsCollector.listNetworkRequests(params.tabId, params);
      });
    });
    handlers.set('list_network_requests', handlers.get('listNetworkRequests'));

    handlers.set('getNetworkRequest', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined || params.tabId === 0) throw new Error('tabId is required');
      positiveTabId(params.tabId);
      const reqid = params.reqid !== undefined ? params.reqid : params.requestId;
      if (reqid === undefined || reqid === null || reqid === '') {
        throw new Error('reqid is required');
      }
      if (!devToolsCollector) throw new Error('DevToolsCollector is not available');
      return ensureDebuggerAttached(params.tabId).then(function () {
        return devToolsCollector.getNetworkRequest(params.tabId, reqid);
      });
    });
    handlers.set('get_network_request', handlers.get('getNetworkRequest'));

    handlers.set('listScripts', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined || params.tabId === 0) throw new Error('tabId is required');
      positiveTabId(params.tabId);
      if (params.pageSize !== undefined && (!Number.isInteger(params.pageSize) || params.pageSize <= 0)) {
        throw new Error('pageSize must be a positive integer');
      }
      if (params.pageIdx !== undefined && (!Number.isInteger(params.pageIdx) || params.pageIdx < 0)) {
        throw new Error('pageIdx must be a non-negative integer');
      }
      if (!devToolsCollector) throw new Error('DevToolsCollector is not available');
      return ensureDebuggerAttached(params.tabId).then(function () {
        return devToolsCollector.enableForTab(params.tabId);
      }).then(function () {
        return devToolsCollector.listScripts(params.tabId, params);
      });
    });
    handlers.set('list_scripts', handlers.get('listScripts'));

    handlers.set('getScriptSource', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined || params.tabId === 0) throw new Error('tabId is required');
      positiveTabId(params.tabId);
      const scriptId = params.scriptId !== undefined ? params.scriptId : params.script_id;
      if (scriptId === undefined || scriptId === null || scriptId === '') {
        throw new Error('scriptId is required');
      }
      if (!devToolsCollector) throw new Error('DevToolsCollector is not available');
      return ensureDebuggerAttached(params.tabId).then(function () {
        return devToolsCollector.enableForTab(params.tabId);
      }).then(function () {
        return devToolsCollector.getScriptSource(params.tabId, scriptId);
      });
    });
    handlers.set('get_script_source', handlers.get('getScriptSource'));

    handlers.set('emulate', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined || params.tabId === 0) throw new Error('tabId is required');
      positiveTabId(params.tabId);
      if (params.viewport !== undefined && !isPlainObject(params.viewport)) {
        throw new Error('viewport must be a plain object');
      }
      if (params.geolocation !== undefined && params.geolocation !== null && !isPlainObject(params.geolocation)) {
        throw new Error('geolocation must be a plain object or null');
      }
      if (params.extraHttpHeaders !== undefined && !isPlainObject(params.extraHttpHeaders)) {
        throw new Error('extraHttpHeaders must be a plain object');
      }
      if (!devToolsCollector) throw new Error('DevToolsCollector is not available');
      return ensureDebuggerAttached(params.tabId).then(function () {
        return devToolsCollector.emulate(params.tabId, params);
      });
    });

    handlers.set('resizePage', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined || params.tabId === 0) throw new Error('tabId is required');
      positiveTabId(params.tabId);
      if (typeof params.width !== 'number' || params.width <= 0) {
        throw new Error('width must be a positive number');
      }
      if (typeof params.height !== 'number' || params.height <= 0) {
        throw new Error('height must be a positive number');
      }
      if (!devToolsCollector) throw new Error('DevToolsCollector is not available');
      return ensureDebuggerAttached(params.tabId).then(function () {
        return devToolsCollector.resizePage(params.tabId, params);
      });
    });
    handlers.set('resize_page', handlers.get('resizePage'));

    handlers.set('handleDialog', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined || params.tabId === 0) throw new Error('tabId is required');
      positiveTabId(params.tabId);
      if (params.action !== 'accept' && params.action !== 'dismiss') {
        throw new Error('action must be either "accept" or "dismiss"');
      }
      if (!devToolsCollector) throw new Error('DevToolsCollector is not available');
      // enableForTab 会开启 Page 域并创建该 tab 的采集状态。
      // 没有 Page 域时 Page.javascriptDialogOpening 不会下发，
      // currentDialog 永远是空的，于是本动作永远报 "No open dialog found"。
      return ensureDebuggerAttached(params.tabId)
        .then(function () { return devToolsCollector.enableForTab(params.tabId); })
        .then(function () { return devToolsCollector.handleDialog(params.tabId, params); })
        .catch(function (err) {
          const message = err && err.message ? err.message : String(err);
          if (/No open dialog found/i.test(message)) {
            const hint = new Error(
              message +
              '。常见原因：① 弹窗已被自动关闭（窗口不可见/最小化，或存在外部 CDP 自动化客户端持有该页面）；' +
              '② 弹窗在 Page 域开启之前就已打开。请先触发弹窗再立刻调用本动作。'
            );
            hint.originalMessage = message;
            throw hint;
          }
          throw err;
        });
    });
    handlers.set('handle_dialog', handlers.get('handleDialog'));
  }

  return {
    registerDevToolsHandlers: registerDevToolsHandlers
  };
});
