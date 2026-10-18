(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.CrawlerAgentSession = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function generateSessionId() {
    return 'sess_' + Math.random().toString(36).substring(2, 10);
  }

  /**
   * 独立 Agent 会话与标签借还管理器
   * @param {object} chromeApi
   */
  function createAgentSessionManager(chromeApi) {
    if (!chromeApi || !chromeApi.windows || !chromeApi.tabs) {
      throw new Error('chrome.windows and chrome.tabs are required');
    }

    function callApi(method, args) {
      return new Promise(function (resolve, reject) {
        try {
          let called = false;
          const cb = function (res) {
            if (called) return;
            called = true;
            const err = chromeApi.runtime && chromeApi.runtime.lastError;
            if (err) reject(new Error(err.message || 'API call failed'));
            else resolve(res);
          };
          const ret = method.apply(null, (args || []).concat(cb));
          if (ret && typeof ret.then === 'function') {
            ret.then(function (r) {
              if (!called) { called = true; resolve(r); }
            }, function (e) {
              if (!called) { called = true; reject(e); }
            });
          }
        } catch (err) {
          reject(err);
        }
      });
    }

    // sessionId -> SessionContext
    const sessions = new Map();
    // tabId -> { tabId, originalWindowId, originalIndex, sessionId, title, url }
    const borrowedTabs = new Map();
    // agentWindowId -> sessionId
    const windowIndex = new Map();

    /**
     * 启动一个独立的 Agent Window 会话
     * @param {object} [options]
     * @param {number} [options.width=1280]
     * @param {number} [options.height=800]
     * @param {boolean} [options.focused=true]
     * @returns {Promise<{ sessionId: string, windowId: number }>}
     */
    async function sessionStart(options) {
      options = options || {};
      const width = options.width || 1280;
      const height = options.height || 800;
      const focused = options.focused !== false;

      const win = await callApi(chromeApi.windows.create, [{
        focused: focused,
        width: width,
        height: height,
        url: 'about:blank'
      }]);

      const sessionId = generateSessionId();
      const ctx = {
        sessionId: sessionId,
        agentWindowId: win.id,
        createdAtMs: Date.now(),
        createdTabs: new Set(),
        borrowedTabIds: new Set()
      };

      sessions.set(sessionId, ctx);
      windowIndex.set(win.id, sessionId);

      return {
        sessionId: sessionId,
        windowId: win.id
      };
    }

    /**
     * 借用用户窗口中的标签页并移入 Agent Window
     * @param {number} tabId
     * @param {string} sessionId
     * @returns {Promise<{ tabId: number, originalWindowId: number, originalIndex: number, title: string }>}
     */
    async function borrowTab(tabId, sessionId) {
      if (!Number.isInteger(tabId) || tabId <= 0) {
        throw new Error('tabId must be a positive integer');
      }
      let ctx = null;
      if (sessionId) {
        ctx = sessions.get(sessionId);
        if (!ctx) throw new Error('Session not found: ' + sessionId);
      } else {
        // 若未指定 sessionId，取最近一个活跃 session
        const allSessions = Array.from(sessions.values());
        if (allSessions.length === 0) throw new Error('No active agent session');
        ctx = allSessions[allSessions.length - 1];
      }

      if (borrowedTabs.has(tabId)) {
        throw new Error('Tab is already borrowed: ' + tabId);
      }

      const tab = await callApi(chromeApi.tabs.get, [tabId]);
      if (tab.windowId === ctx.agentWindowId) {
        throw new Error('Tab is already in Agent Window');
      }

      const borrowedInfo = {
        tabId: tabId,
        originalWindowId: tab.windowId,
        originalIndex: tab.index,
        sessionId: ctx.sessionId,
        title: tab.title || '',
        url: tab.url || ''
      };

      // 移入 Agent Window 末尾
      await callApi(chromeApi.tabs.move, [tabId, {
        windowId: ctx.agentWindowId,
        index: -1
      }]);

      borrowedTabs.set(tabId, borrowedInfo);
      ctx.borrowedTabIds.add(tabId);

      return {
        tabId: tabId,
        originalWindowId: borrowedInfo.originalWindowId,
        originalIndex: borrowedInfo.originalIndex,
        title: borrowedInfo.title
      };
    }

    /**
     * 将借用的标签页精准送回原窗口原索引
     * @param {number} tabId
     * @returns {Promise<{ tabId: number, restoredWindowId: number, restoredIndex: number }>}
     */
    async function returnTab(tabId) {
      if (!Number.isInteger(tabId) || tabId <= 0) {
        throw new Error('tabId must be a positive integer');
      }
      const info = borrowedTabs.get(tabId);
      if (!info) {
        throw new Error('Tab is not borrowed: ' + tabId);
      }

      const ctx = sessions.get(info.sessionId);

      // 检查原窗口是否仍然存活
      let targetWindowId = info.originalWindowId;
      try {
        await callApi(chromeApi.windows.get, [info.originalWindowId]);
      } catch (_) {
        // 原窗口已被关闭，寻找一个备用存活窗口
        const allWindows = (await callApi(chromeApi.windows.getAll, [])) || [];
        const nonAgentWindows = allWindows.filter(function (w) {
          return !windowIndex.has(w.id);
        });
        if (nonAgentWindows.length > 0) {
          targetWindowId = nonAgentWindows[0].id;
        } else if (allWindows.length > 0) {
          targetWindowId = allWindows[0].id;
        }
      }

      await callApi(chromeApi.tabs.move, [tabId, {
        windowId: targetWindowId,
        index: info.originalIndex
      }]);

      borrowedTabs.delete(tabId);
      if (ctx) {
        ctx.borrowedTabIds.delete(tabId);
      }

      return {
        tabId: tabId,
        restoredWindowId: targetWindowId,
        restoredIndex: info.originalIndex
      };
    }

    /**
     * 停止会话：自动归还全部借用标签页，销毁 Agent Window
     * @param {string} sessionId
     * @returns {Promise<{ success: boolean, returnedTabs: number[] }>}
     */
    async function sessionStop(sessionId) {
      const ctx = sessions.get(sessionId);
      if (!ctx) {
        return { success: false, returnedTabs: [] };
      }

      const returnedTabs = [];
      const tabIds = Array.from(ctx.borrowedTabIds);

      for (let i = 0; i < tabIds.length; i++) {
        const tid = tabIds[i];
        try {
          await returnTab(tid);
          returnedTabs.push(tid);
        } catch (_) {}
      }

      // 关闭 Agent Window
      try {
        await callApi(chromeApi.windows.remove, [ctx.agentWindowId]);
      } catch (_) {}

      windowIndex.delete(ctx.agentWindowId);
      sessions.delete(sessionId);

      return {
        success: true,
        returnedTabs: returnedTabs
      };
    }

    function hasSession(sessionId) {
      return sessions.has(sessionId);
    }

    function getSession(sessionId) {
      return sessions.get(sessionId) || null;
    }

    function isTabBorrowed(tabId) {
      return borrowedTabs.has(tabId);
    }

    return {
      sessionStart: sessionStart,
      sessionStop: sessionStop,
      borrowTab: borrowTab,
      returnTab: returnTab,
      hasSession: hasSession,
      getSession: getSession,
      isTabBorrowed: isTabBorrowed
    };
  }

  return {
    createAgentSessionManager: createAgentSessionManager
  };
});
