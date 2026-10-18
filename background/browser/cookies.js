(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.CrawlerBrowserCookies = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function registerCookieHandlers(handlers, chromeApi, utils) {
    if (!chromeApi || !chromeApi.cookies) throw new Error('chromeApi with cookies is required');
    utils = utils || (typeof globalThis !== 'undefined' && globalThis.CrawlerBrowserUtils) || (typeof require === 'function' && require('./utils.js'));
    const callChrome = utils.callChrome;
    const paramsObject = utils.paramsObject;
    const httpUrl = utils.httpUrl;

    handlers.set('getCookies', function (params) {
      params = paramsObject(params);
      const filter = {};
      if (params.url !== undefined) {
        httpUrl(params.url);
        filter.url = params.url;
      }
      if (params.name !== undefined) filter.name = params.name;
      return callChrome(chromeApi, chromeApi.cookies.getAll, [filter], 'Browser cookies.getAll failed').then(function (cookies) {
        return cookies || [];
      });
    });
  }

  return {
    registerCookieHandlers: registerCookieHandlers
  };
});
