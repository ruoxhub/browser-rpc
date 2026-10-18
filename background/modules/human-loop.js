(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.CrawlerHumanLoop = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createHumanLoopManager(chromeApi) {
    if (!chromeApi || !chromeApi.windows || !chromeApi.notifications) {
      throw new Error('chrome.windows and chrome.notifications are required');
    }

    /**
     * 发起人机协同交互求助，挂起会话并等待人工完成或超时
     * @param {number} tabId
     * @param {object} options
     * @param {string} options.prompt 提示说明文本
     * @param {string} [options.title] 弹窗标题
     * @param {number} [options.timeoutMs=180000] 超时时间（默认 3 分钟）
     * @param {number} [options.checkIntervalMs=500] 巡检探测周期
     * @param {object} [options.completionCriteria] 自愈完成条件
     * @param {string} [options.completionCriteria.urlRegex]
     * @param {string} [options.completionCriteria.selectorExists]
     * @param {string} [options.completionCriteria.selectorGone]
     * @returns {Promise<{ status: string, reason: string, durationMs: number }>}
     */
    async function requestHelp(tabId, options) {
      options = options || {};
      const prompt = options.prompt || '自动化任务需要您协助操作，请在页面中处理。';
      const title = options.title || 'Browser-RPC 人工协助请求';
      const timeoutMs = options.timeoutMs || 180000;
      const checkIntervalMs = options.checkIntervalMs || 500;
      const criteria = options.completionCriteria || {};
      const startTime = Date.now();

      // 1. 激活标签所在窗口并聚焦
      let windowId = null;
      try {
        const tab = await chromeApi.tabs.get(tabId);
        windowId = tab.windowId;
        await chromeApi.windows.update(windowId, { focused: true });
      } catch (_) {}

      // 2. 发起系统桌面原生通知
      const notifId = 'bh_help_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
      try {
        await chromeApi.notifications.create(notifId, {
          type: 'basic',
          iconUrl: 'static/icon/icon48.png',
          title: title,
          message: prompt,
          priority: 2
        });
      } catch (_) {}

      // 3. 注入页面引导浮层
      const injectBannerCode = function (msg, selfTimeoutMs) {
        if (document.getElementById('browser-rpc-help-overlay')) return;
        const banner = document.createElement('div');
        banner.id = 'browser-rpc-help-overlay';
        banner.style.position = 'fixed';
        banner.style.top = '16px';
        banner.style.right = '16px';
        banner.style.zIndex = '2147483647';
        banner.style.backgroundColor = 'rgba(15, 23, 42, 0.95)';
        banner.style.color = '#ffffff';
        banner.style.padding = '14px 20px';
        banner.style.borderRadius = '10px';
        banner.style.boxShadow = '0 8px 30px rgba(0,0,0,0.3)';
        banner.style.fontFamily = 'system-ui, -apple-system, sans-serif';
        banner.style.fontSize = '14px';
        banner.style.maxWidth = '360px';
        banner.style.border = '2px solid #3b82f6';

        const text = document.createElement('div');
        text.innerText = msg;
        text.style.marginBottom = '10px';
        text.style.lineHeight = '1.4';
        banner.appendChild(text);

        const btn = document.createElement('button');
        btn.innerText = '我已处理完成';
        btn.style.backgroundColor = '#3b82f6';
        btn.style.color = '#ffffff';
        btn.style.border = 'none';
        btn.style.borderRadius = '6px';
        btn.style.padding = '6px 14px';
        btn.style.cursor = 'pointer';
        btn.style.fontWeight = 'bold';
        btn.onclick = function () {
          window.__browser_rpc_help_finished = true;
          banner.remove();
        };
        banner.appendChild(btn);

        // 自愈清理：浮层是 z-index 2147483647 的全屏遮罩级元素，
        // 一旦后台 service worker 在本轮等待中被休眠/终止，finally 清理就不会执行，
        // 用户会永久看到一个挡住整页的浮层（且没有任何按钮以外的方式关掉它）。
        // 这里在页面内挂一个兜底定时器，到点自行移除。
        const ttlMs = typeof selfTimeoutMs === 'number' && selfTimeoutMs > 0 ? selfTimeoutMs : 180000;
        setTimeout(function () {
          var el = document.getElementById('browser-rpc-help-overlay');
          if (el && !window.__browser_rpc_help_finished) el.remove();
        }, ttlMs + 30000);

        document.body.appendChild(banner);
      };

      if (chromeApi.scripting && typeof chromeApi.scripting.executeScript === 'function') {
        try {
          await chromeApi.scripting.executeScript({
            target: { tabId: tabId },
            func: injectBannerCode,
            args: [prompt, timeoutMs]
          });
        } catch (_) {}
      }

      // 4. 探测循环
      let status = 'timeout';
      let reason = 'timeout';

      const criteriaScript = '/* criteriaCheck */ (function() {' +
        'if (window.__browser_rpc_help_finished) return true;' +
        'var criteria = ' + JSON.stringify(criteria) + ';' +
        'if (criteria.urlRegex) {' +
        '  try { if (new RegExp(criteria.urlRegex).test(window.location.href)) return true; } catch(_) {}' +
        '}' +
        'if (criteria.selectorExists) {' +
        '  try { if (document.querySelector(criteria.selectorExists)) return true; } catch(_) {}' +
        '}' +
        'if (criteria.selectorGone) {' +
        '  try { if (!document.querySelector(criteria.selectorGone)) return true; } catch(_) {}' +
        '}' +
        'return false;' +
        '})()';

      try {
        while (Date.now() - startTime < timeoutMs) {
          if (chromeApi.debugger && typeof chromeApi.debugger.sendCommand === 'function') {
            try {
              let res;
              const sendCmd = chromeApi.debugger.sendCommand;
              res = await new Promise(function (resolve, reject) {
                try {
                  let settled = false;
                  const cb = function (r) { if (!settled) { settled = true; resolve(r); } };
                  const ret = sendCmd.call(chromeApi.debugger, { tabId: tabId }, 'Runtime.evaluate', {
                    expression: criteriaScript,
                    returnByValue: true
                  }, cb);
                  if (ret && typeof ret.then === 'function') {
                    ret.then(function (r) { if (!settled) { settled = true; resolve(r); } }, function (e) { if (!settled) { settled = true; reject(e); } });
                  }
                } catch (err) {
                  reject(err);
                }
              });

              if (res && res.result && res.result.value === true) {
                status = 'completed';
                reason = 'criteria_met';
                break;
              }
            } catch (_) {}
          }

          await new Promise(function (resolve) {
            setTimeout(resolve, checkIntervalMs);
          });
        }
      } finally {
        // 5. 资源清理
        try {
          await chromeApi.notifications.clear(notifId);
        } catch (_) {}

        if (chromeApi.scripting && typeof chromeApi.scripting.executeScript === 'function') {
          try {
            await chromeApi.scripting.executeScript({
              target: { tabId: tabId },
              func: function () {
                const b = document.getElementById('browser-rpc-help-overlay');
                if (b) b.remove();
                delete window.__browser_rpc_help_finished;
              }
            });
          } catch (_) {}
        }
      }

      return {
        status: status,
        reason: reason,
        durationMs: Date.now() - startTime
      };
    }

    return {
      requestHelp: requestHelp
    };
  }

  return {
    createHumanLoopManager: createHumanLoopManager
  };
});
