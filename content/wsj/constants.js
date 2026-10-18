/**
 * wsj 常量定义
 */
(function() {
    window.__wsj = window.__wsj || {};

    // 最大重试次数
    var MAX_RETRY_COUNT = 3;

    // 重试延迟 (ms)
    var RETRY_DELAY = 5000;

    // 请求超时时间 (ms)
    var TIMEOUT = 120000;

    // 请求选项配置
    var Options = {
        timeout: TIMEOUT,
        credentials: 'include',
        headers: {
            'Accept': '*/*',
        },
    };

    window.__wsj.MAX_RETRY_COUNT = MAX_RETRY_COUNT;
    window.__wsj.RETRY_DELAY = RETRY_DELAY;
    window.__wsj.TIMEOUT = TIMEOUT;
    window.__wsj.Options = Options;
})();
