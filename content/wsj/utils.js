/**
 * wsj 工具函数
 */
window.__wsj = window.__wsj || {};

// window.__wsj.parser = new DOMParser();
/**
 * 相对时间转换为绝对时间的 ISO 字符串 (本地时间或指定时区，此处默认转为当前系统时区或直接输出绝对日期)
 * 格式：YYYY-MM-DD HH:mm:ss
 */
window.__wsj.parseRelativeTime = function(relativeTimeStr) {
    if (!relativeTimeStr) return "";
    
    // 如果本身已经是绝对时间格式（如 Updated April 14, 2025 5:28 pm ET），尝试直接解析或直接返回原样
    if (relativeTimeStr.includes("Updated") || relativeTimeStr.includes("201") || relativeTimeStr.includes("202")) {
        return relativeTimeStr;
    }
    
    var now = new Date();
    var match;
    
    // 匹配 "X minutes ago" 或 "Xm ago"
    match = relativeTimeStr.match(/(\d+)\s*(?:minutes?|m)\s*ago/i);
    if (match) {
        var minutes = parseInt(match[1], 10);
        now.setMinutes(now.getMinutes() - minutes);
        return window.__wsj.formatDate(now);
    }
    
    // 匹配 "X hours ago" 或 "Xh ago"
    match = relativeTimeStr.match(/(\d+)\s*(?:hours?|h)\s*ago/i);
    if (match) {
        var hours = parseInt(match[1], 10);
        now.setHours(now.getHours() - hours);
        return window.__wsj.formatDate(now);
    }
    
    // 匹配 "X days ago" 或 "Xd ago"
    match = relativeTimeStr.match(/(\d+)\s*(?:days?|d)\s*ago/i);
    if (match) {
        var days = parseInt(match[1], 10);
        now.setDate(now.getDate() - days);
        return window.__wsj.formatDate(now);
    }

    return relativeTimeStr;
};

/**
 * 格式化日期对象为 YYYY-MM-DD HH:mm:ss
 */
window.__wsj.formatDate = function(date) {
    var y = date.getFullYear();
    var m = String(date.getMonth() + 1).padStart(2, '0');
    var d = String(date.getDate()).padStart(2, '0');
    var hh = String(date.getHours()).padStart(2, '0');
    var mm = String(date.getMinutes()).padStart(2, '0');
    var ss = String(date.getSeconds()).padStart(2, '0');
    return y + '-' + m + '-' + d + ' ' + hh + ':' + mm + ':' + ss;
};
