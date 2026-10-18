(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.CrawlerBrowserActions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const utils = (root && root.CrawlerBrowserUtils) || (typeof require === 'function' && require('./browser/utils.js'));
  const cdpMod = (root && root.CrawlerBrowserCdp) || (typeof require === 'function' && require('./browser/cdp.js'));
  const tabsMod = (root && root.CrawlerBrowserTabs) || (typeof require === 'function' && require('./browser/tabs.js'));
  const cookiesMod = (root && root.CrawlerBrowserCookies) || (typeof require === 'function' && require('./browser/cookies.js'));
  const scriptingMod = (root && root.CrawlerBrowserScripting) || (typeof require === 'function' && require('./browser/scripting.js'));
  const interactionMod = (root && root.CrawlerBrowserInteraction) || (typeof require === 'function' && require('./browser/interaction.js'));
  const devtoolsMod = (root && root.CrawlerBrowserDevTools) || (typeof require === 'function' && require('./browser/devtools.js'));
  const debuggerMod = (root && root.CrawlerBrowserDebugger) || (typeof require === 'function' && require('./browser/debugger.js'));
  const networkMod = (root && root.CrawlerBrowserNetwork) || (typeof require === 'function' && require('./browser/network.js'));
  const agentMod = (root && root.CrawlerBrowserAgent) || (typeof require === 'function' && require('./browser/agent.js'));
  const domMod = (root && root.CrawlerBrowserDom) || (typeof require === 'function' && require('./browser/dom.js'));

  const inputReadinessMod = (root && root.CrawlerInputReadiness) || (typeof require === 'function' && require('./modules/input-readiness.js'));
  const agentSessionMod = (root && root.CrawlerAgentSession) || (typeof require === 'function' && require('./modules/agent-session.js'));
  const vomEngineMod = (root && root.CrawlerVomEngine) || (typeof require === 'function' && require('./modules/vom-engine.js'));
  const longScreenshotMod = (root && root.CrawlerLongScreenshot) || (typeof require === 'function' && require('./modules/long-screenshot.js'));
  const humanLoopMod = (root && root.CrawlerHumanLoop) || (typeof require === 'function' && require('./modules/human-loop.js'));
  const fileTransferMod = (root && root.CrawlerFileTransfer) || (typeof require === 'function' && require('./modules/file-transfer.js'));
  const devtoolsCollectorMod = (root && root.CrawlerDevToolsCollector) || (typeof require === 'function' && require('./modules/devtools-collector.js'));
  const debuggerManagerMod = (root && root.CrawlerDebuggerManager) || (typeof require === 'function' && require('./modules/debugger-manager.js'));
  const networkModuleMod = (root && root.CrawlerNetworkModule) || (typeof require === 'function' && require('./modules/network-module.js'));

  const BROWSER_ACTION_NAMES = utils.BROWSER_ACTION_NAMES;
  const getSiteCookiesForSender = utils.getSiteCookiesForSender;

  function createBrowserActionRegistry(chromeApi) {
    if (!chromeApi || !chromeApi.tabs || !chromeApi.cookies) throw new Error('chromeApi is required');

    const cdpManager = cdpMod.createCdpManager(chromeApi, utils);
    const handlers = new Map();

    // 注册基础浏览器与系统动作
    tabsMod.registerTabHandlers(handlers, chromeApi, cdpManager, utils);
    cookiesMod.registerCookieHandlers(handlers, chromeApi, utils);
    scriptingMod.registerScriptingHandlers(handlers, chromeApi, cdpManager, utils);
    cdpManager.registerHandlers(handlers);
    interactionMod.registerInteractionHandlers(handlers, chromeApi, cdpManager, utils);

    const cdpClient = cdpManager.cdpClient;

    const sessionManager = agentSessionMod && typeof agentSessionMod.createAgentSessionManager === 'function' && chromeApi && chromeApi.windows && chromeApi.tabs
      ? agentSessionMod.createAgentSessionManager(chromeApi)
      : null;
    const vomEngine = vomEngineMod && typeof vomEngineMod.createVomEngine === 'function'
      ? vomEngineMod.createVomEngine(cdpClient, inputReadinessMod)
      : null;
    const longScreenshotEngine = longScreenshotMod && typeof longScreenshotMod.createLongScreenshotEngine === 'function'
      ? longScreenshotMod.createLongScreenshotEngine(cdpClient)
      : null;
    const humanLoopManager = humanLoopMod && typeof humanLoopMod.createHumanLoopManager === 'function' && chromeApi && chromeApi.windows && chromeApi.notifications
      ? humanLoopMod.createHumanLoopManager(chromeApi, cdpClient)
      : null;
    const fileInputTransfer = fileTransferMod && typeof fileTransferMod.createFileInputTransfer === 'function'
      ? fileTransferMod.createFileInputTransfer(cdpClient)
      : null;
    const dropFileTransfer = fileTransferMod && typeof fileTransferMod.createDropFileTransfer === 'function'
      ? fileTransferMod.createDropFileTransfer(cdpClient)
      : null;
    const devToolsCollector = devtoolsCollectorMod && typeof devtoolsCollectorMod.createDevToolsCollector === 'function'
      ? devtoolsCollectorMod.createDevToolsCollector(chromeApi, cdpClient)
      : null;
    const debuggerManager = debuggerManagerMod && typeof debuggerManagerMod.createDebuggerManager === 'function'
      ? debuggerManagerMod.createDebuggerManager(chromeApi, cdpClient, devToolsCollector)
      : null;
    const networkManager = networkModuleMod && typeof networkModuleMod.createNetworkManager === 'function'
      ? networkModuleMod.createNetworkManager(chromeApi, cdpClient)
      : null;

    const engines = {
      sessionManager: sessionManager,
      vomEngine: vomEngine,
      longScreenshotEngine: longScreenshotEngine,
      humanLoopManager: humanLoopManager,
      fileInputTransfer: fileInputTransfer,
      dropFileTransfer: dropFileTransfer
    };

    // 注册高阶 Agent 动作、DevTools 动作、Debugger 动作与 Network 动作
    agentMod.registerAgentHandlers(handlers, cdpManager, engines, utils);
    devtoolsMod.registerDevToolsHandlers(handlers, cdpManager, devToolsCollector, utils);
    if (debuggerMod && typeof debuggerMod.registerDebuggerHandlers === 'function') {
      debuggerMod.registerDebuggerHandlers(handlers, cdpManager, debuggerManager, utils);
    }
    if (networkMod && typeof networkMod.registerNetworkHandlers === 'function') {
      networkMod.registerNetworkHandlers(handlers, cdpManager, networkManager, utils);
    }
    if (domMod && typeof domMod.registerDomHandlers === 'function') {
      domMod.registerDomHandlers(handlers, chromeApi, cdpManager, utils);
    }

    handlers.set('reloadExtension', function () {
      setTimeout(function () {
        if (chromeApi.runtime && typeof chromeApi.runtime.reload === 'function') {
          chromeApi.runtime.reload();
        }
      }, 100);
      return Promise.resolve({
        success: true,
        message: 'Browser extension reload initiated'
      });
    });
    handlers.set('reload_extension', handlers.get('reloadExtension'));

    return {
      listActions: function () { return BROWSER_ACTION_NAMES.slice(); },
      execute: function (action, params) {
        const handler = handlers.get(action);
        if (!handler) {
          return Promise.reject(new Error('Unknown browser action: ' + action));
        }
        try {
          return Promise.resolve(handler(params));
        } catch (error) {
          return Promise.reject(error);
        }
      }
    };
  }

  return {
    BROWSER_ACTION_NAMES: BROWSER_ACTION_NAMES,
    createBrowserActionRegistry: createBrowserActionRegistry,
    getSiteCookiesForSender: getSiteCookiesForSender
  };
});
