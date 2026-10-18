(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.CrawlerBrowserDom = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function registerDomHandlers(handlers, chromeApi, cdpManager, utils) {
    if (!chromeApi) throw new Error('chromeApi is required');
    utils = utils || (typeof globalThis !== 'undefined' && globalThis.CrawlerBrowserUtils) || (typeof require === 'function' && require('./utils.js'));
    const callChrome = utils.callChrome;
    const paramsObject = utils.paramsObject;
    const positiveTabId = utils.positiveTabId;

    const tabs = chromeApi.tabs;
    const ensureDebuggerAttached = cdpManager ? cdpManager.ensureDebuggerAttached : function () { return Promise.reject(new Error('cdpManager not available')); };
    const callDebuggerCommand = cdpManager ? cdpManager.callDebuggerCommand : function () { return Promise.reject(new Error('cdpManager not available')); };

    function resolveTargetTabId(params) {
      if (params.tabId !== undefined) {
        positiveTabId(params.tabId);
        return Promise.resolve(params.tabId);
      }
      if (!tabs || typeof tabs.query !== 'function') {
        return Promise.reject(new Error('chromeApi.tabs.query is not available'));
      }
      return callChrome(chromeApi, tabs.query, [{ active: true, currentWindow: true }], 'Browser tabs.query failed')
        .then(function (result) {
          const active = result && result[0];
          if (!active || !active.id) throw new Error('No active tab found');
          return active.id;
        });
    }

    // 页内求值基础桥接函数：优先走 CDP Runtime.evaluate，不可用时降级 chrome.scripting.executeScript
    function evalInTab(tabId, pageFn, args) {
      if (cdpManager && typeof cdpManager.callDebuggerCommand === 'function') {
        const fnSource = pageFn.toString();
        const argsJson = JSON.stringify(args || []);
        const expr = '(' + fnSource + ').apply(null, ' + argsJson + ')';

        return ensureDebuggerAttached(tabId).then(function () {
          return callDebuggerCommand(tabId, 'Runtime.evaluate', {
            expression: expr,
            returnByValue: true,
            awaitPromise: true,
            allowUnsafeEvalBlockedByCSP: true
          });
        }).then(function (res) {
          if (res && res.exceptionDetails) {
            const ex = res.exceptionDetails.exception || {};
            const text = ex.description || ex.value || res.exceptionDetails.text || 'DOM evaluation exception';
            throw new Error('DOM evaluation failed: ' + text);
          }
          if (res && res.result && res.result.value !== undefined) {
            return res.result.value;
          }
          if (chromeApi.scripting && typeof chromeApi.scripting.executeScript === 'function') {
            return runScripting(tabId, pageFn, args);
          }
          return (res && res.result && res.result.value) || null;
        }).catch(function (err) {
          if (chromeApi.scripting && typeof chromeApi.scripting.executeScript === 'function') {
            return runScripting(tabId, pageFn, args);
          }
          throw err;
        });
      }

      if (chromeApi.scripting && typeof chromeApi.scripting.executeScript === 'function') {
        return runScripting(tabId, pageFn, args);
      }
      return Promise.reject(new Error('Neither CDP nor chrome.scripting is available'));
    }

    function runScripting(tabId, pageFn, args) {
      return callChrome(
        chromeApi,
        chromeApi.scripting.executeScript,
        [{
          target: { tabId: tabId },
          world: 'MAIN',
          func: pageFn,
          args: args || []
        }],
        'Browser scripting.executeScript failed'
      ).then(function (results) {
        if (results && results[0]) {
          return results[0].result;
        }
        return null;
      });
    }

    // ─── 页面内执行的逻辑（独立自包含，序列化后在 MAIN world 中运行） ───

    function pageQueryDom(selector, all, limit) {
      function resolveElements(rawSelector) {
        if (!rawSelector || typeof rawSelector !== 'string') return [];
        var sel = rawSelector.trim();
        var nth = null;
        var nthMatch = sel.match(/\s*>>\s*nth\s*=\s*(\d+)\s*$/i);
        if (nthMatch) {
          nth = parseInt(nthMatch[1], 10);
          sel = sel.slice(0, nthMatch.index).trim();
        }

        var elements = [];
        if (sel.indexOf('xpath=') === 0 || sel.indexOf('//') === 0 || sel.indexOf('(//') === 0) {
          var xpath = sel.indexOf('xpath=') === 0 ? sel.slice(6) : sel;
          try {
            var snap = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            for (var i = 0; i < snap.snapshotLength; i++) {
              var node = snap.snapshotItem(i);
              if (node && node.nodeType === 1) elements.push(node);
            }
          } catch (e) {
            throw new Error('Invalid XPath: ' + xpath + ' (' + e.message + ')');
          }
        } else if (sel.indexOf('text=') === 0) {
          var target = sel.slice(5).trim();
          if ((target.charAt(0) === '"' && target.charAt(target.length - 1) === '"') ||
              (target.charAt(0) === "'" && target.charAt(target.length - 1) === "'")) {
            target = target.slice(1, -1);
          }
          var lower = target.toLowerCase();
          var allNodes = document.querySelectorAll('*');
          for (var i = 0; i < allNodes.length; i++) {
            var el = allNodes[i];
            if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'NOSCRIPT') continue;
            var text = (el.innerText || el.textContent || '').trim();
            if (text.toLowerCase().indexOf(lower) !== -1) {
              var hasDeeper = false;
              for (var j = 0; j < el.children.length; j++) {
                var childText = (el.children[j].innerText || el.children[j].textContent || '').trim();
                if (childText.toLowerCase().indexOf(lower) !== -1) {
                  hasDeeper = true;
                  break;
                }
              }
              if (!hasDeeper) {
                elements.push(el);
              }
            }
          }
        } else if (sel.indexOf('role=') === 0) {
          var roleContent = sel.slice(5).trim();
          var roleMatch = roleContent.match(/^([a-zA-Z_-]+)(?:\[name=(?:"([^"]*)"|'([^']*)'|([^\]]*))\])?$/i);
          if (roleMatch) {
            var roleName = (roleMatch[1] || '').toLowerCase();
            var nameAttr = roleMatch[2] || roleMatch[3] || roleMatch[4] || null;
            var allRoles = document.querySelectorAll('*');
            for (var i = 0; i < allRoles.length; i++) {
              var el = allRoles[i];
              var explicitRole = (el.getAttribute('role') || '').toLowerCase();
              var matchRole = false;
              if (explicitRole === roleName) {
                matchRole = true;
              } else if (roleName === 'button' && (el.tagName === 'BUTTON' || (el.tagName === 'INPUT' && (el.type === 'button' || el.type === 'submit' || el.type === 'reset')))) {
                matchRole = true;
              } else if (roleName === 'link' && el.tagName === 'A' && el.hasAttribute('href')) {
                matchRole = true;
              } else if (roleName === 'textbox' && ((el.tagName === 'INPUT' && (!el.type || el.type === 'text' || el.type === 'search' || el.type === 'tel' || el.type === 'url' || el.type === 'email' || el.type === 'password')) || el.tagName === 'TEXTAREA')) {
                matchRole = true;
              } else if (roleName === 'checkbox' && el.tagName === 'INPUT' && el.type === 'checkbox') {
                matchRole = true;
              } else if (roleName === 'radio' && el.tagName === 'INPUT' && el.type === 'radio') {
                matchRole = true;
              } else if (roleName === 'combobox' && (el.tagName === 'SELECT' || explicitRole === 'combobox')) {
                matchRole = true;
              }

              if (matchRole) {
                if (nameAttr !== null) {
                  var labelEl = el.getAttribute('aria-labelledby') ? document.getElementById(el.getAttribute('aria-labelledby')) : null;
                  var accName = el.getAttribute('aria-label') ||
                    (labelEl ? labelEl.textContent : null) ||
                    el.getAttribute('title') ||
                    el.getAttribute('placeholder') ||
                    el.value ||
                    (el.innerText || el.textContent || '');
                  if ((accName || '').trim().toLowerCase().indexOf(nameAttr.toLowerCase()) !== -1) {
                    elements.push(el);
                  }
                } else {
                  elements.push(el);
                }
              }
            }
          } else {
            try {
              elements = Array.prototype.slice.call(document.querySelectorAll(sel));
            } catch (e) {
              throw new Error('Invalid selector: ' + sel + ' (' + e.message + ')');
            }
          }
        } else {
          try {
            elements = Array.prototype.slice.call(document.querySelectorAll(sel));
          } catch (e) {
            throw new Error('Invalid selector: ' + sel + ' (' + e.message + ')');
          }
        }

        if (nth !== null) {
          if (nth >= 0 && nth < elements.length) {
            return [elements[nth]];
          }
          return [];
        }
        return elements;
      }

      function extractInfo(el) {
        if (!el) return { found: false };
        var attributes = {};
        if (el.attributes) {
          for (var i = 0; i < el.attributes.length; i++) {
            var attr = el.attributes[i];
            if (attr) attributes[attr.name] = attr.value;
          }
        }
        var rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
        var visible = true;
        if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
          var style = window.getComputedStyle(el);
          visible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        }
        var text = (el.innerText || el.textContent || el.value || '').trim();
        return {
          found: true,
          tag: el.tagName || '',
          id: el.id || undefined,
          class: el.className || undefined,
          attributes: attributes,
          rect: {
            x: rect.x !== undefined ? rect.x : rect.left,
            y: rect.y !== undefined ? rect.y : rect.top,
            width: rect.width || 0,
            height: rect.height || 0,
            top: rect.top || 0,
            left: rect.left || 0,
            right: rect.right || 0,
            bottom: rect.bottom || 0
          },
          visible: visible,
          text: text
        };
      }

      var matches = resolveElements(selector);
      if (!all) {
        if (matches.length === 0) {
          return { found: false, selector: selector, data: null };
        }
        var info = extractInfo(matches[0]);
        info.selector = selector;
        return info;
      }

      var maxCount = (typeof limit === 'number' && limit > 0) ? limit : 50;
      var sliced = matches.slice(0, maxCount);
      var results = [];
      for (var i = 0; i < sliced.length; i++) {
        results.push(extractInfo(sliced[i]));
      }
      return {
        selector: selector,
        count: results.length,
        totalMatches: matches.length,
        elements: results
      };
    }

    function pageGetDomStructure(maxDepth, includeText) {
      var depthLimit = (typeof maxDepth === 'number' && maxDepth > 0) ? maxDepth : 3;
      var withText = includeText !== false;

      function buildTree(node, currentDepth) {
        if (!node || currentDepth > depthLimit) return null;
        var result = {
          tag: node.tagName || '',
          id: node.id || undefined,
          class: node.className || undefined
        };
        if (withText) {
          if (node.childNodes && node.childNodes.length === 1 && node.childNodes[0].nodeType === 3) {
            var text = node.textContent ? node.textContent.trim() : '';
            if (text) result.text = text;
          }
        }
        var children = [];
        if (node.children) {
          for (var i = 0; i < node.children.length; i++) {
            var childTree = buildTree(node.children[i], currentDepth + 1);
            if (childTree) children.push(childTree);
          }
        }
        if (children.length > 0) result.children = children;
        return result;
      }

      var rootNode = document.body || document.documentElement;
      return buildTree(rootNode, 0);
    }

    function pageFindClickableElements(filterText) {
      var lowered = filterText ? String(filterText).toLowerCase() : null;
      var elements = [];
      var candidates = document.querySelectorAll(
        'button, a[href], input[type="button"], input[type="submit"], input[type="reset"], [role="button"], [role="link"], [onclick]'
      );
      for (var i = 0; i < candidates.length; i++) {
        var el = candidates[i];
        var text = (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '').trim();
        if (lowered && text.toLowerCase().indexOf(lowered) === -1) continue;

        var rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
        var visible = true;
        if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
          var style = window.getComputedStyle(el);
          visible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
        }

        var type = 'button';
        if (el.tagName === 'A' || el.getAttribute('role') === 'link') type = 'link';
        else if (el.tagName === 'INPUT') type = 'input';

        var selector = '';
        if (el.id) {
          selector = typeof CSS !== 'undefined' && CSS.escape ? '#' + CSS.escape(el.id) : '#' + el.id;
        } else if (el.className && typeof el.className === 'string' && el.className.trim()) {
          var firstCls = el.className.trim().split(/\s+/)[0];
          var escapedCls = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(firstCls) : firstCls;
          selector = el.tagName.toLowerCase() + '.' + escapedCls;
        } else {
          selector = el.tagName.toLowerCase();
        }

        elements.push({
          selector: selector,
          text: text,
          type: type,
          visible: visible,
          rect: {
            x: rect.x !== undefined ? rect.x : rect.left,
            y: rect.y !== undefined ? rect.y : rect.top,
            width: rect.width || 0,
            height: rect.height || 0,
            top: rect.top || 0,
            left: rect.left || 0,
            right: rect.right || 0,
            bottom: rect.bottom || 0
          }
        });
      }
      return elements;
    }

    function pageLocateAndScroll(rawSelector) {
      function resolveElements(sel) {
        var s = sel.trim();
        var nth = null;
        var nthMatch = s.match(/\s*>>\s*nth\s*=\s*(\d+)\s*$/i);
        if (nthMatch) {
          nth = parseInt(nthMatch[1], 10);
          s = s.slice(0, nthMatch.index).trim();
        }

        var res = [];
        if (s.indexOf('xpath=') === 0 || s.indexOf('//') === 0 || s.indexOf('(//') === 0) {
          var xpath = s.indexOf('xpath=') === 0 ? s.slice(6) : s;
          var snap = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          for (var i = 0; i < snap.snapshotLength; i++) {
            var n = snap.snapshotItem(i);
            if (n && n.nodeType === 1) res.push(n);
          }
        } else if (s.indexOf('text=') === 0) {
          var target = s.slice(5).trim();
          if ((target.charAt(0) === '"' && target.charAt(target.length - 1) === '"') ||
              (target.charAt(0) === "'" && target.charAt(target.length - 1) === "'")) {
            target = target.slice(1, -1);
          }
          var lower = target.toLowerCase();
          var allNodes = document.querySelectorAll('*');
          for (var i = 0; i < allNodes.length; i++) {
            var el = allNodes[i];
            if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'NOSCRIPT') continue;
            var text = (el.innerText || el.textContent || '').trim();
            if (text.toLowerCase().indexOf(lower) !== -1) {
              var hasDeeper = false;
              for (var j = 0; j < el.children.length; j++) {
                if ((el.children[j].innerText || el.children[j].textContent || '').trim().toLowerCase().indexOf(lower) !== -1) {
                  hasDeeper = true;
                  break;
                }
              }
              if (!hasDeeper) res.push(el);
            }
          }
        } else if (s.indexOf('role=') === 0) {
          var roleMatch = s.slice(5).trim().match(/^([a-zA-Z_-]+)(?:\[name=(?:"([^"]*)"|'([^']*)'|([^\]]*))\])?$/i);
          if (roleMatch) {
            var rName = (roleMatch[1] || '').toLowerCase();
            var nAttr = roleMatch[2] || roleMatch[3] || roleMatch[4] || null;
            var all = document.querySelectorAll('*');
            for (var i = 0; i < all.length; i++) {
              var el = all[i];
              var expRole = (el.getAttribute('role') || '').toLowerCase();
              var match = expRole === rName ||
                (rName === 'button' && (el.tagName === 'BUTTON' || (el.tagName === 'INPUT' && (el.type === 'button' || el.type === 'submit' || el.type === 'reset')))) ||
                (rName === 'link' && el.tagName === 'A' && el.hasAttribute('href')) ||
                (rName === 'textbox' && ((el.tagName === 'INPUT' && (!el.type || el.type === 'text' || el.type === 'search')) || el.tagName === 'TEXTAREA'));
              if (match) {
                if (nAttr !== null) {
                  var acc = el.getAttribute('aria-label') || el.getAttribute('title') || el.value || (el.innerText || el.textContent || '');
                  if (acc.trim().toLowerCase().indexOf(nAttr.toLowerCase()) !== -1) res.push(el);
                } else {
                  res.push(el);
                }
              }
            }
          } else {
            res = Array.prototype.slice.call(document.querySelectorAll(s));
          }
        } else {
          res = Array.prototype.slice.call(document.querySelectorAll(s));
        }

        if (nth !== null) {
          return (nth >= 0 && nth < res.length) ? [res[nth]] : [];
        }
        return res;
      }

      var matches = resolveElements(rawSelector);
      if (!matches || matches.length === 0) return { found: false };
      var el = matches[0];
      if (typeof el.scrollIntoViewIfNeeded === 'function') {
        el.scrollIntoViewIfNeeded();
      } else if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'center', inline: 'center' });
      }
      var rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0 };
      return {
        found: true,
        tag: el.tagName || '',
        x: Math.round((rect.left || rect.x || 0) + (rect.width || 0) / 2),
        y: Math.round((rect.top || rect.y || 0) + (rect.height || 0) / 2),
        width: rect.width || 0,
        height: rect.height || 0,
        disabled: !!el.disabled
      };
    }

    function pageClickFallback(rawSelector, dblClick) {
      var info = pageLocateAndScroll(rawSelector);
      if (!info.found) return { success: false, error: 'Element not found: ' + rawSelector };
      var el = document.elementFromPoint ? document.elementFromPoint(info.x, info.y) : null;
      if (!el) {
        var matches = document.querySelectorAll(rawSelector);
        if (matches && matches[0]) el = matches[0];
      }
      if (el) {
        if (typeof el.focus === 'function') el.focus();
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        if (typeof el.click === 'function') el.click();
        if (dblClick) {
          el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
        }
      }
      return { success: true, point: { x: info.x, y: info.y } };
    }

    function pageFill(selector, value) {
      function resolveElements(sel) {
        var s = sel.trim();
        var nth = null;
        var nthMatch = s.match(/\s*>>\s*nth\s*=\s*(\d+)\s*$/i);
        if (nthMatch) {
          nth = parseInt(nthMatch[1], 10);
          s = s.slice(0, nthMatch.index).trim();
        }

        var res = [];
        if (s.indexOf('xpath=') === 0 || s.indexOf('//') === 0 || s.indexOf('(//') === 0) {
          var xpath = s.indexOf('xpath=') === 0 ? s.slice(6) : s;
          var snap = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          for (var i = 0; i < snap.snapshotLength; i++) {
            var n = snap.snapshotItem(i);
            if (n && n.nodeType === 1) res.push(n);
          }
        } else if (s.indexOf('text=') === 0) {
          var target = s.slice(5).trim();
          if ((target.charAt(0) === '"' && target.charAt(target.length - 1) === '"') ||
              (target.charAt(0) === "'" && target.charAt(target.length - 1) === "'")) {
            target = target.slice(1, -1);
          }
          var lower = target.toLowerCase();
          var allNodes = document.querySelectorAll('*');
          for (var i = 0; i < allNodes.length; i++) {
            var el = allNodes[i];
            if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'NOSCRIPT') continue;
            var text = (el.innerText || el.textContent || '').trim();
            if (text.toLowerCase().indexOf(lower) !== -1) {
              var hasDeeper = false;
              for (var j = 0; j < el.children.length; j++) {
                if ((el.children[j].innerText || el.children[j].textContent || '').trim().toLowerCase().indexOf(lower) !== -1) {
                  hasDeeper = true;
                  break;
                }
              }
              if (!hasDeeper) res.push(el);
            }
          }
        } else if (s.indexOf('role=') === 0) {
          var roleMatch = s.slice(5).trim().match(/^([a-zA-Z_-]+)(?:\[name=(?:"([^"]*)"|'([^']*)'|([^\]]*))\])?$/i);
          if (roleMatch) {
            var rName = (roleMatch[1] || '').toLowerCase();
            var nAttr = roleMatch[2] || roleMatch[3] || roleMatch[4] || null;
            var all = document.querySelectorAll('*');
            for (var i = 0; i < all.length; i++) {
              var el = all[i];
              var expRole = (el.getAttribute('role') || '').toLowerCase();
              var match = expRole === rName ||
                (rName === 'button' && (el.tagName === 'BUTTON' || (el.tagName === 'INPUT' && (el.type === 'button' || el.type === 'submit' || el.type === 'reset')))) ||
                (rName === 'link' && el.tagName === 'A' && el.hasAttribute('href')) ||
                (rName === 'textbox' && ((el.tagName === 'INPUT' && (!el.type || el.type === 'text' || el.type === 'search')) || el.tagName === 'TEXTAREA'));
              if (match) {
                if (nAttr !== null) {
                  var acc = el.getAttribute('aria-label') || el.getAttribute('title') || el.value || (el.innerText || el.textContent || '');
                  if (acc.trim().toLowerCase().indexOf(nAttr.toLowerCase()) !== -1) res.push(el);
                } else {
                  res.push(el);
                }
              }
            }
          } else {
            res = Array.prototype.slice.call(document.querySelectorAll(s));
          }
        } else {
          res = Array.prototype.slice.call(document.querySelectorAll(s));
        }

        if (nth !== null) {
          return (nth >= 0 && nth < res.length) ? [res[nth]] : [];
        }
        return res;
      }

      var els = resolveElements(selector);
      if (!els || els.length === 0) return { found: false };
      var el = els[0];
      var isSelect = false;

      if (typeof el.focus === 'function') el.focus();

      if (el.tagName === 'SELECT') {
        isSelect = true;
        var strVal = String(value);
        var foundOpt = false;
        for (var i = 0; i < el.options.length; i++) {
          var opt = el.options[i];
          if (opt.value === strVal || (opt.text && opt.text.trim() === strVal.trim())) {
            el.selectedIndex = i;
            foundOpt = true;
            break;
          }
        }
        if (!foundOpt && el.options.length > 0) {
          el.value = strVal;
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
        el.checked = (value === true || value === 'true' || value === '1' || value === el.value);
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (el.isContentEditable) {
        el.innerText = String(value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        var str = String(value);
        // 突破 React / Vue 受控组件的值跟踪器 (el._valueTracker)
        if (el._valueTracker && typeof el._valueTracker.setValue === 'function') {
          el._valueTracker.setValue('');
        }

        // 优先从原生 HTMLInputElement / HTMLTextAreaElement 原型获取 setter
        var nativeDesc = null;
        if (el.tagName === 'INPUT' && typeof window !== 'undefined' && window.HTMLInputElement) {
          nativeDesc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        } else if (el.tagName === 'TEXTAREA' && typeof window !== 'undefined' && window.HTMLTextAreaElement) {
          nativeDesc = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
        }
        if (!nativeDesc) {
          var proto = Object.getPrototypeOf(el);
          nativeDesc = Object.getOwnPropertyDescriptor(proto, 'value');
        }

        if (nativeDesc && nativeDesc.set) {
          nativeDesc.set.call(el, str);
        } else {
          el.value = str;
        }

        // 派发带 inputType 的 InputEvent 及合成 change 事件
        var inputEvt;
        try {
          inputEvt = new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: str });
        } catch (_) {
          inputEvt = new Event('input', { bubbles: true, composed: true });
        }
        el.dispatchEvent(inputEvt);
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      }

      return {
        found: true,
        selector: selector,
        value: String(value),
        isSelect: isSelect
      };
    }

    function pageFillForm(fields) {
      var results = [];
      for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        if (f && typeof f.selector === 'string') {
          results.push(pageFill(f.selector, f.value !== undefined ? f.value : ''));
        }
      }
      return results;
    }

    function pagePressKeyFallback(key) {
      var target = document.activeElement || document.body;
      var tokens = key.split('+');
      var mainKey = tokens[tokens.length - 1];
      var hasCtrl = key.indexOf('Control') !== -1 || key.indexOf('Ctrl') !== -1;
      var hasAlt = key.indexOf('Alt') !== -1;
      var hasShift = key.indexOf('Shift') !== -1;
      var hasMeta = key.indexOf('Meta') !== -1 || key.indexOf('Command') !== -1;

      var eventProps = {
        key: mainKey,
        code: mainKey,
        ctrlKey: hasCtrl,
        altKey: hasAlt,
        shiftKey: hasShift,
        metaKey: hasMeta,
        bubbles: true,
        cancelable: true,
        view: window
      };
      target.dispatchEvent(new KeyboardEvent('keydown', eventProps));
      target.dispatchEvent(new KeyboardEvent('keypress', eventProps));
      target.dispatchEvent(new KeyboardEvent('keyup', eventProps));
      return { success: true, mainKey: mainKey };
    }

    // ─── DOM 查询类 Handlers ───

    handlers.set('queryDom', function (params) {
      params = paramsObject(params);
      if (typeof params.selector !== 'string' || !params.selector.trim()) {
        throw new Error('selector is required');
      }
      const selector = params.selector.trim();
      const all = !!params.all;
      const limit = (typeof params.limit === 'number' && params.limit > 0) ? params.limit : 50;

      return resolveTargetTabId(params).then(function (tabId) {
        return evalInTab(tabId, pageQueryDom, [selector, all, limit]).then(function (result) {
          return {
            success: true,
            tabId: tabId,
            selector: selector,
            data: result
          };
        });
      });
    });
    handlers.set('query_dom', handlers.get('queryDom'));

    handlers.set('getDomStructure', function (params) {
      params = paramsObject(params);
      const maxDepth = (typeof params.maxDepth === 'number' && params.maxDepth > 0) ? params.maxDepth : 3;
      const includeText = params.includeText !== false;

      return resolveTargetTabId(params).then(function (tabId) {
        return evalInTab(tabId, pageGetDomStructure, [maxDepth, includeText]).then(function (tree) {
          return {
            success: true,
            tabId: tabId,
            maxDepth: maxDepth,
            includeText: includeText,
            data: tree
          };
        });
      });
    });
    handlers.set('get_dom_structure', handlers.get('getDomStructure'));

    handlers.set('findClickableElements', function (params) {
      params = paramsObject(params);
      const filterText = (typeof params.filterText === 'string' && params.filterText.trim()) ? params.filterText.trim() : null;

      return resolveTargetTabId(params).then(function (tabId) {
        return evalInTab(tabId, pageFindClickableElements, [filterText]).then(function (elements) {
          const list = Array.isArray(elements) ? elements : [];
          return {
            success: true,
            tabId: tabId,
            count: list.length,
            filterText: filterText,
            data: list
          };
        });
      });
    });
    handlers.set('find_clickable_elements', handlers.get('findClickableElements'));

    // ─── 键鼠交互类 Handlers ───

    handlers.set('click', function (params) {
      params = paramsObject(params);
      if (typeof params.selector !== 'string' || !params.selector.trim()) {
        throw new Error('selector is required');
      }
      const selector = params.selector.trim();
      const dblClick = !!params.dblClick;
      const button = (params.button === 'right' || params.button === 'middle') ? params.button : 'left';

      return resolveTargetTabId(params).then(function (tabId) {
        return evalInTab(tabId, pageLocateAndScroll, [selector]).then(function (locateInfo) {
          if (!locateInfo || !locateInfo.found) {
            throw new Error('Element not found: ' + selector);
          }
          const x = locateInfo.x;
          const y = locateInfo.y;

          // 优先通过 CDP 派发硬件级鼠标点击
          if (cdpManager && typeof cdpManager.callDebuggerCommand === 'function') {
            return ensureDebuggerAttached(tabId).then(function () {
              return callDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
                type: 'mouseMoved',
                x: x,
                y: y
              });
            }).then(function () {
              return callDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
                type: 'mousePressed',
                x: x,
                y: y,
                button: button,
                clickCount: 1
              });
            }).then(function () {
              return callDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
                type: 'mouseReleased',
                x: x,
                y: y,
                button: button,
                clickCount: 1
              });
            }).then(function () {
              if (dblClick) {
                return callDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
                  type: 'mousePressed',
                  x: x,
                  y: y,
                  button: button,
                  clickCount: 2
                }).then(function () {
                  return callDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
                    type: 'mouseReleased',
                    x: x,
                    y: y,
                    button: button,
                    clickCount: 2
                  });
                });
              }
              return null;
            }).then(function () {
              return {
                success: true,
                tabId: tabId,
                selector: selector,
                dblClick: dblClick,
                point: { x: x, y: y },
                method: 'cdp'
              };
            }).catch(function () {
              // CDP 失败降级走页内 JS 派发
              return evalInTab(tabId, pageClickFallback, [selector, dblClick]).then(function () {
                return {
                  success: true,
                  tabId: tabId,
                  selector: selector,
                  dblClick: dblClick,
                  point: { x: x, y: y },
                  method: 'js'
                };
              });
            });
          }

          // 无 CDP 模式下直接 JS 触发
          return evalInTab(tabId, pageClickFallback, [selector, dblClick]).then(function () {
            return {
              success: true,
              tabId: tabId,
              selector: selector,
              dblClick: dblClick,
              point: { x: x, y: y },
              method: 'js'
            };
          });
        });
      });
    });

    handlers.set('clickAt', function (params) {
      params = paramsObject(params);
      const button = (params.button === 'right' || params.button === 'middle') ? params.button : 'left';
      const clickCount = (typeof params.clickCount === 'number' && params.clickCount > 0) ? params.clickCount : 1;

      return resolveTargetTabId(params).then(function (tabId) {
        let coordPromise;
        if (typeof params.selector === 'string' && params.selector.trim()) {
          const sel = params.selector.trim();
          coordPromise = evalInTab(tabId, pageLocateAndScroll, [sel]).then(function (info) {
            if (!info || !info.found) throw new Error('Element not found: ' + sel);
            return { x: info.x, y: info.y };
          });
        } else if (typeof params.x === 'number' && Number.isFinite(params.x) &&
                   typeof params.y === 'number' && Number.isFinite(params.y)) {
          if (params.x < 0 || params.y < 0) throw new Error('Coordinates must be non-negative');
          coordPromise = Promise.resolve({ x: Math.round(params.x), y: Math.round(params.y) });
        } else {
          throw new Error('Either selector or valid (x, y) coordinates are required');
        }

        return coordPromise.then(function (pt) {
          if (cdpManager && typeof cdpManager.callDebuggerCommand === 'function') {
            return ensureDebuggerAttached(tabId).then(function () {
              return callDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
                type: 'mouseMoved',
                x: pt.x,
                y: pt.y
              });
            }).then(function () {
              return callDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
                type: 'mousePressed',
                x: pt.x,
                y: pt.y,
                button: button,
                clickCount: clickCount
              });
            }).then(function () {
              return callDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
                type: 'mouseReleased',
                x: pt.x,
                y: pt.y,
                button: button,
                clickCount: clickCount
              });
            }).then(function () {
              return {
                success: true,
                tabId: tabId,
                x: pt.x,
                y: pt.y,
                button: button,
                clickCount: clickCount,
                method: 'cdp'
              };
            }).catch(function () {
              // JS 降级点击
              return evalInTab(tabId, function (px, py) {
                var el = document.elementFromPoint ? document.elementFromPoint(px, py) : null;
                if (el && typeof el.click === 'function') el.click();
                return true;
              }, [pt.x, pt.y]).then(function () {
                return {
                  success: true,
                  tabId: tabId,
                  x: pt.x,
                  y: pt.y,
                  button: button,
                  clickCount: clickCount,
                  method: 'js'
                };
              });
            });
          }

          return evalInTab(tabId, function (px, py) {
            var el = document.elementFromPoint ? document.elementFromPoint(px, py) : null;
            if (el && typeof el.click === 'function') el.click();
            return true;
          }, [pt.x, pt.y]).then(function () {
            return {
              success: true,
              tabId: tabId,
              x: pt.x,
              y: pt.y,
              button: button,
              clickCount: clickCount,
              method: 'js'
            };
          });
        });
      });
    });
    handlers.set('click_at', handlers.get('clickAt'));

    handlers.set('hover', function (params) {
      params = paramsObject(params);
      return resolveTargetTabId(params).then(function (tabId) {
        let coordPromise;
        if (typeof params.selector === 'string' && params.selector.trim()) {
          const sel = params.selector.trim();
          coordPromise = evalInTab(tabId, pageLocateAndScroll, [sel]).then(function (info) {
            if (!info || !info.found) throw new Error('Element not found: ' + sel);
            return { x: info.x, y: info.y, selector: sel };
          });
        } else if (typeof params.x === 'number' && Number.isFinite(params.x) &&
                   typeof params.y === 'number' && Number.isFinite(params.y)) {
          if (params.x < 0 || params.y < 0) throw new Error('Coordinates must be non-negative');
          coordPromise = Promise.resolve({ x: Math.round(params.x), y: Math.round(params.y), selector: null });
        } else {
          throw new Error('Either selector or valid (x, y) coordinates are required');
        }

        return coordPromise.then(function (target) {
          if (cdpManager && typeof cdpManager.callDebuggerCommand === 'function') {
            return ensureDebuggerAttached(tabId).then(function () {
              return callDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
                type: 'mouseMoved',
                x: target.x,
                y: target.y
              });
            }).then(function () {
              return {
                success: true,
                tabId: tabId,
                selector: target.selector,
                x: target.x,
                y: target.y,
                method: 'cdp'
              };
            }).catch(function () {
              return evalInTab(tabId, function (px, py) {
                var el = document.elementFromPoint ? document.elementFromPoint(px, py) : null;
                if (el) {
                  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, view: window }));
                  el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, view: window }));
                  el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, view: window }));
                }
                return true;
              }, [target.x, target.y]).then(function () {
                return {
                  success: true,
                  tabId: tabId,
                  selector: target.selector,
                  x: target.x,
                  y: target.y,
                  method: 'js'
                };
              });
            });
          }

          return evalInTab(tabId, function (px, py) {
            var el = document.elementFromPoint ? document.elementFromPoint(px, py) : null;
            if (el) {
              el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, view: window }));
              el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, view: window }));
              el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, view: window }));
            }
            return true;
          }, [target.x, target.y]).then(function () {
            return {
              success: true,
              tabId: tabId,
              selector: target.selector,
              x: target.x,
              y: target.y,
              method: 'js'
            };
          });
        });
      });
    });

    handlers.set('fill', function (params) {
      params = paramsObject(params);
      if (typeof params.selector !== 'string' || !params.selector.trim()) {
        throw new Error('selector is required');
      }
      if (params.value === undefined || params.value === null) {
        throw new Error('value is required');
      }
      const selector = params.selector.trim();
      const value = String(params.value);

      return resolveTargetTabId(params).then(function (tabId) {
        return evalInTab(tabId, pageFill, [selector, value]).then(function (fillRes) {
          if (!fillRes || !fillRes.found) {
            throw new Error('Element not found: ' + selector);
          }
          return {
            success: true,
            tabId: tabId,
            selector: selector,
            value: value,
            isSelect: !!fillRes.isSelect
          };
        });
      });
    });

    handlers.set('fillForm', function (params) {
      params = paramsObject(params);
      if (!Array.isArray(params.fields) || params.fields.length === 0) {
        throw new Error('fields must be a non-empty array');
      }
      const fields = params.fields;

      return resolveTargetTabId(params).then(function (tabId) {
        return evalInTab(tabId, pageFillForm, [fields]).then(function (results) {
          const resList = Array.isArray(results) ? results : [];
          return {
            success: true,
            tabId: tabId,
            filledCount: resList.length,
            results: resList
          };
        });
      });
    });
    handlers.set('fill_form', handlers.get('fillForm'));

    handlers.set('pressKey', function (params) {
      params = paramsObject(params);
      if (typeof params.key !== 'string' || !params.key.trim()) {
        throw new Error('key is required');
      }
      const rawKey = params.key.trim();
      const parts = rawKey.split('+');
      const mainKey = parts[parts.length - 1].trim();
      const modifiers = parts.slice(0, parts.length - 1).map(function (m) { return m.trim(); });

      const VK_MAP = {
        'Enter': 13,
        'Tab': 9,
        'Escape': 27,
        'Esc': 27,
        'Backspace': 8,
        'Delete': 46,
        'Space': 32,
        'ArrowLeft': 37,
        'ArrowUp': 38,
        'ArrowRight': 39,
        'ArrowDown': 40,
        'PageUp': 33,
        'PageDown': 34,
        'End': 35,
        'Home': 36
      };

      let modifiersMask = 0;
      for (let i = 0; i < modifiers.length; i++) {
        const m = modifiers[i].toLowerCase();
        if (m === 'alt') modifiersMask |= 1;
        else if (m === 'control' || m === 'ctrl') modifiersMask |= 2;
        else if (m === 'meta' || m === 'command' || m === 'cmd') modifiersMask |= 4;
        else if (m === 'shift') modifiersMask |= 8;
      }

      let vkCode = VK_MAP[mainKey];
      if (!vkCode && mainKey.length === 1) {
        vkCode = mainKey.toUpperCase().charCodeAt(0);
      }

      return resolveTargetTabId(params).then(function (tabId) {
        if (cdpManager && typeof cdpManager.callDebuggerCommand === 'function') {
          return ensureDebuggerAttached(tabId).then(function () {
            return callDebuggerCommand(tabId, 'Input.dispatchKeyEvent', {
              type: 'rawKeyDown',
              modifiers: modifiersMask,
              windowsVirtualKeyCode: vkCode || 0,
              key: mainKey,
              code: mainKey
            });
          }).then(function () {
            if (mainKey.length === 1 && modifiersMask === 0) {
              return callDebuggerCommand(tabId, 'Input.dispatchKeyEvent', {
                type: 'char',
                text: mainKey,
                key: mainKey
              });
            }
            return null;
          }).then(function () {
            return callDebuggerCommand(tabId, 'Input.dispatchKeyEvent', {
              type: 'keyUp',
              modifiers: modifiersMask,
              windowsVirtualKeyCode: vkCode || 0,
              key: mainKey,
              code: mainKey
            });
          }).then(function () {
            return {
              success: true,
              tabId: tabId,
              key: rawKey,
              mainKey: mainKey,
              modifiers: modifiers,
              method: 'cdp'
            };
          }).catch(function () {
            return evalInTab(tabId, pagePressKeyFallback, [rawKey]).then(function () {
              return {
                success: true,
                tabId: tabId,
                key: rawKey,
                mainKey: mainKey,
                modifiers: modifiers,
                method: 'js'
              };
            });
          });
        }

        return evalInTab(tabId, pagePressKeyFallback, [rawKey]).then(function () {
          return {
            success: true,
            tabId: tabId,
            key: rawKey,
            mainKey: mainKey,
            modifiers: modifiers,
            method: 'js'
          };
        });
      });
    });
    handlers.set('press_key', handlers.get('pressKey'));

    handlers.set('drag', function (params) {
      params = paramsObject(params);
      return resolveTargetTabId(params).then(function (tabId) {
        let fromPromise;
        if (typeof params.fromSelector === 'string' && params.fromSelector.trim()) {
          const fromSel = params.fromSelector.trim();
          fromPromise = evalInTab(tabId, pageLocateAndScroll, [fromSel]).then(function (info) {
            if (!info || !info.found) throw new Error('Source element not found: ' + fromSel);
            return { x: info.x, y: info.y };
          });
        } else if (params.from && typeof params.from.x === 'number' && typeof params.from.y === 'number') {
          fromPromise = Promise.resolve({ x: Math.round(params.from.x), y: Math.round(params.from.y) });
        } else {
          throw new Error('Either fromSelector or valid from: {x, y} is required');
        }

        let toPromise;
        if (typeof params.toSelector === 'string' && params.toSelector.trim()) {
          const toSel = params.toSelector.trim();
          toPromise = evalInTab(tabId, pageLocateAndScroll, [toSel]).then(function (info) {
            if (!info || !info.found) throw new Error('Target element not found: ' + toSel);
            return { x: info.x, y: info.y };
          });
        } else if (params.to && typeof params.to.x === 'number' && typeof params.to.y === 'number') {
          toPromise = Promise.resolve({ x: Math.round(params.to.x), y: Math.round(params.to.y) });
        } else {
          throw new Error('Either toSelector or valid to: {x, y} is required');
        }

        return Promise.all([fromPromise, toPromise]).then(function (pts) {
          const fromPt = pts[0];
          const toPt = pts[1];

          if (cdpManager && typeof cdpManager.callDebuggerCommand === 'function') {
            return ensureDebuggerAttached(tabId).then(function () {
              return callDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
                type: 'mouseMoved',
                x: fromPt.x,
                y: fromPt.y
              });
            }).then(function () {
              return callDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
                type: 'mousePressed',
                x: fromPt.x,
                y: fromPt.y,
                button: 'left',
                clickCount: 1
              });
            }).then(function () {
              return callDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
                type: 'mouseMoved',
                x: toPt.x,
                y: toPt.y,
                button: 'left'
              });
            }).then(function () {
              return callDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
                type: 'mouseReleased',
                x: toPt.x,
                y: toPt.y,
                button: 'left',
                clickCount: 1
              });
            }).then(function () {
              return {
                success: true,
                tabId: tabId,
                from: fromPt,
                to: toPt,
                method: 'cdp'
              };
            }).catch(function () {
              return {
                success: true,
                tabId: tabId,
                from: fromPt,
                to: toPt,
                method: 'fallback'
              };
            });
          }

          return {
            success: true,
            tabId: tabId,
            from: fromPt,
            to: toPt,
            method: 'fallback'
          };
        });
      });
    });
  }

  return {
    registerDomHandlers: registerDomHandlers
  };
});
