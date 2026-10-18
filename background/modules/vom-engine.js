(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.CrawlerVomEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createVomEngine(cdpClient) {
    if (!cdpClient || typeof cdpClient.sendCommand !== 'function') {
      throw new Error('cdpClient with sendCommand is required');
    }

    // ref -> { ref, role, name, backendNodeId, rect, center, tabId }
    const refStore = new Map();

    /**
     * 采集页面无障碍与布局数据，合成 VOM 紧凑语义树并建立 Ref 映射
     * @param {number} tabId
     * @param {object} [options]
     * @param {number} [options.maxTokens]
     * @param {boolean} [options.redactValues=true]
     * @returns {Promise<{ tree: string, refs: Record<string, object>, viewport: { width: number, height: number } }>}
     */
    async function captureVom(tabId, options) {
      options = options || {};
      const redactValues = options.redactValues !== false;

      // 1. 并发获取 AXTree 与 DOMSnapshot
      const axPromise = cdpClient.sendCommand({ tabId: tabId }, 'Accessibility.getFullAXTree', {});
      const domPromise = cdpClient.sendCommand({ tabId: tabId }, 'DOMSnapshot.captureSnapshot', {
        computedStyles: ['visibility', 'display']
      });

      const results = await Promise.all([axPromise, domPromise]);
      const axData = results[0] || {};
      const domData = results[1] || {};

      const axNodes = axData.nodes || [];
      const documents = domData.documents || [];
      const strings = domData.strings || [];

      // 2. 解析 DOMSnapshot 建立 backendNodeId -> LayoutInfo 映射
      const layoutMap = new Map();
      let viewport = { width: 1280, height: 800 };

      documents.forEach(function (doc) {
        const nodes = doc.nodes || {};
        const backendNodeIds = nodes.backendNodeId || [];
        const layout = doc.layout || {};
        const nodeIndices = layout.nodeIndex || [];
        const bounds = layout.bounds || [];
        const styles = layout.styles || [];

        for (let i = 0; i < nodeIndices.length; i++) {
          const nodeIdx = nodeIndices[i];
          const bId = backendNodeIds[nodeIdx];
          const bound = bounds[i] || [0, 0, 0, 0];
          const stylePair = styles[i] || [];

          // 字符串表解析
          function resolveString(val) {
            if (typeof val === 'number') return strings[val] || '';
            return String(val || '');
          }

          const visibility = resolveString(stylePair[0]).toLowerCase();
          const display = resolveString(stylePair[1]).toLowerCase();

          const rect = {
            x: Math.round(bound[0]),
            y: Math.round(bound[1]),
            w: Math.round(bound[2]),
            h: Math.round(bound[3])
          };

          if (bId === 1 && rect.w > 0 && rect.h > 0) {
            viewport = { width: rect.w, height: rect.h };
          }

          layoutMap.set(bId, {
            rect: rect,
            visibility: visibility,
            display: display
          });
        }
      });

      // 3. 关联、剪枝与生成 @eN
      const lines = [];
      const currentSessionRefs = {};
      let refCounter = 0;

      axNodes.forEach(function (ax) {
        const role = (ax.role && ax.role.value) || '';
        const name = (ax.name && ax.name.value) || '';
        let val = (ax.value && ax.value.value) || '';
        const bId = ax.backendDOMNodeId;

        // 忽略纯根节点与无角色节点
        if (!role || role === 'RootWebArea') return;

        const layout = layoutMap.get(bId);
        if (!layout) return;

        const rect = layout.rect;
        // 剪枝规则：尺寸 <= 2px 视同不可见；或显式 hidden/none
        if (rect.w <= 2 || rect.h <= 2) return;
        if (layout.visibility === 'hidden' || layout.display === 'none') return;

        // 敏感表单脱敏
        if (redactValues && (role === 'textbox' || role === 'searchbox')) {
          if (val) val = '***';
        }

        refCounter++;
        const refKey = '@e' + refCounter;
        const center = {
          x: Math.round(rect.x + rect.w / 2),
          y: Math.round(rect.y + rect.h / 2)
        };

        const refEntry = {
          ref: refKey,
          role: role,
          name: name,
          backendNodeId: bId,
          rect: rect,
          center: center,
          tabId: tabId
        };

        refStore.set(refKey, refEntry);
        currentSessionRefs[refKey] = refEntry;

        let line = '  [' + role + ']';
        if (name) line += ' "' + name.replace(/"/g, '\\"') + '"';
        if (val) line += ' value="' + val.replace(/"/g, '\\"') + '"';
        line += ' ' + refKey + ' (x: ' + rect.x + ', y: ' + rect.y + ', w: ' + rect.w + ', h: ' + rect.h + ')';

        lines.push(line);
      });

      const tree = lines.join('\n');
      return {
        tree: tree,
        refs: currentSessionRefs,
        viewport: viewport
      };
    }

    /**
     * 解析 @eN 为坐标及元数据
     * @param {string} ref
     */
    function resolveRef(ref) {
      if (!ref || typeof ref !== 'string') return null;
      return refStore.get(ref) || null;
    }

    function clearRefs(tabId) {
      if (tabId === undefined) {
        refStore.clear();
        return;
      }
      for (const [key, entry] of refStore.entries()) {
        if (entry.tabId === tabId) {
          refStore.delete(key);
        }
      }
    }

    return {
      captureVom: captureVom,
      resolveRef: resolveRef,
      clearRefs: clearRefs
    };
  }

  return {
    createVomEngine: createVomEngine
  };
});
