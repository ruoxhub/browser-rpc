(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.CrawlerNetworkModule = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_MAX_BUFFER_SIZE = 500;
  const DEFAULT_WAIT_TIMEOUT_MS = 5000;
  const WAIT_POLL_INTERVAL_MS = 50;

  // 由浏览器/底层网络栈管理的 hop-by-hop 传输头，重放或导出 curl 时剥离
  const STRIPPED_HEADERS = Object.freeze([
    'host',
    'content-length',
    'connection',
    'accept-encoding',
    'content-encoding',
    'transfer-encoding',
    'keep-alive'
  ]);

  const STRIPPED_HEADERS_LOWER = new Set(STRIPPED_HEADERS.map(function (h) { return h.toLowerCase(); }));

  // 签名相关请求头匹配正则：sign/signature/token/auth/nonce/timestamp/x-sign
  const SIGNATURE_HEADER_PATTERN = /(^|[-_])(sign|signature|token|auth|nonce|timestamp)([-_]|$)|x-sign/i;

  function stripManagedHeaders(headers) {
    if (!headers || typeof headers !== 'object') return {};
    const result = {};
    for (const key of Object.keys(headers)) {
      if (!STRIPPED_HEADERS_LOWER.has(key.toLowerCase())) {
        result[key] = headers[key];
      }
    }
    return result;
  }

  function mergeHeaders(original, override) {
    original = original || {};
    if (!override || typeof override !== 'object') {
      return Object.assign({}, original);
    }
    const result = Object.assign({}, original);
    const originalKeysLower = new Map();
    for (const key of Object.keys(original)) {
      originalKeysLower.set(key.toLowerCase(), key);
    }
    for (const overrideKey of Object.keys(override)) {
      const lower = overrideKey.toLowerCase();
      const existingKey = originalKeysLower.get(lower);
      if (existingKey !== undefined && existingKey !== overrideKey) {
        delete result[existingKey];
      }
      result[overrideKey] = override[overrideKey];
    }
    return result;
  }

  function escapeShellArg(arg) {
    if (arg === undefined || arg === null) return "''";
    const str = String(arg);
    // 单引号转义：' -> '\''
    return "'" + str.replace(/'/g, "'\\''") + "'";
  }

  function formatCurl(options) {
    options = options || {};
    const method = (options.method || 'GET').toUpperCase();
    const url = options.url || '';
    const headers = options.headers || {};
    const body = options.body;

    const parts = ['curl'];
    if (method !== 'GET') {
      parts.push('-X', escapeShellArg(method));
    }
    parts.push(escapeShellArg(url));

    for (const key of Object.keys(headers)) {
      parts.push('-H', escapeShellArg(`${key}: ${headers[key]}`));
    }

    if (body !== undefined && body !== null && method !== 'GET' && method !== 'HEAD') {
      parts.push('--data-raw', escapeShellArg(body));
    }

    return parts.join(' ');
  }

  function createNetworkManager(chromeApi, cdpClient, options) {
    if (!cdpClient || typeof cdpClient.sendCommand !== 'function') {
      throw new Error('cdpClient with sendCommand is required');
    }

    const maxBufferSize = (options && typeof options.maxBufferSize === 'number' && options.maxBufferSize > 0)
      ? options.maxBufferSize
      : DEFAULT_MAX_BUFFER_SIZE;

    const customFetch = (options && typeof options.fetchFn === 'function')
      ? options.fetchFn
      : (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);

    // tabId -> TabNetworkState
    const tabStates = new Map();

    function getOrCreateTabState(tabId) {
      let state = tabStates.get(tabId);
      if (!state) {
        state = {
          tabId: tabId,
          enabled: false,
          requests: new Map(), // reqid -> RequestRecord
          requestList: [],
          requestIdSeq: 0,
          wsConnections: new Map(), // wsid / cdpRequestId -> WsConnectionRecord
          wsList: [],
          wsIdSeq: 0
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

      // ─── HTTP Requests ────────────────────────────────────
      if (method === 'Network.requestWillBeSent') {
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
            responseBody: null,
            initiator: params.initiator || null
          };
          state.requests.set(reqId, record);
          state.requestList.push(record);
          if (state.requestList.length > maxBufferSize) {
            const removed = state.requestList.splice(0, state.requestList.length - maxBufferSize);
            removed.forEach(function (r) { state.requests.delete(r.reqid); });
          }
        } else {
          // 重定向或链式请求
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

      // ─── WebSocket ────────────────────────────────────────
      else if (method === 'Network.webSocketCreated') {
        const cdpReqId = params.requestId;
        let wsConn = state.wsConnections.get(cdpReqId);
        if (!wsConn) {
          state.wsIdSeq += 1;
          wsConn = {
            wsid: state.wsIdSeq,
            cdpRequestId: cdpReqId,
            url: params.url || '',
            initiator: params.initiator || null,
            status: 'connecting',
            createdAt: Date.now(),
            closedAt: null,
            frames: []
          };
          state.wsConnections.set(cdpReqId, wsConn);
          state.wsConnections.set(wsConn.wsid, wsConn);
          state.wsList.push(wsConn);
          if (state.wsList.length > maxBufferSize) {
            const removed = state.wsList.splice(0, state.wsList.length - maxBufferSize);
            removed.forEach(function (c) {
              state.wsConnections.delete(c.cdpRequestId);
              state.wsConnections.delete(c.wsid);
            });
          }
        }
      } else if (method === 'Network.webSocketWillSendHandshakeRequest') {
        const wsConn = state.wsConnections.get(params.requestId);
        if (wsConn) {
          wsConn.status = 'open';
          if (params.request && params.request.headers) {
            wsConn.handshakeRequestHeaders = params.request.headers;
          }
        }
      } else if (method === 'Network.webSocketHandshakeResponseReceived') {
        const wsConn = state.wsConnections.get(params.requestId);
        if (wsConn) {
          wsConn.status = 'open';
          if (params.response && params.response.headers) {
            wsConn.handshakeResponseHeaders = params.response.headers;
          }
        }
      } else if (method === 'Network.webSocketFrameSent') {
        const wsConn = state.wsConnections.get(params.requestId);
        if (wsConn) {
          const resp = params.response || {};
          const frame = {
            direction: 'sent',
            timestamp: params.timestamp ? params.timestamp * 1000 : Date.now(),
            opcode: resp.opcode !== undefined ? resp.opcode : 1,
            payloadData: resp.payloadData || ''
          };
          wsConn.frames.push(frame);
          if (wsConn.frames.length > maxBufferSize) {
            wsConn.frames.splice(0, wsConn.frames.length - maxBufferSize);
          }
        }
      } else if (method === 'Network.webSocketFrameReceived') {
        const wsConn = state.wsConnections.get(params.requestId);
        if (wsConn) {
          const resp = params.response || {};
          const frame = {
            direction: 'received',
            timestamp: params.timestamp ? params.timestamp * 1000 : Date.now(),
            opcode: resp.opcode !== undefined ? resp.opcode : 1,
            payloadData: resp.payloadData || ''
          };
          wsConn.frames.push(frame);
          if (wsConn.frames.length > maxBufferSize) {
            wsConn.frames.splice(0, wsConn.frames.length - maxBufferSize);
          }
        }
      } else if (method === 'Network.webSocketClosed') {
        const wsConn = state.wsConnections.get(params.requestId);
        if (wsConn) {
          wsConn.status = 'closed';
          wsConn.closedAt = params.timestamp ? params.timestamp * 1000 : Date.now();
        }
      }
    }

    if (chromeApi && chromeApi.debugger && chromeApi.debugger.onEvent) {
      chromeApi.debugger.onEvent.addListener(handleDebuggerEvent);
    }
    if (chromeApi && chromeApi.debugger && chromeApi.debugger.onDetach) {
      chromeApi.debugger.onDetach.addListener(function (source) {
        if (source && typeof source.tabId === 'number') clearTab(source.tabId);
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
      await cdpClient.sendCommand({ tabId: tabId }, 'Network.enable', {
        maxTotalBufferSize: 10 * 1024 * 1024,
        maxResourceBufferSize: 5 * 1024 * 1024
      });
      state.enabled = true;
    }

    // ─── HTTP 查询与操作 ────────────────────────────────────

    async function listNetworkRequests(tabId, params) {
      params = params || {};
      const state = getOrCreateTabState(tabId);
      let items = state.requestList.slice();

      // 1. 过滤扩展请求（默认不包含扩展内部请求）
      const includeExtension = !!params.includeExtensionRequests;
      if (!includeExtension) {
        items = items.filter(function (r) {
          return !r.url.startsWith('chrome-extension://') && !r.url.startsWith('moz-extension://');
        });
      }

      // 2. 资源类型过滤
      if (params.resourceTypes && Array.isArray(params.resourceTypes) && params.resourceTypes.length > 0) {
        const typeSet = new Set(params.resourceTypes.map(function (t) { return String(t).toLowerCase(); }));
        items = items.filter(function (r) {
          return typeSet.has(r.resourceType.toLowerCase());
        });
      }

      // 3. URL 过滤
      if (params.urlFilter && typeof params.urlFilter === 'string') {
        const filterStr = params.urlFilter.toLowerCase();
        items = items.filter(function (r) {
          return r.url.toLowerCase().includes(filterStr);
        });
      }

      // 4. 失败过滤
      if (params.failedOnly) {
        items = items.filter(function (r) {
          return r.failed || (r.status !== null && r.status >= 400);
        });
      }

      // 5. 签名特征关联 (SignatureDetector)
      let evidenceCorrelations = undefined;
      if (params.includeSignatureEvidence) {
        evidenceCorrelations = [];
        items.forEach(function (r) {
          const indicators = [];
          if (r.requestHeaders && typeof r.requestHeaders === 'object') {
            Object.keys(r.requestHeaders).forEach(function (k) {
              if (SIGNATURE_HEADER_PATTERN.test(k)) indicators.push(k);
            });
          }
          if (r.url && r.url.includes('?')) {
            const search = r.url.substring(r.url.indexOf('?') + 1);
            const paramsList = search.split('&');
            paramsList.forEach(function (p) {
              const eqIdx = p.indexOf('=');
              const key = eqIdx > -1 ? p.substring(0, eqIdx) : p;
              if (SIGNATURE_HEADER_PATTERN.test(key) && !indicators.includes(key)) {
                indicators.push(key);
              }
            });
          }
          if (indicators.length > 0) {
            evidenceCorrelations.push({
              reqid: r.id,
              signatureIndicators: indicators,
              initiator: r.initiator,
              nextSteps: [
                '调用 get_network_request 查看完整请求头与负载',
                '调用 export_request_as_curl 获取重现命令',
                '调用 replay_network_request_batch 测试参数变异签名校验'
              ]
            });
          }
        });
      }

      const total = items.length;
      const pageSize = params.pageSize || 50;
      const pageIdx = params.pageIdx || 0;
      const start = pageIdx * pageSize;
      const paged = items.slice(start, start + pageSize).map(function (r) {
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

      const response = {
        success: true,
        tabId: tabId,
        total: total,
        pageIdx: pageIdx,
        pageSize: pageSize,
        requests: paged
      };
      if (evidenceCorrelations !== undefined) {
        response.evidenceCorrelations = evidenceCorrelations;
      }
      return response;
    }

    async function getNetworkRequest(tabId, reqid, opts) {
      opts = opts || {};
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

      // 如果尚未获取 postData 且请求可能包含请求体，通过 CDP 尝试主动拉取完整请求体
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
            record.responseBody = responseBody;
          }
        } catch (err) {
          bodyError = (err && err.message) || String(err);
        }
      }

      const totalBodyLength = responseBody ? responseBody.length : 0;
      let isTruncated = false;
      const maxBodyLength = typeof opts.maxBodyLength === 'number' && opts.maxBodyLength > 0
        ? opts.maxBodyLength
        : null;

      if (responseBody && maxBodyLength && responseBody.length > maxBodyLength) {
        responseBody = responseBody.substring(0, maxBodyLength);
        isTruncated = true;
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
          requestHeaders: record.requestHeaders || {},
          postData: record.postData,
          responseHeaders: record.responseHeaders || {},
          responseBody: responseBody,
          base64Encoded: base64Encoded,
          bodyError: bodyError,
          durationMs: record.durationMs,
          failed: record.failed,
          errorText: record.errorText,
          initiator: record.initiator,
          totalBodyLength: totalBodyLength,
          isTruncated: isTruncated
        }
      };
    }

    async function clearNetworkRequests(tabId) {
      const state = getOrCreateTabState(tabId);
      const count = state.requestList.length;
      state.requests.clear();
      state.requestList = [];
      return {
        success: true,
        tabId: tabId,
        clearedCount: count
      };
    }

    // ─── WebSocket 查询与分析 ───────────────────────────────

    async function listWebSocketConnections(tabId, params) {
      params = params || {};
      const state = getOrCreateTabState(tabId);
      let items = state.wsList.slice();

      if (params.urlFilter && typeof params.urlFilter === 'string') {
        const filterStr = params.urlFilter.toLowerCase();
        items = items.filter(function (c) {
          return c.url.toLowerCase().includes(filterStr);
        });
      }

      const total = items.length;
      const pageSize = params.pageSize || 50;
      const pageIdx = params.pageIdx || 0;
      const start = pageIdx * pageSize;
      const paged = items.slice(start, start + pageSize).map(function (c) {
        const frames = c.frames || [];
        const sentCount = frames.filter(function (f) { return f.direction === 'sent'; }).length;
        const receivedCount = frames.filter(function (f) { return f.direction === 'received'; }).length;
        const hasBinary = frames.some(function (f) { return f.opcode === 2; });

        return {
          wsid: c.wsid,
          cdpRequestId: c.cdpRequestId,
          url: c.url,
          status: c.status,
          createdAt: c.createdAt,
          closedAt: c.closedAt,
          frameCount: frames.length,
          sentCount: sentCount,
          receivedCount: receivedCount,
          hasBinary: hasBinary,
          initiator: c.initiator
        };
      });

      return {
        success: true,
        tabId: tabId,
        total: total,
        pageIdx: pageIdx,
        pageSize: pageSize,
        connections: paged
      };
    }

    async function getWebSocketMessages(tabId, params) {
      params = params || {};
      const wsid = params.wsid;
      if (wsid === undefined) {
        throw new Error('wsid is required');
      }

      const state = getOrCreateTabState(tabId);
      const conn = state.wsConnections.get(wsid);
      if (!conn) {
        throw new Error(`WebSocket connection ${wsid} not found`);
      }

      let frames = conn.frames.slice();
      if (params.direction && params.direction !== 'both') {
        frames = frames.filter(function (f) { return f.direction === params.direction; });
      }

      const total = frames.length;
      const pageSize = params.pageSize || 50;
      const pageIdx = params.pageIdx || 0;
      const showContent = params.showContent !== false; // 默认展示
      const maxPayload = params.maxPayloadLength || 1000;

      const start = pageIdx * pageSize;
      const paged = frames.slice(start, start + pageSize).map(function (f, idx) {
        let payload = showContent ? f.payloadData : undefined;
        if (payload && payload.length > maxPayload) {
          payload = payload.substring(0, maxPayload) + '...[truncated]';
        }
        return {
          index: start + idx,
          direction: f.direction,
          timestamp: f.timestamp,
          opcode: f.opcode,
          payloadData: payload,
          payloadLength: f.payloadData ? f.payloadData.length : 0
        };
      });

      return {
        success: true,
        tabId: tabId,
        wsid: conn.wsid,
        total: total,
        pageIdx: pageIdx,
        pageSize: pageSize,
        frames: paged
      };
    }

    async function getWebSocketMessage(tabId, params) {
      params = params || {};
      const wsid = params.wsid;
      const frameIndex = params.frameIndex;
      if (wsid === undefined) throw new Error('wsid is required');
      if (typeof frameIndex !== 'number' || frameIndex < 0) {
        throw new Error('frameIndex must be a non-negative integer');
      }

      const state = getOrCreateTabState(tabId);
      const conn = state.wsConnections.get(wsid);
      if (!conn) throw new Error(`WebSocket connection ${wsid} not found`);

      if (frameIndex >= conn.frames.length) {
        throw new Error(`Frame index ${frameIndex} out of bounds (total ${conn.frames.length})`);
      }

      const frame = conn.frames[frameIndex];
      let decodedPayload = undefined;
      const decodeMode = params.decode || 'utf-8';

      if (decodeMode === 'json') {
        try {
          decodedPayload = JSON.parse(frame.payloadData);
        } catch (_) {
          decodedPayload = null;
        }
      } else if (decodeMode === 'base64' && frame.opcode === 2) {
        decodedPayload = frame.payloadData;
      }

      return {
        success: true,
        tabId: tabId,
        wsid: conn.wsid,
        frameIndex: frameIndex,
        frame: {
          direction: frame.direction,
          timestamp: frame.timestamp,
          opcode: frame.opcode,
          payloadData: frame.payloadData,
          decodedPayload: decodedPayload
        }
      };
    }

    async function analyzeWebSocketMessages(tabId, params) {
      params = params || {};
      const wsid = params.wsid;
      if (wsid === undefined) throw new Error('wsid is required');

      const state = getOrCreateTabState(tabId);
      const conn = state.wsConnections.get(wsid);
      if (!conn) throw new Error(`WebSocket connection ${wsid} not found`);

      let frames = conn.frames.slice();
      if (params.direction && params.direction !== 'both') {
        frames = frames.filter(function (f) { return f.direction === params.direction; });
      }

      let sentCount = 0;
      let receivedCount = 0;
      let totalBytes = 0;
      let sentBytes = 0;
      let receivedBytes = 0;
      const opcodeDistribution = {};
      const sizeCategories = {
        small: 0,   // < 100 B
        medium: 0,  // 100 B - 1 KB
        large: 0    // > 1 KB
      };

      // 用于检测心跳或周期消息的时间间隔统计
      const sentTimestamps = [];

      frames.forEach(function (f) {
        const byteLen = f.payloadData ? f.payloadData.length : 0;
        totalBytes += byteLen;

        const opKey = f.opcode === 1 ? '1 (text)' : (f.opcode === 2 ? '2 (binary)' : String(f.opcode));
        opcodeDistribution[opKey] = (opcodeDistribution[opKey] || 0) + 1;

        if (f.direction === 'sent') {
          sentCount++;
          sentBytes += byteLen;
          sentTimestamps.push(f.timestamp);
        } else {
          receivedCount++;
          receivedBytes += byteLen;
        }

        if (byteLen < 100) sizeCategories.small++;
        else if (byteLen <= 1024) sizeCategories.medium++;
        else sizeCategories.large++;
      });

      // 计算发送帧平均间隔（秒）判断心跳
      let estimatedHeartbeatIntervalSeconds = null;
      if (sentTimestamps.length >= 3) {
        const diffs = [];
        for (let i = 1; i < sentTimestamps.length; i++) {
          diffs.push(Math.round((sentTimestamps[i] - sentTimestamps[i - 1]) / 1000));
        }
        // 若标准差较小，取均值
        const avg = diffs.reduce(function (a, b) { return a + b; }, 0) / diffs.length;
        if (avg >= 1) {
          estimatedHeartbeatIntervalSeconds = Math.round(avg * 10) / 10;
        }
      }

      return {
        success: true,
        tabId: tabId,
        wsid: conn.wsid,
        url: conn.url,
        totalFrames: frames.length,
        sentCount: sentCount,
        receivedCount: receivedCount,
        totalBytes: totalBytes,
        sentBytes: sentBytes,
        receivedBytes: receivedBytes,
        opcodeDistribution: opcodeDistribution,
        sizeCategories: sizeCategories,
        estimatedHeartbeatIntervalSeconds: estimatedHeartbeatIntervalSeconds
      };
    }

    // ─── HTTP 重放与 cURL 导出 ──────────────────────────────

    async function replayNetworkRequest(tabId, params) {
      params = params || {};
      const reqid = params.reqid !== undefined ? params.reqid : params.requestId;
      if (reqid === undefined && !params.url) {
        throw new Error('Either reqid or url is required for replayNetworkRequest');
      }

      let originalRequest = null;
      if (reqid !== undefined) {
        const getRes = await getNetworkRequest(tabId, reqid);
        originalRequest = getRes.request;
      }

      const method = (params.method || (originalRequest ? originalRequest.method : 'GET')).toUpperCase();
      const targetUrl = params.url || (originalRequest ? originalRequest.url : '');
      if (!targetUrl) throw new Error('Target url cannot be empty');

      let headers;
      if (params.replaceHeaders === true) {
        headers = Object.assign({}, params.headers || {});
      } else {
        headers = mergeHeaders(originalRequest ? originalRequest.requestHeaders : {}, params.headers);
      }
      headers = stripManagedHeaders(headers);

      const body = params.body !== undefined
        ? (params.body === null ? undefined : params.body)
        : (originalRequest ? originalRequest.postData : undefined);

      if (!customFetch) {
        throw new Error('Fetch API is not available in the current environment');
      }

      const fetchOptions = {
        method: method,
        headers: headers
      };
      if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
        fetchOptions.body = body;
      }

      const start = Date.now();
      let status = 0;
      let statusText = '';
      let resHeaders = {};
      let resBody = '';
      let bodyTruncated = false;

      try {
        const response = await customFetch(targetUrl, fetchOptions);
        const duration = Date.now() - start;
        status = response.status;
        statusText = response.statusText || '';

        if (response.headers && typeof response.headers.forEach === 'function') {
          response.headers.forEach(function (val, key) {
            resHeaders[key] = val;
          });
        }

        resBody = await response.text();
        const maxBodyLength = params.maxBodyLength || 2000;
        if (resBody && resBody.length > maxBodyLength) {
          resBody = resBody.substring(0, maxBodyLength);
          bodyTruncated = true;
        }

        return {
          success: true,
          tabId: tabId,
          originalReqid: reqid,
          replayedUrl: targetUrl,
          status: status,
          statusText: statusText,
          headers: resHeaders,
          body: resBody,
          bodyTruncated: bodyTruncated,
          timingMs: duration,
          override: {
            method: params.method,
            url: params.url,
            headers: params.headers,
            body: params.body,
            replaceHeaders: params.replaceHeaders
          }
        };
      } catch (err) {
        const duration = Date.now() - start;
        return {
          success: false,
          tabId: tabId,
          originalReqid: reqid,
          replayedUrl: targetUrl,
          error: (err && err.message) || String(err),
          timingMs: duration
        };
      }
    }

    async function exportRequestAsCurl(tabId, params) {
      params = params || {};
      const reqid = params.reqid !== undefined ? params.reqid : params.requestId;
      if (reqid === undefined && !params.url) {
        throw new Error('Either reqid or url is required for exportRequestAsCurl');
      }

      let originalRequest = null;
      if (reqid !== undefined) {
        const getRes = await getNetworkRequest(tabId, reqid);
        originalRequest = getRes.request;
      }

      const method = (params.method || (originalRequest ? originalRequest.method : 'GET')).toUpperCase();
      const targetUrl = params.url || (originalRequest ? originalRequest.url : '');
      if (!targetUrl) throw new Error('Target url cannot be empty');

      let headers;
      if (params.replaceHeaders === true) {
        headers = Object.assign({}, params.headers || {});
      } else {
        headers = mergeHeaders(originalRequest ? originalRequest.requestHeaders : {}, params.headers);
      }
      headers = stripManagedHeaders(headers);

      const body = params.body !== undefined
        ? (params.body === null ? undefined : params.body)
        : (originalRequest ? originalRequest.postData : undefined);

      const curlStr = formatCurl({
        method: method,
        url: targetUrl,
        headers: headers,
        body: body
      });

      return {
        success: true,
        tabId: tabId,
        originalReqid: reqid,
        curl: curlStr
      };
    }

    async function replayNetworkRequestBatch(tabId, params) {
      params = params || {};
      const reqid = params.reqid !== undefined ? params.reqid : params.requestId;
      const variants = params.variants;
      if (!Array.isArray(variants) || variants.length === 0) {
        throw new Error('variants must be a non-empty array of ReplayOverride objects');
      }

      const concurrency = (typeof params.concurrency === 'number' && params.concurrency > 0)
        ? params.concurrency
        : 3;

      const results = [];
      const statusCodeDistribution = {};
      let succeeded = 0;
      let failed = 0;

      // 受控并发执行
      let cursor = 0;
      async function worker() {
        while (cursor < variants.length) {
          const index = cursor++;
          const override = variants[index] || {};
          const singleParams = Object.assign({ reqid: reqid }, override);
          if (params.maxBodyLength) singleParams.maxBodyLength = params.maxBodyLength;

          const res = await replayNetworkRequest(tabId, singleParams);
          if (res.success && res.status >= 200 && res.status < 400) {
            succeeded++;
          } else {
            failed++;
          }
          if (res.status) {
            statusCodeDistribution[res.status] = (statusCodeDistribution[res.status] || 0) + 1;
          }

          results.push({
            index: index,
            override: override,
            result: res
          });
        }
      }

      const workers = [];
      for (let i = 0; i < Math.min(concurrency, variants.length); i++) {
        workers.push(worker());
      }
      await Promise.all(workers);

      // 按 index 稳定排序
      results.sort(function (a, b) { return a.index - b.index; });

      return {
        success: true,
        tabId: tabId,
        total: variants.length,
        succeeded: succeeded,
        failed: failed,
        statusCodeDistribution: statusCodeDistribution,
        results: results
      };
    }

    return {
      enableForTab: enableForTab,
      handleDebuggerEvent: handleDebuggerEvent,
      listNetworkRequests: listNetworkRequests,
      getNetworkRequest: getNetworkRequest,
      clearNetworkRequests: clearNetworkRequests,
      listWebSocketConnections: listWebSocketConnections,
      getWebSocketMessages: getWebSocketMessages,
      getWebSocketMessage: getWebSocketMessage,
      analyzeWebSocketMessages: analyzeWebSocketMessages,
      replayNetworkRequest: replayNetworkRequest,
      exportRequestAsCurl: exportRequestAsCurl,
      replayNetworkRequestBatch: replayNetworkRequestBatch
    };
  }

  return {
    createNetworkManager: createNetworkManager,
    STRIPPED_HEADERS: STRIPPED_HEADERS,
    stripManagedHeaders: stripManagedHeaders,
    SIGNATURE_HEADER_PATTERN: SIGNATURE_HEADER_PATTERN,
    formatCurl: formatCurl
  };
});
