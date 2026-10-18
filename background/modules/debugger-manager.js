(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.CrawlerDebuggerManager = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createDebuggerManager(chromeApi, cdpClient, devToolsCollector) {
    if (!cdpClient || typeof cdpClient.sendCommand !== 'function') {
      throw new Error('cdpClient with sendCommand is required');
    }

    // tabId -> TabDebuggerState
    const tabStates = new Map();

    function getOrCreateTabState(tabId) {
      let state = tabStates.get(tabId);
      if (!state) {
        state = {
          tabId: tabId,
          enabled: false,
          isPaused: false,
          pausedState: null,
          breakpoints: new Map(), // breakpointId -> BreakpointInfo
          xhrBreakpoints: new Map(), // breakpointId -> XHRBreakpointInfo
          breakpointCounter: 0,
          xhrCounter: 0
        };
        tabStates.set(tabId, state);
      }
      return state;
    }

    function clearTab(tabId) {
      tabStates.delete(tabId);
    }

    function handleDebuggerEvent(source, method, params) {
      if (!source || typeof source.tabId !== 'number') return;
      const tabId = source.tabId;
      const state = getOrCreateTabState(tabId);

      if (method === 'Debugger.paused') {
        state.isPaused = true;
        state.pausedState = {
          callFrames: (params && params.callFrames) || [],
          reason: (params && params.reason) || 'other',
          data: params && params.data,
          hitBreakpoints: (params && params.hitBreakpoints) || []
        };

        if (Array.isArray(params.hitBreakpoints)) {
          params.hitBreakpoints.forEach(function (bpId) {
            const bp = state.breakpoints.get(bpId);
            if (bp) {
              bp.hitCount = (bp.hitCount || 0) + 1;
            }
          });
        }

        if (params.reason === 'XHR' || params.reason === 'EventListener') {
          state.xhrBreakpoints.forEach(function (xhrBp) {
            xhrBp.hitCount = (xhrBp.hitCount || 0) + 1;
          });
        }
      } else if (method === 'Debugger.resumed') {
        state.isPaused = false;
        state.pausedState = null;
      } else if (method === 'Debugger.breakpointResolved') {
        if (params && params.breakpointId) {
          const bp = state.breakpoints.get(params.breakpointId);
          if (bp) {
            bp.resolvedLocation = params.location;
          }
        }
      }
    }

    if (chromeApi && chromeApi.debugger && chromeApi.debugger.onEvent) {
      chromeApi.debugger.onEvent.addListener(handleDebuggerEvent);
    }
    if (chromeApi && chromeApi.debugger && chromeApi.debugger.onDetach) {
      chromeApi.debugger.onDetach.addListener(function (source) {
        if (source && typeof source.tabId === 'number') {
          clearTab(source.tabId);
        }
      });
    }
    if (chromeApi && chromeApi.tabs && chromeApi.tabs.onRemoved) {
      chromeApi.tabs.onRemoved.addListener(function (tabId) {
        clearTab(tabId);
      });
    }

    async function enableForTab(tabId) {
      const state = getOrCreateTabState(tabId);
      if (state.enabled) return;
      await Promise.all([
        cdpClient.sendCommand({ tabId: tabId }, 'Debugger.enable').catch(function () {}),
        cdpClient.sendCommand({ tabId: tabId }, 'Runtime.enable').catch(function () {})
      ]);
      state.enabled = true;
    }

    async function setBreakpoint(tabId, params) {
      await enableForTab(tabId);
      const state = getOrCreateTabState(tabId);
      params = params || {};

      if (params.url) {
        const cmdParams = {
          url: params.url,
          lineNumber: typeof params.lineNumber === 'number' ? params.lineNumber : 0
        };
        if (typeof params.columnNumber === 'number') {
          cmdParams.columnNumber = params.columnNumber;
        }
        if (typeof params.condition === 'string' && params.condition.trim() !== '') {
          cmdParams.condition = params.condition;
        }

        const res = await cdpClient.sendCommand({ tabId: tabId }, 'Debugger.setBreakpointByUrl', cmdParams);
        const bpId = res.breakpointId;
        const bpInfo = {
          id: bpId,
          url: params.url,
          lineNumber: cmdParams.lineNumber,
          columnNumber: cmdParams.columnNumber || 0,
          condition: cmdParams.condition || null,
          hitCount: 0,
          actualLocations: res.locations || []
        };
        state.breakpoints.set(bpId, bpInfo);

        return {
          success: true,
          tabId: tabId,
          breakpointId: bpId,
          actualLocations: res.locations || []
        };
      } else if (params.scriptId) {
        const cmdParams = {
          location: {
            scriptId: String(params.scriptId),
            lineNumber: typeof params.lineNumber === 'number' ? params.lineNumber : 0
          }
        };
        if (typeof params.columnNumber === 'number') {
          cmdParams.location.columnNumber = params.columnNumber;
        }
        if (typeof params.condition === 'string' && params.condition.trim() !== '') {
          cmdParams.condition = params.condition;
        }

        const res = await cdpClient.sendCommand({ tabId: tabId }, 'Debugger.setBreakpoint', cmdParams);
        const bpId = res.breakpointId;
        const actualLocations = res.actualLocation ? [res.actualLocation] : [];
        const bpInfo = {
          id: bpId,
          scriptId: String(params.scriptId),
          lineNumber: cmdParams.location.lineNumber,
          columnNumber: cmdParams.location.columnNumber || 0,
          condition: cmdParams.condition || null,
          hitCount: 0,
          actualLocations: actualLocations
        };
        state.breakpoints.set(bpId, bpInfo);

        return {
          success: true,
          tabId: tabId,
          breakpointId: bpId,
          actualLocations: actualLocations
        };
      } else {
        throw new Error('Either url or scriptId must be provided');
      }
    }

    async function removeBreakpoint(tabId, breakpointId) {
      await enableForTab(tabId);
      const state = getOrCreateTabState(tabId);
      if (!breakpointId) {
        throw new Error('breakpointId is required');
      }

      await cdpClient.sendCommand({ tabId: tabId }, 'Debugger.removeBreakpoint', {
        breakpointId: breakpointId
      });
      state.breakpoints.delete(breakpointId);

      return {
        success: true,
        tabId: tabId,
        breakpointId: breakpointId
      };
    }

    async function listBreakpoints(tabId) {
      const state = getOrCreateTabState(tabId);
      const bps = Array.from(state.breakpoints.values());
      const xhrBps = Array.from(state.xhrBreakpoints.values());

      return {
        success: true,
        tabId: tabId,
        total: bps.length + xhrBps.length,
        breakpoints: bps,
        xhrBreakpoints: xhrBps
      };
    }

    async function breakOnXhr(tabId, urlPattern) {
      await enableForTab(tabId);
      const state = getOrCreateTabState(tabId);
      const pattern = typeof urlPattern === 'string' ? urlPattern : '';

      await cdpClient.sendCommand({ tabId: tabId }, 'DOMDebugger.setXHRBreakpoint', {
        url: pattern
      });

      state.xhrCounter += 1;
      const bpId = 'xhr_' + state.xhrCounter;
      const xhrInfo = {
        id: bpId,
        urlPattern: pattern,
        hitCount: 0
      };
      state.xhrBreakpoints.set(bpId, xhrInfo);

      return {
        success: true,
        tabId: tabId,
        breakpointId: bpId,
        urlPattern: pattern
      };
    }

    async function removeXhrBreakpoint(tabId, breakpointId, urlPattern) {
      await enableForTab(tabId);
      const state = getOrCreateTabState(tabId);
      let pattern = null;

      if (breakpointId && state.xhrBreakpoints.has(breakpointId)) {
        pattern = state.xhrBreakpoints.get(breakpointId).urlPattern;
        state.xhrBreakpoints.delete(breakpointId);
      } else if (typeof urlPattern === 'string') {
        pattern = urlPattern;
        for (const [id, bp] of state.xhrBreakpoints.entries()) {
          if (bp.urlPattern === urlPattern) {
            state.xhrBreakpoints.delete(id);
            break;
          }
        }
      } else if (breakpointId) {
        // 尝试按原样移除
        pattern = breakpointId;
      }

      if (pattern !== null) {
        await cdpClient.sendCommand({ tabId: tabId }, 'DOMDebugger.removeXHRBreakpoint', {
          url: pattern
        });
      }

      return {
        success: true,
        tabId: tabId
      };
    }

    async function pause(tabId) {
      await enableForTab(tabId);
      await cdpClient.sendCommand({ tabId: tabId }, 'Debugger.pause');
      return { success: true, tabId: tabId };
    }

    async function resume(tabId) {
      await enableForTab(tabId);
      const state = getOrCreateTabState(tabId);
      if (state.isPaused) {
        try {
          await cdpClient.sendCommand({ tabId: tabId }, 'Debugger.resume');
        } catch (_) {}
      }
      state.isPaused = false;
      state.pausedState = null;
      return { success: true, tabId: tabId };
    }

    async function stepInto(tabId) {
      await enableForTab(tabId);
      const state = getOrCreateTabState(tabId);
      if (!state.isPaused) {
        throw new Error('Execution is not paused');
      }
      await cdpClient.sendCommand({ tabId: tabId }, 'Debugger.stepInto');
      return { success: true, tabId: tabId };
    }

    async function stepOver(tabId) {
      await enableForTab(tabId);
      const state = getOrCreateTabState(tabId);
      if (!state.isPaused) {
        throw new Error('Execution is not paused');
      }
      await cdpClient.sendCommand({ tabId: tabId }, 'Debugger.stepOver');
      return { success: true, tabId: tabId };
    }

    async function stepOut(tabId) {
      await enableForTab(tabId);
      const state = getOrCreateTabState(tabId);
      if (!state.isPaused) {
        throw new Error('Execution is not paused');
      }
      await cdpClient.sendCommand({ tabId: tabId }, 'Debugger.stepOut');
      return { success: true, tabId: tabId };
    }

    async function getPausedInfo(tabId) {
      const state = getOrCreateTabState(tabId);
      if (state.isPaused && state.pausedState) {
        return {
          success: true,
          tabId: tabId,
          isPaused: true,
          reason: state.pausedState.reason,
          hitBreakpoints: state.pausedState.hitBreakpoints,
          callFrames: state.pausedState.callFrames
        };
      }
      return {
        success: true,
        tabId: tabId,
        isPaused: false,
        reason: null,
        hitBreakpoints: [],
        callFrames: []
      };
    }

    async function evaluateOnCallframe(tabId, params) {
      await enableForTab(tabId);
      const state = getOrCreateTabState(tabId);
      params = params || {};

      let callFrameId = params.callFrameId;
      if (!callFrameId && state.pausedState && state.pausedState.callFrames && state.pausedState.callFrames.length > 0) {
        callFrameId = state.pausedState.callFrames[0].callFrameId;
      }

      if (!callFrameId) {
        throw new Error('Not paused or callFrameId is required');
      }
      if (typeof params.expression !== 'string' || params.expression.trim() === '') {
        throw new Error('expression is required');
      }

      const res = await cdpClient.sendCommand({ tabId: tabId }, 'Debugger.evaluateOnCallFrame', {
        callFrameId: callFrameId,
        expression: params.expression,
        returnByValue: params.returnByValue !== false,
        generatePreview: true
      });

      return {
        success: true,
        tabId: tabId,
        callFrameId: callFrameId,
        result: res.result,
        exceptionDetails: res.exceptionDetails
      };
    }

    async function inspectLocals(tabId, params) {
      await enableForTab(tabId);
      const state = getOrCreateTabState(tabId);
      params = params || {};

      let targetFrame = null;
      if (state.pausedState && Array.isArray(state.pausedState.callFrames)) {
        if (params.callFrameId) {
          targetFrame = state.pausedState.callFrames.find(function (f) { return f.callFrameId === params.callFrameId; });
        } else {
          targetFrame = state.pausedState.callFrames[0];
        }
      }

      if (!targetFrame) {
        throw new Error('Target callFrame not found or execution is not paused');
      }

      const variables = [];
      const scopeChain = targetFrame.scopeChain || [];

      for (const scope of scopeChain) {
        // 只检查常用的 local / closure / catch / block 作用域
        if (scope.type === 'global') continue;
        const objectId = scope.object && scope.object.objectId;
        if (!objectId) continue;

        try {
          const propRes = await cdpClient.sendCommand({ tabId: tabId }, 'Runtime.getProperties', {
            objectId: objectId,
            ownProperties: true,
            generatePreview: true
          });

          if (propRes && Array.isArray(propRes.result)) {
            for (const prop of propRes.result) {
              if (prop.name === '__proto__' || prop.name === 'this' || prop.name.startsWith('[[') || prop.name.startsWith('__')) {
                continue;
              }
              const val = prop.value;
              variables.push({
                name: prop.name,
                type: val ? val.type : 'undefined',
                value: val ? (val.value !== undefined ? val.value : (val.description || `[${val.type}]`)) : undefined,
                objectId: val ? val.objectId : undefined,
                scope: scope.type
              });
            }
          }
        } catch (_) {}
      }

      return {
        success: true,
        tabId: tabId,
        callFrameId: targetFrame.callFrameId,
        functionName: targetFrame.functionName || '',
        variables: variables
      };
    }

    async function inspectObject(tabId, params) {
      await enableForTab(tabId);
      params = params || {};
      if (!params.objectId) {
        throw new Error('objectId is required');
      }

      const propRes = await cdpClient.sendCommand({ tabId: tabId }, 'Runtime.getProperties', {
        objectId: params.objectId,
        ownProperties: params.ownProperties !== false,
        generatePreview: true
      });

      const properties = [];
      if (propRes && Array.isArray(propRes.result)) {
        for (const prop of propRes.result) {
          const val = prop.value;
          properties.push({
            name: prop.name,
            type: val ? val.type : 'undefined',
            value: val ? (val.value !== undefined ? val.value : (val.description || `[${val.type}]`)) : undefined,
            objectId: val ? val.objectId : undefined
          });
        }
      }

      return {
        success: true,
        tabId: tabId,
        objectId: params.objectId,
        properties: properties
      };
    }

    async function findInScript(tabId, params) {
      await enableForTab(tabId);
      params = params || {};
      if (params.scriptId === undefined || params.scriptId === null || params.scriptId === '') {
        throw new Error('scriptId is required');
      }
      if (typeof params.query !== 'string' || params.query === '') {
        throw new Error('query is required');
      }

      const res = await cdpClient.sendCommand({ tabId: tabId }, 'Debugger.searchInContent', {
        scriptId: String(params.scriptId),
        query: params.query,
        caseSensitive: !!params.caseSensitive,
        isRegex: !!params.isRegex
      });

      return {
        success: true,
        tabId: tabId,
        scriptId: String(params.scriptId),
        matches: res.result || []
      };
    }

    async function searchInSources(tabId, params) {
      await enableForTab(tabId);
      params = params || {};
      if (typeof params.query !== 'string' || params.query === '') {
        throw new Error('query is required');
      }

      let scripts = [];
      if (devToolsCollector && typeof devToolsCollector.listScripts === 'function') {
        const scriptListRes = await devToolsCollector.listScripts(tabId);
        if (scriptListRes && Array.isArray(scriptListRes.scripts)) {
          scripts = scriptListRes.scripts;
        }
      }

      const results = [];
      let totalMatches = 0;

      for (const script of scripts) {
        if (!script.scriptId) continue;
        try {
          const findRes = await findInScript(tabId, {
            scriptId: script.scriptId,
            query: params.query,
            caseSensitive: params.caseSensitive,
            isRegex: params.isRegex
          });

          if (findRes.matches && findRes.matches.length > 0) {
            results.push({
              scriptId: script.scriptId,
              url: script.url || '',
              matches: findRes.matches
            });
            totalMatches += findRes.matches.length;
          }
        } catch (_) {}
      }

      return {
        success: true,
        tabId: tabId,
        query: params.query,
        totalMatches: totalMatches,
        results: results
      };
    }

    async function setBreakpointOnText(tabId, params) {
      await enableForTab(tabId);
      params = params || {};
      if (typeof params.text !== 'string' || params.text.trim() === '') {
        throw new Error('text is required');
      }

      let targetScriptId = params.scriptId ? String(params.scriptId) : null;
      let matchedLine = null;
      let matchedContent = null;

      if (targetScriptId) {
        const findRes = await findInScript(tabId, {
          scriptId: targetScriptId,
          query: params.text,
          caseSensitive: params.caseSensitive,
          isRegex: params.isRegex
        });
        if (findRes.matches && findRes.matches.length > 0) {
          matchedLine = findRes.matches[0].lineNumber;
          matchedContent = findRes.matches[0].lineContent;
        }
      } else {
        const searchRes = await searchInSources(tabId, {
          query: params.text,
          caseSensitive: params.caseSensitive,
          isRegex: params.isRegex
        });
        if (searchRes.results && searchRes.results.length > 0) {
          const firstScript = searchRes.results[0];
          targetScriptId = firstScript.scriptId;
          matchedLine = firstScript.matches[0].lineNumber;
          matchedContent = firstScript.matches[0].lineContent;
        }
      }

      if (matchedLine === null || !targetScriptId) {
        throw new Error('Text pattern not found in sources: ' + params.text);
      }

      const bpRes = await setBreakpoint(tabId, {
        scriptId: targetScriptId,
        lineNumber: matchedLine,
        condition: params.condition
      });

      return {
        success: true,
        tabId: tabId,
        breakpointId: bpRes.breakpointId,
        scriptId: targetScriptId,
        matchedLine: matchedLine,
        lineContent: matchedContent
      };
    }

    return {
      enableForTab: enableForTab,
      setBreakpoint: setBreakpoint,
      removeBreakpoint: removeBreakpoint,
      listBreakpoints: listBreakpoints,
      breakOnXhr: breakOnXhr,
      removeXhrBreakpoint: removeXhrBreakpoint,
      pause: pause,
      resume: resume,
      stepInto: stepInto,
      stepOver: stepOver,
      stepOut: stepOut,
      getPausedInfo: getPausedInfo,
      evaluateOnCallframe: evaluateOnCallframe,
      inspectLocals: inspectLocals,
      inspectObject: inspectObject,
      findInScript: findInScript,
      searchInSources: searchInSources,
      setBreakpointOnText: setBreakpointOnText,
      clearTab: clearTab
    };
  }

  return {
    createDebuggerManager: createDebuggerManager
  };
});
