(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.CrawlerBrowserUtils = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const BROWSER_ACTION_NAMES = Object.freeze([
    'getTabs',
    'getCurrentTab',
    'createTab',
    'updateTab',
    'closeTab',
    'navigate',
    'getCookies',
    'screenshot',
    'activateTab',
    'reloadTab',
    'executeScript',
    'getContent',
    'executeCdp',
    'claimTab',
    'releaseTabs',
    'moveMouse',
    'getWebMcpTools',
    'callWebMcpTool',
    'sessionStart',
    'sessionStop',
    'borrowTab',
    'returnTab',
    'observe',
    'clickRef',
    'fillRef',
    'fullPageScreenshot',
    'requestHelp',
    'uploadFile',
    'listConsoleMessages',
    'list_console_messages',
    'getConsoleMessage',
    'get_console_message',
    'listNetworkRequests',
    'list_network_requests',
    'getNetworkRequest',
    'get_network_request',
    'clearNetworkRequests',
    'clear_network_requests',
    'listWebSocketConnections',
    'list_websocket_connections',
    'getWebSocketMessages',
    'get_websocket_messages',
    'getWebSocketMessage',
    'get_websocket_message',
    'analyzeWebSocketMessages',
    'analyze_websocket_messages',
    'replayNetworkRequest',
    'replay_network_request',
    'exportRequestAsCurl',
    'export_request_as_curl',
    'replayNetworkRequestBatch',
    'replay_network_request_batch',
    'listScripts',
    'list_scripts',
    'getScriptSource',
    'get_script_source',
    'emulate',
    'resizePage',
    'resize_page',
    'handleDialog',
    'handle_dialog',
    'setBreakpoint',
    'set_breakpoint',
    'removeBreakpoint',
    'remove_breakpoint',
    'listBreakpoints',
    'list_breakpoints',
    'setBreakpointOnText',
    'set_breakpoint_on_text',
    'breakOnXhr',
    'break_on_xhr',
    'removeXhrBreakpoint',
    'remove_xhr_breakpoint',
    'pause',
    'resume',
    'stepInto',
    'step_into',
    'stepOver',
    'step_over',
    'stepOut',
    'step_out',
    'getPausedInfo',
    'get_paused_info',
    'evaluateOnCallframe',
    'evaluate_on_callframe',
    'inspectLocals',
    'inspect_locals',
    'inspectObject',
    'inspect_object',
    'searchInSources',
    'search_in_sources',
    'findInScript',
    'find_in_script',
    'queryDom',
    'query_dom',
    'getDomStructure',
    'get_dom_structure',
    'findClickableElements',
    'find_clickable_elements',
    'click',
    'clickAt',
    'click_at',
    'hover',
    'fill',
    'fillForm',
    'fill_form',
    'pressKey',
    'press_key',
    'drag',
    'reloadExtension',
    'reload_extension'
  ]);

  const CREATE_FIELDS = ['url', 'active', 'pinned', 'index', 'windowId', 'openerTabId'];
  const UPDATE_FIELDS = ['url', 'active', 'pinned', 'highlighted', 'selected', 'muted', 'autoDiscardable'];

  function isPlainObject(value) {
    if (value === null || typeof value !== 'object') return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function paramsObject(params) {
    if (params === undefined) return {};
    if (!isPlainObject(params)) throw new Error('params must be a plain object');
    return params;
  }

  function positiveTabId(value, name) {
    if (!Number.isInteger(value) || value <= 0) throw new Error((name || 'tabId') + ' must be a positive integer');
  }

  function httpUrl(value) {
    if (typeof value !== 'string') throw new Error('url must use http or https');
    let parsed;
    try { parsed = new URL(value); } catch (_) { throw new Error('url must use http or https'); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('url must use http or https');
  }

  function pick(source, fields) {
    const result = {};
    fields.forEach(function (field) {
      if (Object.prototype.hasOwnProperty.call(source, field)) result[field] = source[field];
    });
    return result;
  }

  function callChrome(chromeApi, method, args, errorMessage) {
    return new Promise(function (resolve, reject) {
      try {
        method.apply(null, args.concat(function (result) {
          const lastError = chromeApi.runtime && chromeApi.runtime.lastError;
          if (lastError) reject(new Error(errorMessage || 'Browser API call failed'));
          else resolve(result);
        }));
      } catch (error) {
        reject(error);
      }
    });
  }

  function isAllowedChatGPTHost(hostname) {
    return hostname === 'chatgpt.com' || hostname.endsWith('.chatgpt.com');
  }

  function getSiteCookiesForSender(chromeApi, sender) {
    const senderUrl = sender && sender.tab && sender.tab.url;
    let parsed;
    try { parsed = new URL(senderUrl); } catch (_) {}
    if (!parsed || parsed.protocol !== 'https:' || !isAllowedChatGPTHost(parsed.hostname)) {
      return Promise.reject(new Error('Sender tab is not an allowed ChatGPT HTTPS site'));
    }
    return callChrome(
      chromeApi,
      chromeApi.cookies.getAll,
      [{ url: senderUrl }],
      'Browser cookies.getAll failed'
    ).then(function (cookies) { return cookies || []; });
  }

  return {
    BROWSER_ACTION_NAMES: BROWSER_ACTION_NAMES,
    CREATE_FIELDS: CREATE_FIELDS,
    UPDATE_FIELDS: UPDATE_FIELDS,
    isPlainObject: isPlainObject,
    paramsObject: paramsObject,
    positiveTabId: positiveTabId,
    httpUrl: httpUrl,
    pick: pick,
    callChrome: callChrome,
    isAllowedChatGPTHost: isAllowedChatGPTHost,
    getSiteCookiesForSender: getSiteCookiesForSender
  };
});
