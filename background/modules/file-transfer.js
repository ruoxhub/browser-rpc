(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.CrawlerFileTransfer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createFileInputTransfer(cdpClient) {
    if (!cdpClient || typeof cdpClient.sendCommand !== 'function') {
      throw new Error('cdpClient with sendCommand is required');
    }

    const pendingChoosers = new Map();

    function handleCdpEvent(tabId, method, params) {
      if (method === 'Page.fileChooserOpened') {
        const handler = pendingChoosers.get(tabId);
        if (typeof handler === 'function') {
          handler(params);
        }
      }
    }

    /**
     * 通过拦截系统文件弹窗注入本地文件路径
     * @param {number} tabId
     * @param {string[]} files
     * @param {Function} [triggerAction]
     * @param {number} [timeoutMs=30000]
     */
    async function uploadFiles(tabId, files, triggerAction, timeoutMs) {
      timeoutMs = timeoutMs || 30000;
      if (!Array.isArray(files) || files.length === 0) {
        throw new Error('files must be a non-empty array of file paths');
      }

      // 1. 开启弹窗拦截
      await cdpClient.sendCommand({ tabId: tabId }, 'Page.setInterceptFileChooserDialog', {
        enabled: true
      });

      let timer;
      let chooserPromise = new Promise(function (resolve, reject) {
        pendingChoosers.set(tabId, function (params) {
          resolve(params);
        });
        timer = setTimeout(function () {
          reject(new Error('File chooser interception timed out'));
        }, timeoutMs);
      });

      try {
        // 2. 触发点击使页面弹出文件框
        if (typeof triggerAction === 'function') {
          await triggerAction();
        }

        const chooserEvent = await chooserPromise;
        const bId = chooserEvent.backendNodeId;

        // 3. 提交文件到目标 DOM 节点
        await cdpClient.sendCommand({ tabId: tabId }, 'DOM.setFileInputFiles', {
          files: files,
          backendNodeId: bId
        });

        return {
          success: true,
          files: files,
          backendNodeId: bId
        };
      } finally {
        clearTimeout(timer);
        pendingChoosers.delete(tabId);
        try {
          await cdpClient.sendCommand({ tabId: tabId }, 'Page.setInterceptFileChooserDialog', {
            enabled: false
          });
        } catch (_) {}
      }
    }

    return {
      uploadFiles: uploadFiles,
      handleCdpEvent: handleCdpEvent
    };
  }

  function createDropFileTransfer(cdpClient) {
    if (!cdpClient || typeof cdpClient.sendCommand !== 'function') {
      throw new Error('cdpClient with sendCommand is required');
    }

    /**
     * 模拟 CDP 原生 HTML5 拖放事件流
     * @param {number} tabId
     * @param {string[]} files
     * @param {{ x: number, y: number }} point
     */
    async function dropFiles(tabId, files, point) {
      if (!Array.isArray(files) || files.length === 0) {
        throw new Error('files must be a non-empty array of file paths');
      }
      point = point || { x: 0, y: 0 };
      const x = Math.round(point.x || 0);
      const y = Math.round(point.y || 0);

      const dragData = {
        files: files,
        dragOperationsMask: 1
      };

      // 1. dragEnter
      await cdpClient.sendCommand({ tabId: tabId }, 'Input.dispatchDragEvent', {
        type: 'dragEnter',
        x: x,
        y: y,
        data: dragData
      });

      // 2. dragOver
      await cdpClient.sendCommand({ tabId: tabId }, 'Input.dispatchDragEvent', {
        type: 'dragOver',
        x: x,
        y: y,
        data: dragData
      });

      // 3. drop
      await cdpClient.sendCommand({ tabId: tabId }, 'Input.dispatchDragEvent', {
        type: 'drop',
        x: x,
        y: y,
        data: dragData
      });

      return {
        success: true,
        files: files,
        point: { x: x, y: y }
      };
    }

    return {
      dropFiles: dropFiles
    };
  }

  return {
    createFileInputTransfer: createFileInputTransfer,
    createDropFileTransfer: createDropFileTransfer
  };
});
