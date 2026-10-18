/**
 * Universal Anti-Detect & Anti-Debug Module - 通用反检测与反调试防护模块
 *
 * 融合模块能力：
 *   1. 通用反爬/指纹探测拦截 (WebSocket 本地端口扫描、扩展协议探测、Canvas/WebGL 指纹伪装、Navigator 伪装)
 *   2. 自动化特征清除 (navigator.webdriver 抹除、cdc_ 属性清除、window.chrome 运行时环境补全)
 *   3. 阿里系安全风控防护 (Baxia getUA 容错、AWSC.use / getFYToken 降级兜底)
 *   4. 反调试与防篡改防护 (无限 debugger 拦截、定时器探测过滤、可疑跳转/DOM清空/样式模糊拦截、快捷键保护、iframe 穿透防护)
 *
 * 执行环境：MAIN world（建议在 document_start 阶段注入）
 */

(function () {
  'use strict';

  if (typeof window === 'undefined') return;

  // 防止重复注入并同步状态标志
  if (window.__anti_detect_loaded) return;
  window.__anti_detect_loaded = true;
  window.__anti_detect_ali_loaded = true;
  window.__anti_debug_boss_loaded = true;
  window.__crawler_anti_detect_loaded = true;

  var LOG_PREFIX = '[Anti-Detect]';

  // 默认配置
  var DEFAULT_CONFIG = {
    // --- 网络与扩展探测拦截 ---
    wsLocalProbe: true,             // 拦截本地 WebSocket 端口探测 (127.0.0.1, localhost, 0.0.0.0)
    wsProbeWhitelist: ['/business/register'], // WebSocket 探测白名单
    chromeExtension: true,          // 拦截 chrome-extension:// 与 moz-extension:// 探测

    // --- 指纹与硬件保护 ---
    canvas: true,                   // Canvas 指纹轻微加噪保护 & willReadFrequently 优化
    webgl: true,                    // WebGL 渲染器与供应商指纹伪装
    navigator: true,                // Navigator 属性伪装 (plugins, languages)

    // --- 自动化与环境伪装 ---
    automation: true,               // 清除自动化特征 (webdriver, cdc_ 属性等)
    chromeRuntime: true,            // 补全/伪装 window.chrome (app, runtime) 避开 headless 判定

    // --- 阿里系特定防风控防护 ---
    aliSecurity: true,              // 阿里系安全组件 (baxiaCommon.getUA, AWSC.use/getFYToken) 容错与伪装

    // --- 反调试与防篡改 (通用 & BOSS 等) ---
    antiDebug: true,                // 反调试总开关
    blockDebugger: true,            // 拦截 Function 构造函数与 eval 中的 debugger 注入
    blockSuspiciousTimers: true,    // 拦截包含 debugger 或性能探测的可疑定时器
    blockRedirects: true,           // 拦截可疑页面跳转与空白页刷新 (about:blank 等)
    blockDomDestruction: true,      // 阻止反调试脚本清空 body 或注入遮罩样式
    iframeProtection: true,         // 自动向动态创建的 iframe 注入防护
    restoreShortcuts: true,         // 恢复 F12 / Ctrl+Shift+I / Ctrl+U 等被禁用的开发者快捷键
    spoofDevTools: true,            // 抹除 devtools 特征变量与 window outerWidth/Height 探测
    spoofPerformance: false,        // 伪造性能指标 (默认关闭：修改 Date.now 破坏原生 [native code] 特征)

    // --- 调试模式 ---
    debug: false
  };

  var config = {};

  function log(action, detail) {
    if (config.debug) {
      if (detail !== undefined) {
        console.log(LOG_PREFIX, action, detail);
      } else {
        console.log(LOG_PREFIX, action);
      }
    }
  }

  // ==================== 反调试特征特征与调用栈辅助 ====================
  var STACK_FLAG = /onDevToolOpen|XCID|noDebug|(?:^|\W)abFn(?:\W|$)|(?:^|\W)ot(?:\W|$)/i;
  var CALLBACK_FLAG = /new Array\(1e4\)\.fill\(['"]x['"]\)|['"]x['"]\.repeat\(1e4\)|nested_/i;
  var SUSPICIOUS_URL = /^(about:blank|javascript:|data:)/i;

  function getStack(tag) {
    try {
      return new Error(tag || 'stack').stack || '';
    } catch (e) {
      return '';
    }
  }

  function stackMatched(stack) {
    return STACK_FLAG.test(stack);
  }

  function callbackMatched(callback) {
    if (!callback) return false;
    var str = typeof callback === 'function' ? callback.toString() : String(callback);
    return CALLBACK_FLAG.test(str);
  }

  // ==================== 1. WebSocket 本地端口探测拦截 ====================
  function isLocalProbe(url) {
    if (!config.wsLocalProbe) return false;
    if (!url || typeof url !== 'string') return false;
    try {
      var u = new URL(url);
      var host = u.hostname;
      var isLocal = (host === '127.0.0.1' || host === 'localhost' || host === '0.0.0.0');
      if (!isLocal) return false;
      for (var i = 0; i < config.wsProbeWhitelist.length; i++) {
        if (u.pathname.indexOf(config.wsProbeWhitelist[i]) !== -1) return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function setupWebSocketInterceptor() {
    if (!config.wsLocalProbe) return;
    var OriginalWebSocket = window.WebSocket;
    if (typeof window.__OriginalWebSocket__ === 'undefined') {
      window.__OriginalWebSocket__ = OriginalWebSocket;
    }
    if (!OriginalWebSocket) return;

    var FakeWebSocket = function (url, protocols) {
      if (isLocalProbe(url)) {
        log('Blocked local WebSocket probe:', url);
        var fake = {
          readyState: 3, // CLOSED
          bufferedAmount: 0,
          url: url,
          protocol: '',
          extensions: '',
          binaryType: 'blob',
          onopen: null,
          onclose: null,
          onerror: null,
          onmessage: null,
          CONNECTING: 0,
          OPEN: 1,
          CLOSING: 2,
          CLOSED: 3,
          send: function () { throw new DOMException('WebSocket is already in CLOSING or CLOSED state.'); },
          close: function () {},
          addEventListener: function () {},
          removeEventListener: function () {},
          dispatchEvent: function () { return true; }
        };

        setTimeout(function () {
          if (typeof fake.onerror === 'function') {
            try { fake.onerror({ type: 'error' }); } catch (e) {}
          }
        }, 0);

        return fake;
      }

      if (protocols !== undefined) {
        return new OriginalWebSocket(url, protocols);
      }
      return new OriginalWebSocket(url);
    };

    FakeWebSocket.CONNECTING = 0;
    FakeWebSocket.OPEN = 1;
    FakeWebSocket.CLOSING = 2;
    FakeWebSocket.CLOSED = 3;
    FakeWebSocket.prototype = OriginalWebSocket.prototype;

    try {
      Object.defineProperty(window, 'WebSocket', {
        value: FakeWebSocket,
        writable: true,
        configurable: true
      });
    } catch (e) {
      window.WebSocket = FakeWebSocket;
    }
  }

  // ==================== 2. 浏览器扩展探测拦截 ====================
  function setupChromeExtensionInterceptor() {
    if (!config.chromeExtension) return;

    var originalFetch = window.fetch;
    if (originalFetch) {
      window.fetch = function (input, init) {
        var url = '';
        if (typeof input === 'string') {
          url = input;
        } else if (input && typeof input.url === 'string') {
          url = input.url;
        }
        if (url.indexOf('chrome-extension://') === 0 || url.indexOf('moz-extension://') === 0) {
          log('Blocked extension fetch probe:', url);
          return Promise.reject(new TypeError('Failed to fetch'));
        }
        return originalFetch.apply(this, arguments);
      };
    }

    var OriginalXHR = window.XMLHttpRequest;
    if (OriginalXHR) {
      window.XMLHttpRequest = function () {
        var xhr = new OriginalXHR();
        var originalOpen = xhr.open;
        xhr.open = function (method, url, async, user, password) {
          if (typeof url === 'string' && (url.indexOf('chrome-extension://') === 0 || url.indexOf('moz-extension://') === 0)) {
            log('Blocked extension XHR probe:', url);
            throw new DOMException('Network Error');
          }
          return originalOpen.apply(this, arguments);
        };
        return xhr;
      };
      window.XMLHttpRequest.prototype = OriginalXHR.prototype;
    }
  }

  // ==================== 3. Canvas 与 WebGL 指纹保护 ====================
  function setupCanvasProtection() {
    if (!config.canvas) return;
    if (typeof HTMLCanvasElement !== 'undefined' && HTMLCanvasElement.prototype.getContext) {
      var originalGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, attributes) {
        if (type === '2d') {
          attributes = Object.assign({}, attributes, { willReadFrequently: true });
        }
        return originalGetContext.call(this, type, attributes);
      };
    }

    if (typeof CanvasRenderingContext2D !== 'undefined' && CanvasRenderingContext2D.prototype.getImageData) {
      var originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
      CanvasRenderingContext2D.prototype.getImageData = function () {
        var imageData = originalGetImageData.apply(this, arguments);
        var copy = new ImageData(imageData.width, imageData.height);
        for (var i = 0; i < imageData.data.length; i++) {
          copy.data[i] = (imageData.data[i] + 1) % 256;
        }
        return copy;
      };
    }
  }

  function setupWebGLProtection() {
    if (!config.webgl) return;
    var protectedParams = {
      37445: 'Google Inc. (NVIDIA)',
      37446: 'ANGLE (Intel(R) HD Graphics Direct3D11 vs_5_0 ps_5_0)',
      7936: 'WebKit'
    };

    var hookGetParameter = function (original) {
      return function (param) {
        if (protectedParams[param]) {
          return protectedParams[param];
        }
        return original.apply(this, arguments);
      };
    };

    if (typeof WebGLRenderingContext !== 'undefined' && WebGLRenderingContext.prototype.getParameter) {
      WebGLRenderingContext.prototype.getParameter = hookGetParameter(
        WebGLRenderingContext.prototype.getParameter
      );
    }
    if (typeof WebGL2RenderingContext !== 'undefined' && WebGL2RenderingContext.prototype.getParameter) {
      WebGL2RenderingContext.prototype.getParameter = hookGetParameter(
        WebGL2RenderingContext.prototype.getParameter
      );
    }
  }

  // ==================== 4. Navigator 属性伪装 ====================
  function setupNavigatorSpoofing() {
    if (!config.navigator || typeof navigator === 'undefined') return;
    try {
      Object.defineProperty(navigator, 'plugins', {
        get: function () {
          return [
            {
              name: 'Chrome PDF Plugin',
              filename: 'internal-pdf-viewer',
              description: 'Portable Document Format',
              length: 1
            }
          ];
        },
        configurable: true
      });
    } catch (e) {}

    try {
      Object.defineProperty(navigator, 'languages', {
        get: function () {
          return ['en-US', 'en'];
        },
        configurable: true
      });
    } catch (e) {}
  }

  // ==================== 5. 自动化特征清除 ====================
  function setupAutomationRemoval() {
    if (!config.automation) return;
    try {
      if (typeof navigator !== 'undefined') {
        delete navigator.__proto__.webdriver;
        Object.defineProperty(navigator, 'webdriver', {
          get: function () { return undefined; },
          configurable: true
        });
      }
    } catch (e) {}

    var cdcProperties = ['cdc_adoQpoasnfa76pfcZLmcfl_', 'cdc_devToolsAdoption_'];
    cdcProperties.forEach(function (prop) {
      try {
        delete window[prop];
      } catch (e) {}
    });
  }

  // ==================== 6. Chrome 运行时环境补全 ====================
  function setupChromeRuntimeMock() {
    if (!config.chromeRuntime) return;
    if (!window.chrome) {
      window.chrome = {};
    }
    if (!window.chrome.app) {
      window.chrome.app = {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', RUNNING: 'running', CAN_RUN: 'can_run' }
      };
    }
    if (!window.chrome.runtime) {
      window.chrome.runtime = {
        OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update', SHARED_MODULE_UPDATE: 'shared_module_update' },
        OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
        PlatformArch: { ARM: 'arm', ARM64: 'arm64', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
        PlatformNaclArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
        PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
        RequestUpdateCheckStatus: { THROTTLED: 'throttled', NO_UPDATE: 'no_update', UPDATE_AVAILABLE: 'update_available' }
      };
    }
  }

  // ==================== 7. 阿里系安全风控组件防护 ====================
  function setupAliSecurityWatcher() {
    if (!config.aliSecurity) return;
    var _baxiaCommon = window.baxiaCommon;
    var _AWSC = window.AWSC;

    try {
      Object.defineProperty(window, 'baxiaCommon', {
        get: function () { return _baxiaCommon; },
        set: function (val) {
          log('Intercepted baxiaCommon set');
          if (val && typeof val === 'object') {
            if (typeof val.getUA === 'function') {
              var rawGetUA = val.getUA;
              val.getUA = function () {
                try {
                  return rawGetUA.apply(this, arguments);
                } catch (err) {
                  return "231!/+zmPAmUdD/+jwUDJVtKeAho2shMCyj7hSDLY+3v84eWI4RlXRn996QquuV0SsyUA81z1ZxFP7vpLOxYmMbSCZz++hSVda6zN1FR3kjG0Q3oyE+jrhthb4jucVNGHkE+++3+qCS4+ItNk+Qju8eAo+4o7W9EGyJ5YX8QBQ0vBsi9s2jKmjLXV8EC5q+JFxijKd0eJ95IMKxCSH3/3UQ8J";
                }
              };
            }
          }
          _baxiaCommon = val;
        },
        configurable: true
      });
    } catch (e) {}

    try {
      Object.defineProperty(window, 'AWSC', {
        get: function () { return _AWSC; },
        set: function (val) {
          log('Intercepted AWSC set');
          if (val && typeof val === 'object') {
            if (typeof val.use === 'function') {
              var rawUse = val.use;
              val.use = function (name, callback, options) {
                var wrappedCallback = callback;
                if (typeof callback === 'function') {
                  wrappedCallback = function (state, module) {
                    if (state === 'ok' && module && typeof module.getFYToken === 'function') {
                      var rawGetFYToken = module.getFYToken;
                      module.getFYToken = function () {
                        try {
                          return rawGetFYToken.apply(this, arguments);
                        } catch (err) {
                          return "231!HJ+mfkmU68k+jyXBJi4feAho2shMCyj7hSDLY+3v84eWI4RlX4sjCC5tyZF3Y0uVse/QX5IFrnP9erqXOoyFSn15g9kilW04Arce9iD+Fw8e+Zd++R52r2p+L9vKHJBh";
                        }
                      };
                    }
                    return callback(state, module);
                  };
                }
                return rawUse.call(this, name, wrappedCallback, options);
              };
            }
          }
          _AWSC = val;
        },
        configurable: true
      });
    } catch (e) {}
  }

  // ==================== 8. 反调试与防篡改防护 ====================

  function setupFunctionConstructorHook() {
    if (!config.antiDebug || !config.blockDebugger) return;
    try {
      var OriginalFunction = Function;
      if (typeof window._originalFunction === 'undefined') {
        window._originalFunction = OriginalFunction;
      }
      var originalConstructor = Function.prototype.constructor;
      Function.prototype.constructor = function () {
        var args = Array.prototype.slice.call(arguments);
        var code = args[args.length - 1] || '';
        if (typeof code === 'string') {
          var suspicious = /debugger|console\.log\(.*devtools/i.test(code) ||
            /performance\.now\(\)|Date\.now\(\)|new\s+Date\(\)/i.test(code) ||
            /(eval|Function)\s*\(.*debugger/i.test(code);
          if (suspicious) {
            log('Blocked suspicious Function constructor call:', code.substring(0, 100));
            return function () { return undefined; };
          }
        }
        return originalConstructor.apply(this, args);
      };

      if (window.eval) {
        var originalEval = window.eval;
        window.eval = function (code) {
          if (typeof code === 'string' && /debugger/.test(code)) {
            log('Blocked eval with debugger');
            return undefined;
          }
          return originalEval.call(window, code);
        };
      }

      // 干扰通过 Error 栈判定调试器的逻辑
      var originalError = Error;
      window.Error = function () {
        return new (Function.prototype.bind.apply(originalError, [null].concat(Array.prototype.slice.call(arguments))))();
      };
      window.Error.prototype = originalError.prototype;
    } catch (e) {}
  }

  function shouldBlockTimer(callback) {
    if (!config.antiDebug || !config.blockSuspiciousTimers) return false;
    var timerStack = getStack('timer');
    if (stackMatched(timerStack)) return true;
    if (callback && typeof callback === 'function') {
      var str = callback.toString();
      if (/debugger/.test(str)) {
        log('Blocked timer with debugger');
        return true;
      }
      if (/Date\.now|performance\.now|new\s+Date\(\)/.test(str) && stackMatched(timerStack)) {
        log('Blocked timer with performance detection');
        return true;
      }
    }
    return callbackMatched(callback);
  }

  function patchTimers(win) {
    if (!config.antiDebug || !config.blockSuspiciousTimers) return;
    try {
      var originalSetTimeout = win.setTimeout;
      if (originalSetTimeout) {
        win.setTimeout = function (callback, delay) {
          if (shouldBlockTimer(callback)) {
            log('Blocked setTimeout', delay + 'ms');
            return -1;
          }
          return originalSetTimeout.apply(this, arguments);
        };
      }
      var originalSetInterval = win.setInterval;
      if (originalSetInterval) {
        win.setInterval = function (callback, delay) {
          if (shouldBlockTimer(callback)) {
            log('Blocked setInterval', delay + 'ms');
            return -1;
          }
          return originalSetInterval.apply(this, arguments);
        };
      }
    } catch (e) {}
  }

  function patchMethod(obj, methodName, getTarget, options) {
    options = options || {};
    var lock = options.lock || false;
    var tag = options.tag || '';
    if (!obj) return;
    var original = obj[methodName];
    if (!original || typeof original !== 'function') return;

    obj[methodName] = function () {
      var args = Array.prototype.slice.call(arguments);
      var target = getTarget ? getTarget(args) : '';
      var stack = getStack(tag + ' ' + methodName);
      if (lock || stackMatched(stack)) {
        log('Blocked ' + methodName + '()', target);
        return;
      }
      return original.apply(this, args);
    };
    obj[methodName].prototype = original.prototype;
  }

  function patchWindowLocationSetter(win, tag) {
    try {
      if (!win.location) return;
      var proto = Object.getPrototypeOf(win.location);
      var hrefDesc = Object.getOwnPropertyDescriptor(proto, 'href');
      if (!hrefDesc || !hrefDesc.set || !hrefDesc.configurable) return;

      Object.defineProperty(proto, 'href', {
        configurable: true,
        get: hrefDesc.get,
        set: function (url) {
          var stack = getStack(tag + ' location.href setter');
          if (config.blockRedirects && (SUSPICIOUS_URL.test(url) || stackMatched(stack))) {
            log('Blocked location.href =', url);
            return;
          }
          return hrefDesc.set.call(this, url);
        }
      });
    } catch (e) {}
  }

  function patchDocumentLocationSetter(doc, tag) {
    try {
      if (!doc) return;
      var desc = Object.getOwnPropertyDescriptor(Document.prototype, 'location') ||
                 Object.getOwnPropertyDescriptor(doc, 'location');
      if (!desc || !desc.set || !desc.configurable) return;

      Object.defineProperty(doc, 'location', {
        configurable: true,
        get: desc.get,
        set: function (url) {
          var stack = getStack(tag + ' document.location setter');
          if (config.blockRedirects && (SUSPICIOUS_URL.test(url) || stackMatched(stack))) {
            log('Blocked document.location =', url);
            return;
          }
          return desc.set.call(this, url);
        }
      });
    } catch (e) {}
  }

  function patchInnerHTML(win) {
    try {
      var proto = win.Element ? win.Element.prototype : Element.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, 'innerHTML');
      if (!desc || !desc.set || !desc.configurable) return;

      Object.defineProperty(proto, 'innerHTML', {
        configurable: true,
        get: desc.get,
        set: function (value) {
          var stack = getStack('innerHTML setter');
          if (config.blockDomDestruction && win.document && this === win.document.body && stackMatched(stack)) {
            log('Blocked body.innerHTML overwrite');
            return;
          }
          return desc.set.call(this, value);
        }
      });
    } catch (e) {}
  }

  function patchDomInsertion(win) {
    try {
      var nodeProto = win.Node ? win.Node.prototype : Node.prototype;
      var originalAppend = nodeProto.appendChild;
      if (originalAppend) {
        nodeProto.appendChild = function (node) {
          var stack = getStack('appendChild');
          if (config.blockDomDestruction && node && node.tagName === 'STYLE') {
            var css = node.textContent || node.innerText || '';
            var suspicious = /blur\(20px\)|display:\s*none\s*!important|visibility:\s*hidden\s*!important|opacity:\s*0\s*!important/i.test(css);
            if (suspicious && stackMatched(stack)) {
              log('Blocked suspicious STYLE append');
              return node;
            }
          }
          var result = originalAppend.call(this, node);
          if (config.iframeProtection && node && node.tagName === 'IFRAME') {
            patchIframeNode(node, 'appendChild');
          }
          return result;
        };
      }

      var originalInsertBefore = nodeProto.insertBefore;
      if (originalInsertBefore) {
        nodeProto.insertBefore = function (newNode, refNode) {
          var result = originalInsertBefore.call(this, newNode, refNode);
          if (config.iframeProtection && newNode && newNode.tagName === 'IFRAME') {
            patchIframeNode(newNode, 'insertBefore');
          }
          return result;
        };
      }
    } catch (e) {}
  }

  function patchIframeNode(node, reason) {
    if (!node || node.tagName !== 'IFRAME') return;
    var install = function () {
      try {
        if (node.contentWindow) {
          installWindowGuards(node.contentWindow, 'iframe(' + reason + ')');
        }
      } catch (e) {}
    };
    install();
    setTimeout(install, 0);
    setTimeout(install, 100);
  }

  function installWindowGuards(win, tag) {
    if (!config.antiDebug) return;
    tag = tag || 'main';
    try {
      if (config.blockRedirects) {
        if (win.Location && win.Location.prototype) {
          patchMethod(win.Location.prototype, 'assign', function (args) { return args[0]; }, { lock: true, tag: tag });
          patchMethod(win.Location.prototype, 'replace', function (args) { return args[0]; }, { lock: true, tag: tag });
          patchMethod(win.Location.prototype, 'reload', function () { return '[reload]'; }, { lock: true, tag: tag });
        }
        patchWindowLocationSetter(win, tag);
        if (win.document) {
          patchDocumentLocationSetter(win.document, tag);
        }
        patchMethod(win, 'open', function (args) { return args[0]; }, { lock: true, tag: tag });
        patchMethod(win, 'stop', function () { return '[stop]'; }, { lock: true, tag: tag });
        patchMethod(win, 'close', function () { return '[close]'; }, { lock: true, tag: tag });

        if (win.History && win.History.prototype) {
          patchMethod(win.History.prototype, 'back', function () { return '[back]'; }, { tag: tag });
          patchMethod(win.History.prototype, 'forward', function () { return '[forward]'; }, { tag: tag });
          patchMethod(win.History.prototype, 'go', function (args) { return args[0]; }, { tag: tag });
        }
      }

      patchTimers(win);
      patchInnerHTML(win);
      patchDomInsertion(win);
    } catch (e) {}
  }

  function restoreShortcuts() {
    if (!config.antiDebug || !config.restoreShortcuts) return;
    if (typeof document === 'undefined') return;
    document.addEventListener('keydown', function (e) {
      if (e.key === 'F12' || e.keyCode === 123) {
        e.stopPropagation();
        return;
      }
      if (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'J' || e.keyCode === 73 || e.keyCode === 74)) {
        e.stopPropagation();
        return;
      }
      if (e.ctrlKey && (e.key === 'u' || e.key === 's' || e.keyCode === 85 || e.keyCode === 83)) {
        e.stopPropagation();
        return;
      }
      if (e.metaKey && e.altKey && (e.key === 'I' || e.key === 'J' || e.keyCode === 73 || e.keyCode === 74)) {
        e.stopPropagation();
        return;
      }
      if (e.metaKey && (e.key === 'u' || e.key === 's' || e.keyCode === 85 || e.keyCode === 83)) {
        e.stopPropagation();
        return;
      }
    }, true);
  }

  function spoofDevToolsDetection() {
    if (!config.antiDebug || !config.spoofDevTools) return;
    var devToolsFlags = [
      '__REACT_DEVTOOLS_GLOBAL_HOOK__',
      '__VUE_DEVTOOLS_GLOBAL_HOOK__',
      '__REDUX_DEVTOOLS_EXTENSION__',
      'devtools',
      'Firebug',
      '__firebug__'
    ];
    devToolsFlags.forEach(function (flag) {
      try {
        Object.defineProperty(window, flag, {
          configurable: true,
          get: function () { return undefined; }
        });
      } catch (e) {}
    });

    try {
      var descW = Object.getOwnPropertyDescriptor(window, 'outerWidth');
      var descH = Object.getOwnPropertyDescriptor(window, 'outerHeight');
      if (!descW || descW.configurable !== false) {
        Object.defineProperty(window, 'outerWidth', {
          get: function () { return window.innerWidth; },
          configurable: true
        });
      }
      if (!descH || descH.configurable !== false) {
        Object.defineProperty(window, 'outerHeight', {
          get: function () { return window.innerHeight; },
          configurable: true
        });
      }
    } catch (e) {}
  }

  function observeDomChanges() {
    if (!config.antiDebug || typeof MutationObserver === 'undefined') return;
    var observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        mutation.addedNodes.forEach(function (node) {
          if (config.iframeProtection && node.tagName === 'IFRAME') {
            patchIframeNode(node, 'MutationObserver');
          }
          if (config.blockDomDestruction && node.tagName === 'STYLE') {
            var css = node.textContent || '';
            if (/blur\(20px\)|display:\s*none\s*!important/i.test(css)) {
              var stack = getStack('style injection');
              if (stackMatched(stack)) {
                log('Blocked dynamic style injection');
                node.remove();
              }
            }
          }
        });
      });
    });

    var startObserving = function () {
      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
      } else {
        setTimeout(startObserving, 100);
      }
    };
    startObserving();
  }

  var lastNow = Date.now();
  function spoofPerformanceAPIs() {
    if (!config.antiDebug || !config.spoofPerformance) return;
    try {
      var originalDateNow = Date.now;
      var originalPerformanceNow = performance.now;
      Date.now = function () {
        var realNow = originalDateNow.call(Date);
        if (realNow < lastNow) {
          lastNow = lastNow + Math.random() * 10;
        } else {
          lastNow = realNow;
        }
        return lastNow;
      };
      var perfStart = originalPerformanceNow.call(performance);
      performance.now = function () {
        var elapsed = originalPerformanceNow.call(performance) - perfStart;
        return elapsed + Math.random();
      };
    } catch (e) {}
  }

  // ==================== 初始化与导出 ====================
  function init(userConfig) {
    config = {};
    for (var key in DEFAULT_CONFIG) {
      if (DEFAULT_CONFIG.hasOwnProperty(key)) {
        config[key] = DEFAULT_CONFIG[key];
      }
    }
    if (userConfig) {
      for (var userKey in userConfig) {
        if (userConfig.hasOwnProperty(userKey)) {
          config[userKey] = userConfig[userKey];
        }
      }
    }

    log('Initializing with config:', config);

    // 1. 网络与扩展探测拦截
    setupWebSocketInterceptor();
    setupChromeExtensionInterceptor();

    // 2. 指纹与硬件保护
    setupCanvasProtection();
    setupWebGLProtection();
    setupNavigatorSpoofing();

    // 3. 自动化与环境伪装
    setupAutomationRemoval();
    setupChromeRuntimeMock();

    // 4. 阿里系安全组件防护
    setupAliSecurityWatcher();

    // 5. 反调试与防篡改防护
    if (config.antiDebug) {
      if (config.spoofPerformance) {
        spoofPerformanceAPIs();
      }
      setupFunctionConstructorHook();
      installWindowGuards(window, 'main');
      restoreShortcuts();
      spoofDevToolsDetection();
      observeDomChanges();
    }

    log('Anti-detect module initialized successfully');
  }

  // 导出全局命名空间
  window.AntiDetect = {
    init: init,
    version: '3.0.0',
    getConfig: function () {
      return Object.assign({}, config);
    }
  };

  // 默认自动运行（使用默认配置）
  init();

})();
