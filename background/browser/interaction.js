(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.CrawlerBrowserInteraction = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function registerInteractionHandlers(handlers, chromeApi, cdpManager, utils) {
    if (!chromeApi) throw new Error('chromeApi is required');
    utils = utils || (typeof globalThis !== 'undefined' && globalThis.CrawlerBrowserUtils) || (typeof require === 'function' && require('./utils.js'));
    const callChrome = utils.callChrome;
    const paramsObject = utils.paramsObject;
    const positiveTabId = utils.positiveTabId;

    const tabs = chromeApi.tabs;

    handlers.set('moveMouse', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined || params.tabId === 0) throw new Error('tabId is required');
      positiveTabId(params.tabId);
      if (typeof params.x !== 'number' || !Number.isFinite(params.x)) throw new Error('x must be a finite number');
      if (params.x < 0) throw new Error('x must be non-negative');
      if (typeof params.y !== 'number' || !Number.isFinite(params.y)) throw new Error('y must be a finite number');
      if (params.y < 0) throw new Error('y must be non-negative');

      const tabId = params.tabId;
      const x = params.x;
      const y = params.y;
      const durationMs = (typeof params.durationMs === 'number' && params.durationMs >= 0) ? params.durationMs : 300;
      const waitForArrival = params.waitForArrival !== false;

      return callChrome(
        chromeApi,
        tabs.sendMessage,
        [tabId, { type: 'BROWSER_OVERLAY_MOVE', x: x, y: y, durationMs: durationMs, waitForArrival: waitForArrival }],
        'Browser tabs.sendMessage failed'
      ).then(function (res) {
        if (res && res.success) return res;
        return { success: true, arrived: true, finalX: x, finalY: y };
      }).catch(function () {
        if (chromeApi.scripting && typeof chromeApi.scripting.executeScript === 'function') {
          return callChrome(chromeApi, chromeApi.scripting.executeScript, [{
            target: { tabId: tabId },
            world: 'MAIN',
            func: function (targetX, targetY, dur, wait) {
              if (typeof window !== 'undefined' && typeof window.__crawler_animate_cursor === 'function') {
                if (!wait) {
                  window.__crawler_animate_cursor(targetX, targetY, dur);
                  return { success: true, arrived: true, finalX: targetX, finalY: targetY };
                }
                return new Promise(function (resolve) {
                  window.__crawler_animate_cursor(targetX, targetY, dur, function () {
                    resolve({ success: true, arrived: true, finalX: targetX, finalY: targetY });
                  });
                });
              }
              return { success: true, arrived: true, finalX: targetX, finalY: targetY, fallback: true };
            },
            args: [x, y, durationMs, waitForArrival]
          }], 'Browser scripting.executeScript failed').then(function (results) {
            if (results && results[0] && results[0].result) return results[0].result;
            return { success: true, arrived: true, finalX: x, finalY: y };
          }).catch(function () {
            return { success: true, tabId: tabId, x: x, y: y, arrived: false, fallback: true };
          });
        }
        return { success: true, tabId: tabId, x: x, y: y, arrived: false, fallback: true };
      });
    });

    handlers.set('getWebMcpTools', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined || params.tabId === 0) throw new Error('tabId is required');
      positiveTabId(params.tabId);
      const tabId = params.tabId;

      return callChrome(
        chromeApi,
        tabs.sendMessage,
        [tabId, { type: 'BROWSER_WEBMCP_GET_TOOLS' }],
        'Browser tabs.sendMessage failed'
      ).then(function (res) {
        return {
          success: true,
          tabId: tabId,
          tools: (res && Array.isArray(res.tools)) ? res.tools : []
        };
      }).catch(function () {
        if (chromeApi.scripting && typeof chromeApi.scripting.executeScript === 'function') {
          return callChrome(chromeApi, chromeApi.scripting.executeScript, [{
            target: { tabId: tabId },
            world: 'MAIN',
            func: function () {
              if (typeof navigator !== 'undefined' && navigator.modelContext && typeof navigator.modelContext.getTools === 'function') {
                return navigator.modelContext.getTools();
              }
              return [];
            }
          }], 'Browser scripting.executeScript failed').then(function (results) {
            const tools = (results && results[0] && Array.isArray(results[0].result)) ? results[0].result : [];
            return { success: true, tabId: tabId, tools: tools };
          }).catch(function () {
            return { success: true, tabId: tabId, tools: [], fallback: true };
          });
        }
        return { success: true, tabId: tabId, tools: [], fallback: true };
      });
    });

    handlers.set('callWebMcpTool', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined || params.tabId === 0) throw new Error('tabId is required');
      positiveTabId(params.tabId);
      if (typeof params.name !== 'string' || !params.name.trim()) throw new Error('name is required');

      const tabId = params.tabId;
      const name = params.name.trim();
      const input = params.input !== undefined ? params.input : {};
      const timeoutMs = (typeof params.timeoutMs === 'number' && params.timeoutMs > 0) ? params.timeoutMs : 30000;

      return callChrome(
        chromeApi,
        tabs.sendMessage,
        [tabId, { type: 'BROWSER_WEBMCP_CALL_TOOL', name: name, input: input, timeoutMs: timeoutMs }],
        'Browser tabs.sendMessage failed'
      ).then(function (res) {
        if (!res || res.success === false) {
          throw new Error((res && res.error) || 'WebMCP tool execution failed');
        }
        return { success: true, result: res.result };
      }).catch(function (sendError) {
        if (chromeApi.scripting && typeof chromeApi.scripting.executeScript === 'function') {
          return callChrome(chromeApi, chromeApi.scripting.executeScript, [{
            target: { tabId: tabId },
            world: 'MAIN',
            func: function (toolName, toolInput) {
              if (typeof navigator !== 'undefined' && navigator.modelContext && typeof navigator.modelContext.executeTool === 'function') {
                return Promise.resolve(navigator.modelContext.executeTool(toolName, toolInput));
              }
              throw new Error('WebMCP modelContext is not initialized on page');
            },
            args: [name, input]
          }], 'Browser scripting.executeScript failed').then(function (results) {
            if (!results || !results[0]) throw new Error('No execution result returned');
            return { success: true, result: results[0].result };
          });
        }
        throw sendError;
      });
    });
  }

  return {
    registerInteractionHandlers: registerInteractionHandlers
  };
});
