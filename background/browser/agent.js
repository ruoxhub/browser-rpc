(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.CrawlerBrowserAgent = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function registerAgentHandlers(handlers, cdpManager, engines, utils) {
    utils = utils || (typeof globalThis !== 'undefined' && globalThis.CrawlerBrowserUtils) || (typeof require === 'function' && require('./utils.js'));
    const paramsObject = utils.paramsObject;
    const positiveTabId = utils.positiveTabId;

    const callDebuggerCommand = cdpManager ? cdpManager.callDebuggerCommand : function () { return Promise.reject(new Error('cdpManager not available')); };
    const sessionManager = engines.sessionManager;
    const vomEngine = engines.vomEngine;
    const longScreenshotEngine = engines.longScreenshotEngine;
    const humanLoopManager = engines.humanLoopManager;
    const fileInputTransfer = engines.fileInputTransfer;
    const dropFileTransfer = engines.dropFileTransfer;

    handlers.set('sessionStart', function (params) {
      params = paramsObject(params);
      if (!sessionManager) throw new Error('AgentSessionManager is not available');
      return sessionManager.sessionStart(params);
    });

    handlers.set('sessionStop', function (params) {
      params = paramsObject(params);
      if (!params.sessionId || typeof params.sessionId !== 'string') {
        throw new Error('sessionId is required');
      }
      if (!sessionManager) throw new Error('AgentSessionManager is not available');
      return sessionManager.sessionStop(params.sessionId);
    });

    handlers.set('borrowTab', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined || params.tabId === 0) throw new Error('tabId is required');
      positiveTabId(params.tabId);
      if (!sessionManager) throw new Error('AgentSessionManager is not available');
      return sessionManager.borrowTab(params.tabId, params.sessionId);
    });

    handlers.set('returnTab', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined || params.tabId === 0) throw new Error('tabId is required');
      positiveTabId(params.tabId);
      if (!sessionManager) throw new Error('AgentSessionManager is not available');
      return sessionManager.returnTab(params.tabId);
    });

    handlers.set('observe', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined || params.tabId === 0) throw new Error('tabId is required');
      positiveTabId(params.tabId);
      if (!vomEngine) throw new Error('VomEngine is not available');
      return vomEngine.captureVom(params.tabId, params);
    });

    handlers.set('clickRef', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined || params.tabId === 0) throw new Error('tabId is required');
      positiveTabId(params.tabId);
      if (!params.ref || typeof params.ref !== 'string') throw new Error('ref is required');
      if (!vomEngine) throw new Error('VomEngine is not available');
      const refEntry = vomEngine.resolveRef(params.ref);
      if (!refEntry) throw new Error('Ref not found or stale: ' + params.ref);

      const tabId = params.tabId;
      const x = refEntry.center.x;
      const y = refEntry.center.y;

      return callDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: x,
        y: y,
        button: 'left',
        clickCount: 1
      }).then(function () {
        return callDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: x,
          y: y,
          button: 'left',
          clickCount: 1
        });
      }).then(function () {
        return { success: true, usedRef: params.ref, point: { x: x, y: y } };
      });
    });

    handlers.set('fillRef', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined || params.tabId === 0) throw new Error('tabId is required');
      positiveTabId(params.tabId);
      if (!params.ref || typeof params.ref !== 'string') throw new Error('ref is required');
      if (params.value === undefined) throw new Error('value is required');
      const value = String(params.value);

      if (!vomEngine) throw new Error('VomEngine is not available');
      const refEntry = vomEngine.resolveRef(params.ref);
      if (!refEntry) throw new Error('Ref not found or stale: ' + params.ref);

      const tabId = params.tabId;
      const bId = refEntry.backendNodeId;

      return callDebuggerCommand(tabId, 'DOM.focus', { backendNodeId: bId }).catch(function () {
        return callDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: refEntry.center.x,
          y: refEntry.center.y,
          button: 'left',
          clickCount: 1
        }).then(function () {
          return callDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: refEntry.center.x,
            y: refEntry.center.y,
            button: 'left',
            clickCount: 1
          });
        });
      }).then(function () {
        return callDebuggerCommand(tabId, 'Input.insertText', { text: value });
      }).then(function () {
        return { success: true, usedRef: params.ref, value: value };
      });
    });

    handlers.set('fullPageScreenshot', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined || params.tabId === 0) throw new Error('tabId is required');
      positiveTabId(params.tabId);
      if (!longScreenshotEngine) throw new Error('LongScreenshotEngine is not available');
      return longScreenshotEngine.captureFullPageScreenshot(params.tabId, params);
    });

    handlers.set('requestHelp', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined || params.tabId === 0) throw new Error('tabId is required');
      positiveTabId(params.tabId);
      if (typeof params.prompt !== 'string' || !params.prompt.trim()) {
        throw new Error('prompt is required');
      }
      if (!humanLoopManager) throw new Error('HumanLoopManager is not available');
      return humanLoopManager.requestHelp(params.tabId, params);
    });

    handlers.set('uploadFile', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined || params.tabId === 0) throw new Error('tabId is required');
      positiveTabId(params.tabId);
      if (!params.filePaths) throw new Error('filePaths is required');
      if (!Array.isArray(params.filePaths) || params.filePaths.length === 0) {
        throw new Error('filePaths must be a non-empty array of strings');
      }
      if (!fileInputTransfer || !dropFileTransfer) {
        throw new Error('FileTransfer modules are not available');
      }

      if (params.mode === 'drop') {
        return dropFileTransfer.dropFiles(params.tabId, params.filePaths, params.point);
      }

      return fileInputTransfer.uploadFiles(params.tabId, params.filePaths, function () {
        if (params.ref && vomEngine) {
          const r = vomEngine.resolveRef(params.ref);
          if (r) {
            return callDebuggerCommand(params.tabId, 'Input.dispatchMouseEvent', {
              type: 'mousePressed',
              x: r.center.x,
              y: r.center.y,
              button: 'left',
              clickCount: 1
            }).then(function () {
              return callDebuggerCommand(params.tabId, 'Input.dispatchMouseEvent', {
                type: 'mouseReleased',
                x: r.center.x,
                y: r.center.y,
                button: 'left',
                clickCount: 1
              });
            });
          }
        }
        return Promise.resolve();
      }, params.timeoutMs);
    });
  }

  return {
    registerAgentHandlers: registerAgentHandlers
  };
});
