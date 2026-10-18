(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.CrawlerDevToolsCollector = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_MAX_BUFFER_SIZE = 500;

  const PREDEFINED_NETWORK_CONDITIONS = {
    'Offline': { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
    'Slow 3G': {
      offline: false,
      latency: 400,
      downloadThroughput: Math.floor((400 * 1024) / 8),
      uploadThroughput: Math.floor((400 * 1024) / 8),
      connectionType: 'cellular3g'
    },
    'Fast 3G': {
      offline: false,
      latency: 100,
      downloadThroughput: Math.floor((1.6 * 1024 * 1024) / 8),
      uploadThroughput: Math.floor((750 * 1024) / 8),
      connectionType: 'cellular3g'
    }
  };

  function createDevToolsCollector(chromeApi, cdpClient, options) {
    if (!cdpClient || typeof cdpClient.sendCommand !== 'function') {
      throw new Error('cdpClient with sendCommand is required');
    }

    const maxBufferSize = (options && typeof options.maxBufferSize === 'number' && options.maxBufferSize > 0)
      ? options.maxBufferSize
      : DEFAULT_MAX_BUFFER_SIZE;

    // tabId -> TabCollectorState
    const tabStates = new Map();

    function getOrCreateTabState(tabId) {
      let state = tabStates.get(tabId);
      if (!state) {
        state = {
          tabId: tabId,
          enabled: false,
          messages: [],
          messageIdSeq: 0,
          requests: new Map(), // reqid -> record
          requestList: [],
          requestIdSeq: 0,
          scripts: new Map(), // scriptId -> scriptRecord
          scriptList: [],
          currentDialog: null
        };
        tabStates.set(tabId, state);
      }
      return state;
    }

    function clearTab(tabId) {
      tabStates.delete(tabId);
    }

    function formatConsoleArgs(args) {
      if (!args || !Array.isArray(args)) return '';
      return args.map(function (arg) {
        if (!arg) return '';
        if (arg.value !== undefined) {
          if (typeof arg.value === 'object') {
            try { return JSON.stringify(arg.value); } catch (_) { return String(arg.value); }
          }
          return String(arg.value);
        }
        if (arg.description) return arg.description;
        if (arg.type) return `[${arg.type}]`;
        return '';
      }).join(' ');
    }

    function handleDebuggerEvent(source, method, params) {
      if (!source || typeof source.tabId !== 'number') return;
      const tabId = source.tabId;
      const state = getOrCreateTabState(tabId);

      // --- Console & Logs ---
      if (method === 'Runtime.consoleAPICalled') {
        state.messageIdSeq += 1;
        const msg = {
          id: state.messageIdSeq,
          type: params.type || 'log',
          text: formatConsoleArgs(params.args),
          args: params.args || [],
          timestamp: params.timestamp || Date.now(),
          executionContextId: params.executionContextId,
          stackTrace: params.stackTrace ? params.stackTrace.callFrames : undefined
        };
        state.messages.push(msg);
        if (state.messages.length > maxBufferSize) {
          state.messages.splice(0, state.messages.length - maxBufferSize);
        }
      } else if (method === 'Log.entryAdded') {
        const entry = params.entry || {};
        state.messageIdSeq += 1;
        const msg = {
          id: state.messageIdSeq,
          type: entry.level || 'info',
          text: entry.text || '',
          timestamp: entry.timestamp || Date.now(),
          url: entry.url,
          lineNumber: entry.lineNumber,
          stackTrace: entry.stackTrace ? entry.stackTrace.callFrames : undefined
        };
        state.messages.push(msg);
        if (state.messages.length > maxBufferSize) {
          state.messages.splice(0, state.messages.length - maxBufferSize);
        }
      } else if (method === 'Runtime.exceptionThrown') {
        const details = params.exceptionDetails || {};
        state.messageIdSeq += 1;
        const msg = {
          id: state.messageIdSeq,
          type: 'error',
          text: details.text || (details.exception && details.exception.description) || 'Uncaught Exception',
          timestamp: params.timestamp || Date.now(),
          url: details.url,
          lineNumber: details.lineNumber,
          columnNumber: details.columnNumber,
          stackTrace: details.stackTrace ? details.stackTrace.callFrames : undefined
        };
        state.messages.push(msg);
        if (state.messages.length > maxBufferSize) {
          state.messages.splice(0, state.messages.length - maxBufferSize);
        }
      }

      // --- Network ---
      else if (method === 'Network.requestWillBeSent') {
        const reqId = params.requestId;
        let record = state.requests.get(reqId);
        if (!record) {
          state.requestIdSeq += 1;
          record = {
            id: state.requestIdSeq,
            reqid: reqId,
            url: (params.request && params.request.url) || '',
            method: (params.request && params.request.method) || 'GET',
            requestHeaders: (params.request && params.request.headers) || {},
            postData: (params.request && params.request.postData) || null,
            hasPostData: !!(params.request && params.request.hasPostData),
            resourceType: (params.type || 'other').toLowerCase(),
            status: null,
            statusText: null,
            responseHeaders: null,
            mimeType: null,
            startTime: params.wallTime ? params.wallTime * 1000 : Date.now(),
            endTime: null,
            durationMs: null,
            encodedDataLength: 0,
            failed: false,
            errorText: null,
            canceled: false,
            responseBody: null
          };
          state.requests.set(reqId, record);
          state.requestList.push(record);
          if (state.requestList.length > maxBufferSize) {
            const removed = state.requestList.splice(0, state.requestList.length - maxBufferSize);
            removed.forEach(function (r) { state.requests.delete(r.reqid); });
          }
        } else {
          // Redirect or chained request
          if (params.request) {
            record.url = params.request.url || record.url;
            record.method = params.request.method || record.method;
            record.requestHeaders = params.request.headers || record.requestHeaders;
            record.postData = params.request.postData || record.postData;
            record.hasPostData = params.request.hasPostData !== undefined ? !!params.request.hasPostData : record.hasPostData;
          }
          if (params.type) {
            record.resourceType = params.type.toLowerCase();
          }
        }
      } else if (method === 'Network.requestWillBeSentExtraInfo') {
        const reqId = params.requestId;
        const record = state.requests.get(reqId);
        if (record && params.headers) {
          record.requestHeaders = Object.assign({}, record.requestHeaders || {}, params.headers);
        }
      } else if (method === 'Network.responseReceived') {
        const reqId = params.requestId;
        const record = state.requests.get(reqId);
        if (record && params.response) {
          record.status = params.response.status;
          record.statusText = params.response.statusText;
          record.responseHeaders = params.response.headers || {};
          record.mimeType = params.response.mimeType || null;
          if (params.type) {
            record.resourceType = params.type.toLowerCase();
          }
        }
      } else if (method === 'Network.responseReceivedExtraInfo') {
        const reqId = params.requestId;
        const record = state.requests.get(reqId);
        if (record && params.headers) {
          record.responseHeaders = Object.assign({}, record.responseHeaders || {}, params.headers);
        }
      } else if (method === 'Network.loadingFinished') {
        const reqId = params.requestId;
        const record = state.requests.get(reqId);
        if (record) {
          record.endTime = params.timestamp ? params.timestamp * 1000 : Date.now();
          if (record.startTime && record.endTime >= record.startTime) {
            record.durationMs = Math.round(record.endTime - record.startTime);
          }
          record.encodedDataLength = params.encodedDataLength || record.encodedDataLength;
        }
      } else if (method === 'Network.loadingFailed') {
        const reqId = params.requestId;
        const record = state.requests.get(reqId);
        if (record) {
          record.failed = true;
          record.errorText = params.errorText || 'Failed';
          record.canceled = !!params.canceled;
          record.endTime = params.timestamp ? params.timestamp * 1000 : Date.now();
          if (record.startTime && record.endTime >= record.startTime) {
            record.durationMs = Math.round(record.endTime - record.startTime);
          }
        }
      }

      // --- Dialogs ---
      else if (method === 'Page.javascriptDialogOpening') {
        state.currentDialog = {
          type: params.type || 'alert',
          message: params.message || '',
          url: params.url || '',
          defaultPrompt: params.defaultPrompt || ''
        };
      } else if (method === 'Page.javascriptDialogClosed') {
        state.currentDialog = null;
      }

      // --- Scripts (Debugger) ---
      else if (method === 'Debugger.scriptParsed') {
        const scriptId = params.scriptId != null ? String(params.scriptId) : null;
        if (scriptId) {
          const record = {
            scriptId: scriptId,
            url: params.url || '',
            startLine: typeof params.startLine === 'number' ? params.startLine : 0,
            startColumn: typeof params.startColumn === 'number' ? params.startColumn : 0,
            endLine: typeof params.endLine === 'number' ? params.endLine : 0,
            endColumn: typeof params.endColumn === 'number' ? params.endColumn : 0,
            executionContextId: params.executionContextId,
            hash: params.hash || '',
            isContentScript: !!params.isContentScript,
            sourceMapURL: params.sourceMapURL || '',
            hasSourceURL: !!params.hasSourceURL,
            length: typeof params.length === 'number' ? params.length : undefined
          };
          const existing = state.scripts.get(scriptId);
          if (existing) {
            Object.assign(existing, record);
          } else {
            state.scripts.set(scriptId, record);
            state.scriptList.push(record);
            if (state.scriptList.length > maxBufferSize * 4) {
              const removed = state.scriptList.splice(0, state.scriptList.length - maxBufferSize * 4);
              removed.forEach(function (s) { state.scripts.delete(s.scriptId); });
            }
          }
        }
      }
    }

    // Attach listeners if chromeApi is provided
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
        cdpClient.sendCommand({ tabId: tabId }, 'Log.enable').catch(function () {}),
        cdpClient.sendCommand({ tabId: tabId }, 'Runtime.enable').catch(function () {}),
        cdpClient.sendCommand({ tabId: tabId }, 'Network.enable').catch(function () {}),
        cdpClient.sendCommand({ tabId: tabId }, 'Page.enable').catch(function () {}),
        cdpClient.sendCommand({ tabId: tabId }, 'Debugger.enable').catch(function () {})
      ]);
      state.enabled = true;
    }

    async function listConsoleMessages(tabId, options) {
      options = options || {};
      const state = getOrCreateTabState(tabId);
      let list = state.messages.slice();

      if (Array.isArray(options.types) && options.types.length > 0) {
        const typesSet = new Set(options.types.map(function (t) { return String(t).toLowerCase(); }));
        list = list.filter(function (m) {
          return typesSet.has(String(m.type).toLowerCase());
        });
      }

      const total = list.length;
      const pageIdx = (typeof options.pageIdx === 'number' && options.pageIdx >= 0) ? options.pageIdx : 0;
      const pageSize = (typeof options.pageSize === 'number' && options.pageSize > 0) ? options.pageSize : total;

      const start = pageIdx * pageSize;
      const end = start + pageSize;
      const paged = list.slice(start, end).map(function (m) {
        const copy = Object.assign({}, m);
        if (!options.includeStackTraces) {
          delete copy.stackTrace;
        }
        return copy;
      });

      return {
        success: true,
        tabId: tabId,
        total: total,
        pageIdx: pageIdx,
        pageSize: pageSize,
        messages: paged
      };
    }

    async function getConsoleMessage(tabId, msgid) {
      const state = getOrCreateTabState(tabId);
      const msg = state.messages.find(function (m) { return m.id === msgid; });
      if (!msg) {
        throw new Error(`Console message with ID ${msgid} not found`);
      }
      return {
        success: true,
        tabId: tabId,
        // 键名避开 go-rpc 信封里的 message 字段（信封剔除逻辑会把同名 payload 抹掉）
        consoleMessage: Object.assign({}, msg)
      };
    }

    async function listNetworkRequests(tabId, options) {
      options = options || {};
      const state = getOrCreateTabState(tabId);
      let list = state.requestList.slice();

      if (Array.isArray(options.resourceTypes) && options.resourceTypes.length > 0) {
        const typesSet = new Set(options.resourceTypes.map(function (t) { return String(t).toLowerCase(); }));
        list = list.filter(function (r) {
          return typesSet.has(String(r.resourceType).toLowerCase());
        });
      }

      // URL 子串过滤（大小写不敏感，与 resourceTypes 的匹配风格一致）
      if (typeof options.urlFilter === 'string' && options.urlFilter !== '') {
        const needle = options.urlFilter.toLowerCase();
        list = list.filter(function (r) {
          return String(r.url || '').toLowerCase().indexOf(needle) !== -1;
        });
      }

      // 失败/异常请求：网络层失败、取消，或 HTTP 4xx/5xx
      if (options.failedOnly === true) {
        list = list.filter(function (r) {
          return r.failed === true || r.canceled === true ||
            (typeof r.status === 'number' && r.status >= 400);
        });
      }

      const total = list.length;
      const pageIdx = (typeof options.pageIdx === 'number' && options.pageIdx >= 0) ? options.pageIdx : 0;
      const pageSize = (typeof options.pageSize === 'number' && options.pageSize > 0) ? options.pageSize : total;

      const start = pageIdx * pageSize;
      const end = start + pageSize;
      const paged = list.slice(start, end).map(function (r) {
        let displayUrl = r.url;
        if (typeof displayUrl === 'string' && (displayUrl.startsWith('data:') || displayUrl.includes(';base64,')) && displayUrl.length > 100) {
          displayUrl = displayUrl.slice(0, 100);
        }
        return {
          id: r.id,
          reqid: r.reqid,
          url: displayUrl,
          method: r.method,
          resourceType: r.resourceType,
          status: r.status,
          statusText: r.statusText,
          mimeType: r.mimeType,
          durationMs: r.durationMs,
          failed: r.failed,
          errorText: r.errorText
        };
      });

      return {
        success: true,
        tabId: tabId,
        total: total,
        pageIdx: pageIdx,
        pageSize: pageSize,
        requests: paged
      };
    }

    async function getNetworkRequest(tabId, reqid) {
      const state = getOrCreateTabState(tabId);
      let record = null;
      if (typeof reqid === 'number') {
        record = state.requestList.find(function (r) { return r.id === reqid; });
      } else {
        record = state.requests.get(reqid);
      }

      if (!record) {
        throw new Error(`Network request with ID ${reqid} not found`);
      }

      let responseBody = record.responseBody;
      let base64Encoded = false;
      let bodyError = null;

      if (!record.postData && (record.hasPostData || (record.method && record.method !== 'GET' && record.method !== 'HEAD'))) {
        try {
          const postRes = await cdpClient.sendCommand(
            { tabId: tabId },
            'Network.getRequestPostData',
            { requestId: record.reqid }
          );
          if (postRes && typeof postRes.postData === 'string') {
            record.postData = postRes.postData;
          }
        } catch (_) {}
      }

      if (record.failed) {
        bodyError = record.errorText || 'Request failed';
      } else if (!responseBody) {
        try {
          const bodyRes = await cdpClient.sendCommand(
            { tabId: tabId },
            'Network.getResponseBody',
            { requestId: record.reqid }
          );
          if (bodyRes && typeof bodyRes.body === 'string') {
            responseBody = bodyRes.body;
            base64Encoded = !!bodyRes.base64Encoded;
          }
        } catch (err) {
          bodyError = (err && err.message) || String(err);
        }
      }

      return {
        success: true,
        tabId: tabId,
        request: {
          id: record.id,
          reqid: record.reqid,
          url: record.url,
          method: record.method,
          resourceType: record.resourceType,
          status: record.status,
          statusText: record.statusText,
          requestHeaders: record.requestHeaders,
          postData: record.postData,
          responseHeaders: record.responseHeaders,
          responseBody: responseBody,
          base64Encoded: base64Encoded,
          bodyError: bodyError,
          durationMs: record.durationMs,
          failed: record.failed,
          errorText: record.errorText
        }
      };
    }

    async function emulate(tabId, params) {
      params = params || {};
      const applied = [];

      // 1. Viewport / Device metrics
      if (params.viewport && typeof params.viewport === 'object') {
        const vp = params.viewport;
        await cdpClient.sendCommand({ tabId: tabId }, 'Emulation.setDeviceMetricsOverride', {
          width: vp.width || 0,
          height: vp.height || 0,
          deviceScaleFactor: typeof vp.deviceScaleFactor === 'number' ? vp.deviceScaleFactor : 1,
          mobile: !!vp.mobile
        });
        applied.push('viewport');
      }

      // 2. User-Agent
      if (params.userAgent !== undefined) {
        await cdpClient.sendCommand({ tabId: tabId }, 'Emulation.setUserAgentOverride', {
          userAgent: String(params.userAgent || '')
        });
        applied.push('userAgent');
      }

      // 3. Geolocation
      if (params.geolocation !== undefined) {
        if (params.geolocation === null) {
          await cdpClient.sendCommand({ tabId: tabId }, 'Emulation.clearGeolocationOverride');
        } else if (typeof params.geolocation === 'object') {
          const geo = params.geolocation;
          await cdpClient.sendCommand({ tabId: tabId }, 'Emulation.setGeolocationOverride', {
            latitude: Number(geo.latitude) || 0,
            longitude: Number(geo.longitude) || 0,
            accuracy: Number(geo.accuracy) || 100
          });
        }
        applied.push('geolocation');
      }

      // 4. Color Scheme
      if (params.colorScheme !== undefined) {
        const scheme = String(params.colorScheme).toLowerCase();
        await cdpClient.sendCommand({ tabId: tabId }, 'Emulation.setEmulatedMedia', {
          media: '',
          features: [{ name: 'prefers-color-scheme', value: scheme === 'dark' ? 'dark' : (scheme === 'light' ? 'light' : '') }]
        });
        applied.push('colorScheme');
      }

      // 5. Timezone / Locale
      if (params.timezoneId !== undefined) {
        await cdpClient.sendCommand({ tabId: tabId }, 'Emulation.setTimezoneOverride', {
          timezoneId: String(params.timezoneId)
        });
        applied.push('timezoneId');
      }

      if (params.locale !== undefined) {
        await cdpClient.sendCommand({ tabId: tabId }, 'Emulation.setLocaleOverride', {
          locale: String(params.locale)
        });
        applied.push('locale');
      }

      // 6. Network Conditions
      if (params.networkConditions !== undefined) {
        let cond = null;
        if (typeof params.networkConditions === 'string') {
          cond = PREDEFINED_NETWORK_CONDITIONS[params.networkConditions];
          // 名单外的条件名以前会被静默忽略，调用方会误以为限速已生效
          if (!cond) {
            throw new Error('Unknown network condition: ' + params.networkConditions +
              ' (expected Offline, Slow 3G or Fast 3G)');
          }
        } else if (typeof params.networkConditions === 'object' && params.networkConditions !== null) {
          cond = params.networkConditions;
        }

        if (cond) {
          await cdpClient.sendCommand({ tabId: tabId }, 'Network.emulateNetworkConditions', {
            offline: !!cond.offline,
            latency: Number(cond.latency) || 0,
            downloadThroughput: Number(cond.downloadThroughput) || -1,
            uploadThroughput: Number(cond.uploadThroughput) || -1,
            connectionType: cond.connectionType || undefined
          });
          applied.push('networkConditions');
        }
      }

      // 7. CPU Throttling
      if (typeof params.cpuThrottlingRate === 'number' && params.cpuThrottlingRate >= 1) {
        await cdpClient.sendCommand({ tabId: tabId }, 'Emulation.setCPUThrottlingRate', {
          rate: params.cpuThrottlingRate
        });
        applied.push('cpuThrottlingRate');
      }

      // 8. Extra HTTP Headers
      if (params.extraHttpHeaders && typeof params.extraHttpHeaders === 'object') {
        await cdpClient.sendCommand({ tabId: tabId }, 'Network.setExtraHTTPHeaders', {
          headers: params.extraHttpHeaders
        });
        applied.push('extraHttpHeaders');
      }

      return {
        success: true,
        tabId: tabId,
        applied: applied
      };
    }

    async function resizePage(tabId, params) {
      params = params || {};
      const width = Number(params.width);
      const height = Number(params.height);
      if (!Number.isFinite(width) || width <= 0) throw new Error('width must be a positive number');
      if (!Number.isFinite(height) || height <= 0) throw new Error('height must be a positive number');

      await cdpClient.sendCommand({ tabId: tabId }, 'Emulation.setDeviceMetricsOverride', {
        width: Math.round(width),
        height: Math.round(height),
        deviceScaleFactor: 1,
        mobile: false
      });

      return {
        success: true,
        tabId: tabId,
        width: Math.round(width),
        height: Math.round(height)
      };
    }

    async function handleDialog(tabId, params) {
      params = params || {};
      const action = params.action;
      if (action !== 'accept' && action !== 'dismiss') {
        throw new Error('action must be either "accept" or "dismiss"');
      }

      const state = getOrCreateTabState(tabId);
      if (!state.currentDialog) {
        throw new Error(`No open dialog found for tab ${tabId}`);
      }

      const dialogInfo = Object.assign({}, state.currentDialog);
      const accept = action === 'accept';
      const promptText = params.promptText !== undefined ? String(params.promptText) : undefined;

      await cdpClient.sendCommand({ tabId: tabId }, 'Page.handleJavaScriptDialog', {
        accept: accept,
        promptText: promptText
      });

      state.currentDialog = null;

      return {
        success: true,
        tabId: tabId,
        handled: true,
        dialog: dialogInfo
      };
    }

    async function listScripts(tabId, options) {
      options = options || {};
      const state = getOrCreateTabState(tabId);
      let list = state.scriptList.slice();

      if (typeof options.urlFilter === 'string' && options.urlFilter !== '') {
        const needle = options.urlFilter.toLowerCase();
        list = list.filter(function (s) {
          return String(s.url || '').toLowerCase().indexOf(needle) !== -1;
        });
      }

      if (typeof options.isContentScript === 'boolean') {
        list = list.filter(function (s) {
          return s.isContentScript === options.isContentScript;
        });
      }

      const total = list.length;
      const pageIdx = (typeof options.pageIdx === 'number' && options.pageIdx >= 0) ? options.pageIdx : 0;
      const pageSize = (typeof options.pageSize === 'number' && options.pageSize > 0) ? options.pageSize : total;

      const start = pageIdx * pageSize;
      const end = start + pageSize;
      const paged = list.slice(start, end).map(function (s) {
        return Object.assign({}, s);
      });

      return {
        success: true,
        tabId: tabId,
        total: total,
        pageIdx: pageIdx,
        pageSize: pageSize,
        scripts: paged
      };
    }

    async function getScriptSource(tabId, scriptId) {
      if (scriptId === undefined || scriptId === null || scriptId === '') {
        throw new Error('scriptId is required');
      }
      const sId = String(scriptId);
      const state = getOrCreateTabState(tabId);
      const meta = state.scripts.get(sId);

      const result = await cdpClient.sendCommand({ tabId: tabId }, 'Debugger.getScriptSource', {
        scriptId: sId
      });

      return {
        success: true,
        tabId: tabId,
        scriptId: sId,
        url: meta ? meta.url : undefined,
        scriptSource: (result && typeof result.scriptSource === 'string') ? result.scriptSource : '',
        bytecode: result && result.bytecode ? result.bytecode : undefined
      };
    }

    return {
      enableForTab: enableForTab,
      listConsoleMessages: listConsoleMessages,
      getConsoleMessage: getConsoleMessage,
      listNetworkRequests: listNetworkRequests,
      getNetworkRequest: getNetworkRequest,
      listScripts: listScripts,
      getScriptSource: getScriptSource,
      emulate: emulate,
      resizePage: resizePage,
      handleDialog: handleDialog,
      clearTab: clearTab
    };
  }

  return {
    createDevToolsCollector: createDevToolsCollector,
    PREDEFINED_NETWORK_CONDITIONS: PREDEFINED_NETWORK_CONDITIONS
  };
});
