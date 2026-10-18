(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.CrawlerLongScreenshot = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * 计算切片绘制在 Canvas 上的精确整数像素坐标
   * @param {object} metrics
   * @param {number} covered 当前已覆盖的 Y 坐标
   * @param {number} scale 设备像素比 DPR
   * @param {boolean} isFirst 是否首屏
   * @param {boolean} isFinal 是否尾屏
   */
  function sliceForFrame(metrics, covered, scale, isFirst, isFinal) {
    const topSkip = isFirst ? 0 : (metrics.topOverlayHeight || 0);
    const bottomSkip = isFinal ? 0 : (metrics.bottomOverlayHeight || 0);

    const availableHeight = Math.max(0, metrics.viewportHeight - topSkip - bottomSkip);
    const sourceY = Math.round(topSkip * scale);
    const targetY = Math.round((covered + topSkip) * scale);
    const height = Math.round(availableHeight * scale);

    return {
      sourceY: sourceY,
      targetY: targetY,
      height: height
    };
  }

  /**
   * 将引擎采集的切片列表拼接为完整长图
   * @param {object} capture captureFullPageScreenshot 的返回值
   * @param {string} [format='png'] 'png' | 'jpeg'
   * @param {number} [quality=90] 仅 jpeg 生效
   * @returns {Promise<string>} dataURL（无 data: 前缀）
   */
  async function stitchSlices(capture, format, quality) {
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
      throw new Error('stitchSlices requires createImageBitmap and OffscreenCanvas support');
    }
    if (!capture || !Array.isArray(capture.slices) || capture.slices.length === 0) {
      throw new Error('stitchSlices requires a non-empty slices array');
    }

    const width = Math.max(1, Math.round(capture.totalWidth || 0));
    const height = Math.max(1, Math.round(capture.totalHeight || 0));
    const scale = capture.dpr || 1;

    const canvas = new OffscreenCanvas(Math.round(width * scale), Math.round(height * scale));
    const ctx = canvas.getContext('2d');

    for (const slice of capture.slices) {
      if (!slice || !slice.data) continue;
      const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,' + slice.data)).blob());
      const srcY = slice.slice ? (slice.slice.sourceY || 0) : 0;
      const dstY = slice.slice ? (slice.slice.targetY || 0) : 0;
      const drawH = Math.min(
        slice.slice && slice.slice.height ? slice.slice.height : bitmap.height,
        bitmap.height - srcY
      );
      if (drawH > 0) {
        ctx.drawImage(bitmap, 0, srcY, bitmap.width, drawH, 0, dstY, bitmap.width, drawH);
      }
      if (typeof bitmap.close === 'function') bitmap.close();
    }

    const blob = await canvas.convertToBlob(
      format === 'jpeg' ? { type: 'image/jpeg', quality: (quality || 90) / 100 } : { type: 'image/png' }
    );

    const buf = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  function createLongScreenshotEngine(cdpClient) {
    if (!cdpClient || typeof cdpClient.sendCommand !== 'function') {
      throw new Error('cdpClient with sendCommand is required');
    }

    /**
     * 捕获全页长截图切片集，并在完成或异常后精准复原原视口位置
     * @param {number} tabId
     * @param {object} [options]
     * @param {number} [options.timeoutMs=60000]
     */
    async function captureFullPageScreenshot(tabId, options) {
      options = options || {};
      const timeoutMs = options.timeoutMs || 60000;
      const startTime = Date.now();

      // 1. 获取页面当前视口与完整尺寸度量
      const metricsExpr = '/* __getMetrics */ (function() {' +
        'var d = document.documentElement;' +
        'var b = document.body;' +
        'return {' +
        'origX: window.scrollX || 0,' +
        'origY: window.scrollY || 0,' +
        'scrollWidth: Math.max(d.scrollWidth, b ? b.scrollWidth : 0),' +
        'scrollHeight: Math.max(d.scrollHeight, b ? b.scrollHeight : 0),' +
        'viewportWidth: window.innerWidth,' +
        'viewportHeight: window.innerHeight,' +
        'dpr: window.devicePixelRatio || 1' +
        '};' +
        '})()';

      const evalRes = await cdpClient.sendCommand({ tabId: tabId }, 'Runtime.evaluate', {
        expression: metricsExpr,
        returnByValue: true
      });

      const initialMetrics = (evalRes && evalRes.result && evalRes.result.value) || {
        origX: 0,
        origY: 0,
        scrollWidth: 1280,
        scrollHeight: 800,
        viewportWidth: 1280,
        viewportHeight: 800,
        dpr: 1
      };

      const origX = initialMetrics.origX;
      const origY = initialMetrics.origY;
      let scrollHeight = initialMetrics.scrollHeight;
      const scrollWidth = initialMetrics.scrollWidth;
      const viewportHeight = initialMetrics.viewportHeight;
      const dpr = initialMetrics.dpr || 1;

      const slices = [];
      let currentY = 0;
      let frameIndex = 0;
      let lastActualY = -1;

      try {
        while (currentY < scrollHeight) {
          if (Date.now() - startTime > timeoutMs) {
            throw new Error('Full-page screenshot timed out after ' + timeoutMs + 'ms');
          }

          // 移动视口到当前切片位置，并回读真实滚动位置。
          // 浏览器会在页面底部夹紧 scrollY（scrollHeight - viewportHeight），
          // 若直接拿「打算滚到的 currentY」当切片原点，最后一片会被错标，
          // 导致拼接结果出现约一屏的错位。
          const scrollRes = await cdpClient.sendCommand({ tabId: tabId }, 'Runtime.evaluate', {
            expression: 'window.scrollTo(0, ' + currentY + '); window.scrollY',
            returnByValue: true
          });
          const actualY = (scrollRes && scrollRes.result && typeof scrollRes.result.value === 'number')
            ? Math.round(scrollRes.result.value)
            : currentY;

          // 底部夹紧后位置不再推进，说明剩余高度不足一屏，避免重复采集
          if (actualY === lastActualY) break;
          lastActualY = actualY;

          // 抓取视口截图
          const shot = await cdpClient.sendCommand({ tabId: tabId }, 'Page.captureScreenshot', {
            format: 'png',
            fromSurface: true,
            captureBeyondViewport: false
          });

          const isFirst = frameIndex === 0;
          const isFinal = (actualY + viewportHeight) >= scrollHeight;

          const frameMetrics = {
            y: actualY,
            viewportHeight: viewportHeight,
            height: scrollHeight,
            topOverlayHeight: 0,
            bottomOverlayHeight: 0
          };

          const sliceInfo = sliceForFrame(frameMetrics, actualY, dpr, isFirst, isFinal);

          slices.push({
            frameIndex: frameIndex,
            y: actualY,
            data: shot && shot.data,
            slice: sliceInfo
          });

          frameIndex++;
          currentY += viewportHeight;

          // Rolling Tile 检查：探测页面是否因懒加载继续变长
          if (currentY < scrollHeight || isFinal) {
            const probeRes = await cdpClient.sendCommand({ tabId: tabId }, 'Runtime.evaluate', {
              expression: metricsExpr,
              returnByValue: true
            });
            const latestMetrics = probeRes && probeRes.result && probeRes.result.value;
            if (latestMetrics && latestMetrics.scrollHeight > scrollHeight) {
              scrollHeight = latestMetrics.scrollHeight;
            }
          }
        }

        const capture = {
          totalWidth: scrollWidth,
          totalHeight: scrollHeight,
          dpr: dpr,
          slices: slices
        };

        // 拼接为单张长图；运行环境无 Canvas 能力时保留 slices 供调用方降级
        try {
          capture.data = await stitchSlices(capture, options.format, options.quality);
          capture.stitched = true;
        } catch (stitchError) {
          capture.stitched = false;
          capture.stitchError = stitchError && stitchError.message ? stitchError.message : String(stitchError);
        }

        return capture;
      } finally {
        // 确保无论正常返回或异常中断，必复位滚动位置
        try {
          await cdpClient.sendCommand({ tabId: tabId }, 'Runtime.evaluate', {
            expression: 'window.scrollTo(' + origX + ', ' + origY + ')'
          });
        } catch (_) {}
      }
    }

    return {
      captureFullPageScreenshot: captureFullPageScreenshot,
      sliceForFrame: sliceForFrame
    };
  }

  return {
    createLongScreenshotEngine: createLongScreenshotEngine,
    sliceForFrame: sliceForFrame,
    stitchSlices: stitchSlices
  };
});
