(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.CrawlerBrowserNetwork = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function registerNetworkHandlers(handlers, cdpManager, networkManager, utils) {
    utils = utils || (typeof globalThis !== 'undefined' && globalThis.CrawlerBrowserUtils) || (typeof require === 'function' && require('./utils.js'));
    const paramsObject = utils ? utils.paramsObject : function (p) { return p || {}; };
    const positiveTabId = utils ? utils.positiveTabId : function (id) {
      if (!Number.isInteger(id) || id <= 0) throw new Error('tabId must be a positive integer');
    };

    const ensureDebuggerAttached = cdpManager
      ? cdpManager.ensureDebuggerAttached.bind(cdpManager)
      : function () { return Promise.reject(new Error('cdpManager not available')); };

    function ensureReady(tabId) {
      if (!networkManager) return Promise.reject(new Error('NetworkManager is not available'));
      return ensureDebuggerAttached(tabId).then(function () {
        return networkManager.enableForTab(tabId);
      });
    }

    // ─── 1. listNetworkRequests ─────────────────────────────
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
      return ensureReady(params.tabId).then(function () {
        return networkManager.listNetworkRequests(params.tabId, params);
      });
    });
    handlers.set('list_network_requests', handlers.get('listNetworkRequests'));

    // ─── 2. getNetworkRequest ───────────────────────────────
    handlers.set('getNetworkRequest', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined || params.tabId === 0) throw new Error('tabId is required');
      positiveTabId(params.tabId);
      const reqid = params.reqid !== undefined ? params.reqid : params.requestId;
      if (reqid === undefined || reqid === null || reqid === '') {
        throw new Error('reqid is required');
      }
      return ensureReady(params.tabId).then(function () {
        return networkManager.getNetworkRequest(params.tabId, reqid, params);
      });
    });
    handlers.set('get_network_request', handlers.get('getNetworkRequest'));

    // ─── 3. clearNetworkRequests ────────────────────────────
    handlers.set('clearNetworkRequests', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined || params.tabId === 0) throw new Error('tabId is required');
      positiveTabId(params.tabId);
      return ensureReady(params.tabId).then(function () {
        return networkManager.clearNetworkRequests(params.tabId);
      });
    });
    handlers.set('clear_network_requests', handlers.get('clearNetworkRequests'));

    // ─── 4. listWebSocketConnections ────────────────────────
    handlers.set('listWebSocketConnections', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined || params.tabId === 0) throw new Error('tabId is required');
      positiveTabId(params.tabId);
      if (params.pageSize !== undefined && (!Number.isInteger(params.pageSize) || params.pageSize <= 0)) {
        throw new Error('pageSize must be a positive integer');
      }
      if (params.pageIdx !== undefined && (!Number.isInteger(params.pageIdx) || params.pageIdx < 0)) {
        throw new Error('pageIdx must be a non-negative integer');
      }
      return ensureReady(params.tabId).then(function () {
        return networkManager.listWebSocketConnections(params.tabId, params);
      });
    });
    handlers.set('list_websocket_connections', handlers.get('listWebSocketConnections'));

    // ─── 5. getWebSocketMessages ────────────────────────────
    handlers.set('getWebSocketMessages', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined || params.tabId === 0) throw new Error('tabId is required');
      positiveTabId(params.tabId);
      const wsid = params.wsid;
      if (wsid === undefined) {
        throw new Error('wsid is required');
      }
      return ensureReady(params.tabId).then(function () {
        return networkManager.getWebSocketMessages(params.tabId, params);
      });
    });
    handlers.set('get_websocket_messages', handlers.get('getWebSocketMessages'));

    // ─── 6. getWebSocketMessage ─────────────────────────────
    handlers.set('getWebSocketMessage', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined || params.tabId === 0) throw new Error('tabId is required');
      positiveTabId(params.tabId);
      const wsid = params.wsid;
      if (wsid === undefined) throw new Error('wsid is required');
      if (typeof params.frameIndex !== 'number' || params.frameIndex < 0) {
        throw new Error('frameIndex must be a non-negative integer');
      }
      return ensureReady(params.tabId).then(function () {
        return networkManager.getWebSocketMessage(params.tabId, params);
      });
    });
    handlers.set('get_websocket_message', handlers.get('getWebSocketMessage'));

    // ─── 7. analyzeWebSocketMessages ────────────────────────
    handlers.set('analyzeWebSocketMessages', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined || params.tabId === 0) throw new Error('tabId is required');
      positiveTabId(params.tabId);
      const wsid = params.wsid;
      if (wsid === undefined) throw new Error('wsid is required');
      return ensureReady(params.tabId).then(function () {
        return networkManager.analyzeWebSocketMessages(params.tabId, params);
      });
    });
    handlers.set('analyze_websocket_messages', handlers.get('analyzeWebSocketMessages'));

    // ─── 8. replayNetworkRequest ────────────────────────────
    handlers.set('replayNetworkRequest', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined || params.tabId === 0) throw new Error('tabId is required');
      positiveTabId(params.tabId);
      const reqid = params.reqid !== undefined ? params.reqid : params.requestId;
      if (reqid === undefined && !params.url) {
        throw new Error('Either reqid or url is required for replayNetworkRequest');
      }
      return ensureReady(params.tabId).then(function () {
        return networkManager.replayNetworkRequest(params.tabId, params);
      });
    });
    handlers.set('replay_network_request', handlers.get('replayNetworkRequest'));

    // ─── 9. exportRequestAsCurl ─────────────────────────────
    handlers.set('exportRequestAsCurl', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined || params.tabId === 0) throw new Error('tabId is required');
      positiveTabId(params.tabId);
      const reqid = params.reqid !== undefined ? params.reqid : params.requestId;
      if (reqid === undefined && !params.url) {
        throw new Error('Either reqid or url is required for exportRequestAsCurl');
      }
      return ensureReady(params.tabId).then(function () {
        return networkManager.exportRequestAsCurl(params.tabId, params);
      });
    });
    handlers.set('export_request_as_curl', handlers.get('exportRequestAsCurl'));

    // ─── 10. replayNetworkRequestBatch ──────────────────────
    handlers.set('replayNetworkRequestBatch', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined || params.tabId === 0) throw new Error('tabId is required');
      positiveTabId(params.tabId);
      if (!Array.isArray(params.variants) || params.variants.length === 0) {
        throw new Error('variants must be a non-empty array of ReplayOverride objects');
      }
      return ensureReady(params.tabId).then(function () {
        return networkManager.replayNetworkRequestBatch(params.tabId, params);
      });
    });
    handlers.set('replay_network_request_batch', handlers.get('replayNetworkRequestBatch'));
  }

  return {
    registerNetworkHandlers: registerNetworkHandlers
  };
});
