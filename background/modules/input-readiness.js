(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.CrawlerInputReadiness = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * 强制 Chromium 合成器输出一帧（防止后台标签页/未聚焦窗口暂停渲染流水线）
   * @param {object} chromeApi
   * @param {number} tabId
   * @param {number} [timeoutMs=3000]
   */
  async function flushCompositorFrame(chromeApi, tabId, timeoutMs) {
    timeoutMs = timeoutMs || 3000;
    if (!chromeApi || !chromeApi.debugger || typeof chromeApi.debugger.sendCommand !== 'function') {
      throw new Error('chrome.debugger is required');
    }
    const sendPromise = chromeApi.debugger.sendCommand({ tabId: tabId }, 'Page.captureScreenshot', {
      format: 'jpeg',
      quality: 0,
      fromSurface: true,
      captureBeyondViewport: false
    });
    let timer;
    const timeoutPromise = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        reject(new Error('Renderer flush timeout'));
      }, timeoutMs);
    });
    try {
      await Promise.race([sendPromise, timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 等待连续两次 requestAnimationFrame，确保渲染管线稳定
   * @param {object} chromeApi
   * @param {number} tabId
   */
  async function waitForNextPaint(chromeApi, tabId) {
    if (!chromeApi || !chromeApi.debugger || typeof chromeApi.debugger.sendCommand !== 'function') {
      throw new Error('chrome.debugger is required');
    }
    const expression = 'new Promise(function(resolve) {' +
      'requestAnimationFrame(function() {' +
      'requestAnimationFrame(function() { resolve(true); });' +
      '});' +
      '})';
    await chromeApi.debugger.sendCommand({ tabId: tabId }, 'Runtime.evaluate', {
      expression: expression,
      awaitPromise: true,
      returnByValue: true
    });
  }

  return {
    flushCompositorFrame: flushCompositorFrame,
    waitForNextPaint: waitForNextPaint
  };
});
