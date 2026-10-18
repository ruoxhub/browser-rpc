(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.CrawlerBrowserScripting = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function registerScriptingHandlers(handlers, chromeApi, cdpManager, utils) {
    if (!chromeApi) throw new Error('chromeApi is required');
    utils = utils || (typeof globalThis !== 'undefined' && globalThis.CrawlerBrowserUtils) || (typeof require === 'function' && require('./utils.js'));
    const callChrome = utils.callChrome;
    const paramsObject = utils.paramsObject;
    const positiveTabId = utils.positiveTabId;

    const tabs = chromeApi.tabs;
    const ensureDebuggerAttached = cdpManager ? cdpManager.ensureDebuggerAttached : function () { return Promise.reject(new Error('cdpManager not available')); };
    const callDebuggerCommand = cdpManager ? cdpManager.callDebuggerCommand : function () { return Promise.reject(new Error('cdpManager not available')); };

    handlers.set('executeScript', function (params) {
      params = paramsObject(params);
      if (typeof params.code !== 'string' || !params.code.trim()) throw new Error('code is required');
      if (params.tabId !== undefined) positiveTabId(params.tabId);

      let code = params.code.trim();
      // 容错：若包含顶层 return 且未被函数包装，自动包装为 IIFE
      if (/\breturn(\s+|;|$|{)/.test(code) && !/^\s*\((?:function|async\s+function|\(\s*\)\s*=>)/.test(code)) {
        if (/\bawait\b/.test(code)) {
          code = '(async () => {\n' + code + '\n})()';
        } else {
          code = '(() => {\n' + code + '\n})()';
        }
      }

      // 求值结果可能是 DOM 节点 / 函数 / 循环对象，CDP 在无法按值序列化时
      // 只回 description（如 "h1#title"），没有 value 字段。
      function pickRemoteValue(remote) {
        if (!remote) return null;
        if (Object.prototype.hasOwnProperty.call(remote, 'value')) return remote.value;
        if (remote.unserializableValue !== undefined) return remote.unserializableValue;
        if (remote.type === 'undefined') return null;
        return remote.description !== undefined ? remote.description : null;
      }

      function scriptErrorFromCdp(res) {
        const details = (res && res.exceptionDetails) || {};
        const ex = details.exception || {};
        const text = ex.description || ex.value || details.text || 'Script execution error';
        return new Error('Script execution error: ' + text);
      }

      // 默认 returnByValue: true。
      // 原因：若靠「序列化失败再重试引用模式」来降级，重试会第二次求值，
      // 使带副作用的表达式（如 el.click()、counter()）被重复执行；
      // 而已有行为（旧实现用 eval）对不可序列化的结果本来就是报错。
      // 而且协议的序列化失败会报为不带细节的 "Browser debugger.sendCommand failed"，
      // 无法与真正的传输故障区分，因此不做猜测式重试。
      function evalViaCdp(targetId) {
        // 只有 attach 阶段失败才算「求值尚未发生」，这时回退 scripting 是安全的
        const attached = ensureDebuggerAttached(targetId).catch(function (err) {
          const wrapped = err instanceof Error ? err : new Error(String(err));
          wrapped.allowScriptingFallback = true;
          throw wrapped;
        });

        return attached.then(function () {
          return callDebuggerCommand(targetId, 'Runtime.evaluate', {
            expression: code,
            returnByValue: true,
            awaitPromise: true,
            // 页面 CSP（script-src 'strict-dynamic' 等）会拦截页面内的 eval；
            // CDP 求值由调试器执行，该开关使其不受页面 CSP 约束。
            allowUnsafeEvalBlockedByCSP: true
          });
        }).then(function (res) {
          if (res && res.exceptionDetails) {
            const text = String((res.exceptionDetails && res.exceptionDetails.text) || '');
            // 少部分版本以 exceptionDetails 形式报序列化失败；此时脚本已完成求值，
            // 再以引用模式重试会重复副作用，所以只给出可操作的错误信息。
            if (/by value|serializ|reference chain/i.test(text)) {
              throw new Error(
                'Script execution error: 返回值无法按值序列化（' + text +
                '）；请改为返回 JSON 字符串或基本类型'
              );
            }
            const err = scriptErrorFromCdp(res);
            err.isScriptError = true;
            throw err;
          }
          return { tabId: targetId, result: pickRemoteValue(res && res.result) };
        }, function (err) {
          // 求值阶段失败有两种原因，必须区分：
          //   a) 返回值不可按值序列化 —— 用户脚本已经执行过
          //   b) 调试器通道不可用（DevTools 已占用等）—— 用户脚本根本没跑
          // 用一个无副作用的常量探针判定：探针成功说明通道是好的，则绝不回退，
          // 避免带副作用的脚本被第二次执行；探针也失败才回退，此时才是安全的。
          const detail = err && err.message ? err.message : String(err);
          return callDebuggerCommand(targetId, 'Runtime.evaluate', {
            expression: '1',
            returnByValue: true
          }).then(function () {
            throw new Error(
              'Script execution error: ' + detail +
              '（返回值可能无法按值序列化，请改为返回 JSON 字符串或基本类型）'
            );
          }, function () {
            const dead = new Error(
              'Script execution error: 调试器通道不可用（' + detail +
              '）；已回退到扩展注入求值'
            );
            dead.allowScriptingFallback = true;
            throw dead;
          });
        });
      }

      // 回退路径：内容脚本注入的 (0,eval) 会被严格 CSP 站点（Bing/百度等）拦截
      function evalViaScripting(targetId) {
        if (!chromeApi.scripting || typeof chromeApi.scripting.executeScript !== 'function') {
          throw new Error('chrome.scripting API is not available');
        }
        return callChrome(
          chromeApi,
          chromeApi.scripting.executeScript,
          [{
            target: { tabId: targetId },
            world: 'MAIN',
            func: function (codeStr) {
              try {
                return { success: true, value: (0, eval)(codeStr) };
              } catch (err) {
                return { success: false, error: err && err.message ? err.message : String(err) };
              }
            },
            args: [code]
          }],
          'Browser scripting.executeScript failed'
        ).then(function (injectionResults) {
          if (!injectionResults || !injectionResults[0]) return { tabId: targetId, result: null };
          const execRes = injectionResults[0].result;
          if (execRes && execRes.success === false) {
            throw new Error('Script execution error: ' + execRes.error);
          }
          return { tabId: targetId, result: execRes ? execRes.value : null };
        });
      }

      const executeOnTab = function (targetId) {
        // 优先走 CDP：页面内 eval 会被 CSP 拦截，而 CDP Runtime.evaluate 不受其约束
        const hasDebugger = chromeApi.debugger && typeof chromeApi.debugger.sendCommand === 'function';
        if (hasDebugger) {
          return evalViaCdp(targetId).catch(function (err) {
            const canFallback = err && err.allowScriptingFallback &&
              chromeApi.scripting && typeof chromeApi.scripting.executeScript === 'function';
            if (canFallback) return evalViaScripting(targetId);
            throw err;
          });
        }
        return Promise.resolve().then(function () { return evalViaScripting(targetId); });
      };

      if (params.tabId !== undefined) return executeOnTab(params.tabId);
      return callChrome(chromeApi, tabs.query, [{ active: true, currentWindow: true }], 'Browser tabs.query failed').then(function (result) {
        if (!result || !result[0]) throw new Error('No active tab found');
        return executeOnTab(result[0].id);
      });
    });
  }

  return {
    registerScriptingHandlers: registerScriptingHandlers
  };
});
