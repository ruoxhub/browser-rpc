(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.CrawlerBrowserDebugger = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function registerDebuggerHandlers(handlers, cdpManager, debuggerManager, utils) {
    utils = utils || (typeof globalThis !== 'undefined' && globalThis.CrawlerBrowserUtils) || (typeof require === 'function' && require('./utils.js'));
    const paramsObject = utils.paramsObject;
    const positiveTabId = utils.positiveTabId;

    const ensureDebuggerAttached = cdpManager ? cdpManager.ensureDebuggerAttached : function () {
      return Promise.reject(new Error('cdpManager not available'));
    };

    function requireDebuggerManager() {
      if (!debuggerManager) throw new Error('DebuggerManager is not available');
    }

    // --- setBreakpoint / set_breakpoint ---
    handlers.set('setBreakpoint', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined) throw new Error('tabId is required');
      positiveTabId(params.tabId);

      const url = params.url;
      const scriptId = params.scriptId !== undefined ? params.scriptId : params.script_id;
      if (!url && (scriptId === undefined || scriptId === null || scriptId === '')) {
        throw new Error('Either url or scriptId must be provided');
      }

      const lineNumber = params.lineNumber !== undefined ? params.lineNumber : params.line_number;
      if (lineNumber !== undefined && (!Number.isInteger(lineNumber) || lineNumber < 0)) {
        throw new Error('lineNumber must be a non-negative integer');
      }
      const columnNumber = params.columnNumber !== undefined ? params.columnNumber : params.column_number;
      if (columnNumber !== undefined && (!Number.isInteger(columnNumber) || columnNumber < 0)) {
        throw new Error('columnNumber must be a non-negative integer');
      }

      requireDebuggerManager();
      return ensureDebuggerAttached(params.tabId).then(function () {
        return debuggerManager.setBreakpoint(params.tabId, {
          url: url,
          scriptId: scriptId,
          lineNumber: lineNumber,
          columnNumber: columnNumber,
          condition: params.condition
        });
      });
    });
    handlers.set('set_breakpoint', handlers.get('setBreakpoint'));

    // --- removeBreakpoint / remove_breakpoint ---
    handlers.set('removeBreakpoint', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined) throw new Error('tabId is required');
      positiveTabId(params.tabId);

      const bpId = params.breakpointId !== undefined ? params.breakpointId : (params.breakpoint_id !== undefined ? params.breakpoint_id : params.id);
      if (!bpId || typeof bpId !== 'string') {
        throw new Error('breakpointId is required');
      }

      requireDebuggerManager();
      return ensureDebuggerAttached(params.tabId).then(function () {
        return debuggerManager.removeBreakpoint(params.tabId, bpId);
      });
    });
    handlers.set('remove_breakpoint', handlers.get('removeBreakpoint'));

    // --- listBreakpoints / list_breakpoints ---
    handlers.set('listBreakpoints', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined) throw new Error('tabId is required');
      positiveTabId(params.tabId);

      requireDebuggerManager();
      return ensureDebuggerAttached(params.tabId).then(function () {
        return debuggerManager.listBreakpoints(params.tabId);
      });
    });
    handlers.set('list_breakpoints', handlers.get('listBreakpoints'));

    // --- setBreakpointOnText / set_breakpoint_on_text ---
    handlers.set('setBreakpointOnText', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined) throw new Error('tabId is required');
      positiveTabId(params.tabId);

      const text = params.text !== undefined ? params.text : params.query;
      if (typeof text !== 'string' || text.trim() === '') {
        throw new Error('text is required');
      }

      const scriptId = params.scriptId !== undefined ? params.scriptId : params.script_id;

      requireDebuggerManager();
      return ensureDebuggerAttached(params.tabId).then(function () {
        return debuggerManager.setBreakpointOnText(params.tabId, {
          text: text,
          scriptId: scriptId,
          condition: params.condition,
          caseSensitive: params.caseSensitive !== undefined ? params.caseSensitive : params.case_sensitive,
          isRegex: params.isRegex !== undefined ? params.isRegex : params.is_regex
        });
      });
    });
    handlers.set('set_breakpoint_on_text', handlers.get('setBreakpointOnText'));

    // --- breakOnXhr / break_on_xhr ---
    handlers.set('breakOnXhr', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined) throw new Error('tabId is required');
      positiveTabId(params.tabId);

      const urlPattern = params.urlPattern !== undefined ? params.urlPattern : (params.url_pattern !== undefined ? params.url_pattern : params.url);
      if (urlPattern !== undefined && typeof urlPattern !== 'string') {
        throw new Error('urlPattern must be a string');
      }

      requireDebuggerManager();
      return ensureDebuggerAttached(params.tabId).then(function () {
        return debuggerManager.breakOnXhr(params.tabId, urlPattern || '');
      });
    });
    handlers.set('break_on_xhr', handlers.get('breakOnXhr'));

    // --- removeXhrBreakpoint / remove_xhr_breakpoint ---
    handlers.set('removeXhrBreakpoint', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined) throw new Error('tabId is required');
      positiveTabId(params.tabId);

      const breakpointId = params.breakpointId !== undefined ? params.breakpointId : params.breakpoint_id;
      const urlPattern = params.urlPattern !== undefined ? params.urlPattern : (params.url_pattern !== undefined ? params.url_pattern : params.url);

      requireDebuggerManager();
      return ensureDebuggerAttached(params.tabId).then(function () {
        return debuggerManager.removeXhrBreakpoint(params.tabId, breakpointId, urlPattern);
      });
    });
    handlers.set('remove_xhr_breakpoint', handlers.get('removeXhrBreakpoint'));

    // --- pause / pause ---
    handlers.set('pause', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined) throw new Error('tabId is required');
      positiveTabId(params.tabId);

      requireDebuggerManager();
      return ensureDebuggerAttached(params.tabId).then(function () {
        return debuggerManager.pause(params.tabId);
      });
    });

    // --- resume / resume ---
    handlers.set('resume', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined) throw new Error('tabId is required');
      positiveTabId(params.tabId);

      requireDebuggerManager();
      return ensureDebuggerAttached(params.tabId).then(function () {
        return debuggerManager.resume(params.tabId);
      });
    });

    // --- stepInto / step_into ---
    handlers.set('stepInto', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined) throw new Error('tabId is required');
      positiveTabId(params.tabId);

      requireDebuggerManager();
      return ensureDebuggerAttached(params.tabId).then(function () {
        return debuggerManager.stepInto(params.tabId);
      });
    });
    handlers.set('step_into', handlers.get('stepInto'));

    // --- stepOver / step_over ---
    handlers.set('stepOver', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined) throw new Error('tabId is required');
      positiveTabId(params.tabId);

      requireDebuggerManager();
      return ensureDebuggerAttached(params.tabId).then(function () {
        return debuggerManager.stepOver(params.tabId);
      });
    });
    handlers.set('step_over', handlers.get('stepOver'));

    // --- stepOut / step_out ---
    handlers.set('stepOut', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined) throw new Error('tabId is required');
      positiveTabId(params.tabId);

      requireDebuggerManager();
      return ensureDebuggerAttached(params.tabId).then(function () {
        return debuggerManager.stepOut(params.tabId);
      });
    });
    handlers.set('step_out', handlers.get('stepOut'));

    // --- getPausedInfo / get_paused_info ---
    handlers.set('getPausedInfo', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined) throw new Error('tabId is required');
      positiveTabId(params.tabId);

      requireDebuggerManager();
      return ensureDebuggerAttached(params.tabId).then(function () {
        return debuggerManager.getPausedInfo(params.tabId);
      });
    });
    handlers.set('get_paused_info', handlers.get('getPausedInfo'));

    // --- evaluateOnCallframe / evaluate_on_callframe ---
    handlers.set('evaluateOnCallframe', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined) throw new Error('tabId is required');
      positiveTabId(params.tabId);

      if (typeof params.expression !== 'string' || params.expression.trim() === '') {
        throw new Error('expression is required');
      }

      const callFrameId = params.callFrameId !== undefined ? params.callFrameId : params.call_frame_id;
      const returnByValue = params.returnByValue !== undefined ? params.returnByValue : params.return_by_value;

      requireDebuggerManager();
      return ensureDebuggerAttached(params.tabId).then(function () {
        return debuggerManager.evaluateOnCallframe(params.tabId, {
          expression: params.expression,
          callFrameId: callFrameId,
          returnByValue: returnByValue
        });
      });
    });
    handlers.set('evaluate_on_callframe', handlers.get('evaluateOnCallframe'));

    // --- inspectLocals / inspect_locals ---
    handlers.set('inspectLocals', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined) throw new Error('tabId is required');
      positiveTabId(params.tabId);

      const callFrameId = params.callFrameId !== undefined ? params.callFrameId : params.call_frame_id;

      requireDebuggerManager();
      return ensureDebuggerAttached(params.tabId).then(function () {
        return debuggerManager.inspectLocals(params.tabId, {
          callFrameId: callFrameId
        });
      });
    });
    handlers.set('inspect_locals', handlers.get('inspectLocals'));

    // --- inspectObject / inspect_object ---
    handlers.set('inspectObject', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined) throw new Error('tabId is required');
      positiveTabId(params.tabId);

      const objectId = params.objectId !== undefined ? params.objectId : params.object_id;
      if (!objectId || typeof objectId !== 'string') {
        throw new Error('objectId is required');
      }

      const ownProperties = params.ownProperties !== undefined ? params.ownProperties : params.own_properties;

      requireDebuggerManager();
      return ensureDebuggerAttached(params.tabId).then(function () {
        return debuggerManager.inspectObject(params.tabId, {
          objectId: objectId,
          ownProperties: ownProperties
        });
      });
    });
    handlers.set('inspect_object', handlers.get('inspectObject'));

    // --- findInScript / find_in_script ---
    handlers.set('findInScript', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined) throw new Error('tabId is required');
      positiveTabId(params.tabId);

      const scriptId = params.scriptId !== undefined ? params.scriptId : params.script_id;
      if (scriptId === undefined || scriptId === null || scriptId === '') {
        throw new Error('scriptId is required');
      }

      if (typeof params.query !== 'string' || params.query === '') {
        throw new Error('query is required');
      }

      const caseSensitive = params.caseSensitive !== undefined ? params.caseSensitive : params.case_sensitive;
      const isRegex = params.isRegex !== undefined ? params.isRegex : params.is_regex;

      requireDebuggerManager();
      return ensureDebuggerAttached(params.tabId).then(function () {
        return debuggerManager.findInScript(params.tabId, {
          scriptId: scriptId,
          query: params.query,
          caseSensitive: caseSensitive,
          isRegex: isRegex
        });
      });
    });
    handlers.set('find_in_script', handlers.get('findInScript'));

    // --- searchInSources / search_in_sources ---
    handlers.set('searchInSources', function (params) {
      params = paramsObject(params);
      if (params.tabId === undefined) throw new Error('tabId is required');
      positiveTabId(params.tabId);

      if (typeof params.query !== 'string' || params.query === '') {
        throw new Error('query is required');
      }

      const caseSensitive = params.caseSensitive !== undefined ? params.caseSensitive : params.case_sensitive;
      const isRegex = params.isRegex !== undefined ? params.isRegex : params.is_regex;

      requireDebuggerManager();
      return ensureDebuggerAttached(params.tabId).then(function () {
        return debuggerManager.searchInSources(params.tabId, {
          query: params.query,
          caseSensitive: caseSensitive,
          isRegex: isRegex
        });
      });
    });
    handlers.set('search_in_sources', handlers.get('searchInSources'));
  }

  return {
    registerDebuggerHandlers: registerDebuggerHandlers
  };
});
