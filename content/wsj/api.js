/**
 * wsj API 调用函数
 */
window.__wsj = window.__wsj || {};

(function() {
    var Endpoints = window.__wsj.Endpoints;
    window.__wsj.accessToken = "";

/**
     * 2. 抓取文章详细元数据 (Article_Info)
     * 从 __NEXT_DATA__ JSON 中提取结构化数据，比 HTML 解析更可靠
     */
    async function getArticleInfo(params) {
        try {
            var text = await fetchGet(params.url, {}, window.__wsj.Options.headers, window.__wsj.Options);
            var parser = new DOMParser();
            var doc = parser.parseFromString(text, 'text/html');
            var data_ele = doc.querySelector('script#__NEXT_DATA__').textContent;
            var data = JSON.parse(data_ele);
            var url = params.url;

            // 从 JSON 中提取文章数据
            var articleData = data.props?.pageProps?.articleData;
            if (!articleData) {
                throw new Error('Article data not found in __NEXT_DATA__');
            }

            // 唯一 ID
            var artId = articleData.originId || articleData.id || "";
            if (!artId) {
                var urlObj = new URL(url);
                var path = urlObj.pathname;
                var match = path.match(/-([a-f0-9]+)$/);
                if (match) {
                    artId = match[1];
                }
            }

            // 标题
            var title = articleData.headline?.text || articleData.originalHeadline?.text || "";

            // 短标题/导语
            var shortTitle = articleData.standFirst?.content?.text || "";

            // 作者列表 - 从 JSON 结构化数据提取
            var author = [];
            if (articleData.authors && Array.isArray(articleData.authors)) {
                articleData.authors.forEach(function(a) {
                    var name = a.text || (a.content?.byline) || "";
                    if (name && !author.some(function(existing) { return existing.User_Nm === name; })) {
                        author.push({
                            "User_Nm": name,
                            "User_URL": a.content?.linkedin ? "https://" + a.content.linkedin : ""
                        });
                    }
                });
            }

            // 兜底：如果 JSON 中没有作者，尝试从 byline 数组提取
            if (author.length === 0 && articleData.byline && Array.isArray(articleData.byline)) {
                articleData.byline.forEach(function(b) {
                    if (b.type === 'author' && b.text && !author.some(function(existing) { return existing.User_Nm === b.text; })) {
                        author.push({
                            "User_Nm": b.text,
                            "User_URL": b.linkedin ? "https://" + b.linkedin : ""
                        });
                    }
                });
            }

            // 绝对发布时间
            var artTime = articleData.publishedDateTimeUtc || articleData.liveDateTimeUtc || "";

            // 主分类和次分类标签
            var tag1 = articleData.page || articleData.sectionName || "";
            var tag2 = articleData.sectionName || articleData.pageSubsection || "";

            // 评论数 - 从 tracking meta 获取
            // var commentsCount = doc.querySelector("a[aria-label='Comments Button']").textContent || '0';

            // 文章正文内容 - 从 flattenedBody 提取
            var content = extractContentFromFlattenedBody(articleData.flattenedBody);

            return {
                article: {
                    Art_ID: artId,
                    Art_Title: title,
                    Art_TItle_Short: shortTitle,
                    Art_Time: artTime,
                    Art_Tag_1: tag1,
                    Art_Tag_2: tag2,
                    Comments_Count: 0,
                    Art_URL: url,
                    Art_Content: content
                },
                author: author
            };
        } catch(e) {
            throw new Error(e.message || String(e));
        }
    }

    /**
     * 从 flattenedBody 数组提取纯文本内容
     * @param {Array} flattenedBody - 文章正文数组
     * @returns {string} 提取的文本内容
     */
    function extractContentFromFlattenedBody(flattenedBody) {
        if (!flattenedBody || !Array.isArray(flattenedBody)) {
            return "";
        }

        var texts = [];

        flattenedBody.forEach(function(block) {
            if (!block) return;

            // 段落文本
            if (block.__typename === 'ParagraphArticleBody' && block.content && Array.isArray(block.content)) {
                block.content.forEach(function(item) {
                    if (item.text) {
                        texts.push(item.text);
                    }
                });
            }
            // 图片 caption
            else if (block.__typename === 'ImageArticleBody') {
                if (block.caption) {
                    texts.push('[Image: ' + block.caption + ']');
                }
                if (block.richTextCaption?.nested) {
                    block.richTextCaption.nested.forEach(function(n) {
                        if (n.text) texts.push(n.text);
                    });
                }
            }
            // 引用/其他块类型
            else if (block.content && Array.isArray(block.content)) {
                block.content.forEach(function(item) {
                    if (item.text) texts.push(item.text);
                });
            }
        });

        return texts.join('\n\n').trim();
    }

    /**
     * 从 localStorage 获取 Spot.im x-access-token
     * @returns {string|null} JWT token 或 null
     */
    function getSpotimAccessToken() {
        try {
            var storage = localStorage.getItem('ow/social-browser-storage');
            if (storage) {
                var arr = JSON.parse(storage);
                for (var i = 0; i < arr.length; i++) {
                    if (arr[i][0] === 'DS') {
                        window.__wsj.accessToken = arr[i][1];
                        return window.__wsj.accessToken;
                    }
                }
            }
        } catch (e) {
            console.warn("[WSJ Extractor] Failed to get Spotim token:", e);
        }
        return null;
    }

    /**
     * 3. 抓取评论及回复详情 (Comment_Info)
     * @param {Object} params - 参数对象
     * @param {string} params.artId - 文章 ID（必填）
     * @param {string} [params.parentId] - 父评论 ID（可选，用于获取回复）
     * @param {string} [params.conversationId] - 会话 ID（可选，格式：sp_xxx_WP-WSJ-xxx）
     * @param {number} [params.offset=0] - 分页偏移量
     * @param {number} [params.count=25] - 每页数量
     * @param {number} [params.depth=2] - 评论深度
     * @param {number} [params.childCount=1] - 子评论数量
     */
    async function getCommentInfo(params) {
        params = params || {};
        try {

            var parentId = params.parentId || "";
            var conversationId = params.conversationId || "";
            var offset = params.offset || 0;
            var count = params.count || 25;
            var depth = params.depth || 2;
            var childCount = params.childCount || 1;

            // 构建 postId
            var postId = params.postId || "";
            var spotId = "sp_92LbaOI5";
            var apiUrl;
            var bodyData;
            
            // 自动获取 x-access-token
            var accessToken = window.__wsj.accessToken || getSpotimAccessToken();
            
            var headers = {
                'accept': 'application/json',
                'content-type': 'application/json',
                'origin': 'https://www.wsj.com',
                'referer': 'https://www.wsj.com/',
                'x-post-id': postId,
                'x-spot-id': spotId
            };
            
            // 添加 x-access-token 如果可用
            if (accessToken) {
                headers['x-access-token'] = accessToken;
            } else {
                console.warn("[WSJ Extractor] x-access-token not found in localStorage, API may fail");
            }
            apiUrl = "https://api-2-0.spot.im/v1.0.0/conversation/read";
            bodyData = {
                "count": count,
                "offset": offset,
                "sort_by": "likes_newest",
                "child_count": childCount,
            };
            // 根据是否有 parentId 决定调用哪个 API
            if (parentId) {
                // 获取回复
                bodyData.parent_id = parentId;
                bodyData.child_count = childCount;
            } else {
                bodyData.depth = depth;
            }
            if (conversationId){
                bodyData.conversation_id = conversationId;
            }

            var resJson = await fetchPost(apiUrl, bodyData, headers, window.__wsj.Options);
            return resJson;
        } catch (apiErr) {
            console.warn("[WSJ Extractor] Spot.im API failed:", apiErr);
            throw apiErr;
        }
    }

    /**
     * 4. 抓取评论用户主页资料 (User_Info)
     */
    async function getUserInfo(params) {
        try {
                var html = params.html;
                var doc = document;
                if (params.url) {
                    var text = await fetchGet(params.url, {}, window.__wsj.Options.headers, window.__wsj.Options);
                    var parser = new DOMParser();
                    doc = parser.parseFromString(text, 'text/html');
                } else if (html) {
                    var parser = new DOMParser();
                    doc = parser.parseFromString(html, 'text/html');
                }
                
                var url = params.url || window.location.href;
                
                var userId = "";
                var urlObj = new URL(url);
                var path = urlObj.pathname;
                var m = path.match(/\/profile\/([a-zA-Z0-9_-]+)/);
                if (m) {
                    userId = m[1];
                }
                
                var userNm = "";
                var nameEl = doc.querySelector('.profile-name, .user-name, h1, [data-testid="profile-name"]');
                if (nameEl) userNm = nameEl.innerText.trim();
                
                var userPosts = 0;
                var postsEl = doc.querySelector('.post-count, .user-posts, [data-testid="profile-posts-count"]');
                if (postsEl) {
                    var pNum = parseInt(postsEl.innerText.replace(/[^0-9]/g, ''), 10);
                    if (!isNaN(pNum)) userPosts = pNum;
                }
                
                var userLikes = 0;
                var likesEl = doc.querySelector('.likes-count, .user-likes, [data-testid="profile-likes-count"]');
                if (likesEl) {
                    var lNum = parseInt(likesEl.innerText.replace(/[^0-9]/g, ''), 10);
                    if (!isNaN(lNum)) userLikes = lNum;
                }
                
                return {
                    success: true,
                    data: {
                        User_ID: userId,
                        User_Nm: userNm,
                        User_Posts: userPosts,
                        User_Likes: userLikes,
                        User_Url: url
                    }
                };
            } catch(e) {
                throw new Error(e.message || String(e));
            }
    }

    /**
     * 5. 抓取评论用户历史发帖 (User_Post_Info)
     */
    async function getUserPostInfo(params) {
        try {
                var html = params.html;
                var doc = document;
                if (params.url) {
                    var text = await fetchGet(params.url, {}, window.__wsj.Options.headers, window.__wsj.Options);
                    var parser = new DOMParser();
                    doc = parser.parseFromString(text, 'text/html');
                } else if (html) {
                    var parser = new DOMParser();
                    doc = parser.parseFromString(html, 'text/html');
                }
                
                var posts = [];
                var userId = params.userId || "";
                var userNm = params.userNm || "";
                if (!userId) {
                    var url = params.url || window.location.href;
                    var urlObj = new URL(url);
                    var m = urlObj.pathname.match(/\/profile\/([a-zA-Z0-9_-]+)/);
                    if (m) userId = m[1];
                }
                if (!userNm) {
                    var nameEl = doc.querySelector('.profile-name, .user-name, h1, [data-testid="profile-name"]');
                    if (nameEl) userNm = nameEl.innerText.trim();
                }
                
                var postCards = doc.querySelectorAll('.profile-comment-card, .user-comment-card, [data-testid="profile-comment"]');
                postCards.forEach(card => {
                    var artTitleEl = card.querySelector('.comment-article-title, a[href*="/articles/"], [data-testid="article-title"]');
                    var postArtTitle = artTitleEl ? artTitleEl.innerText.trim() : "";
                    var postArtId = "";
                    if (artTitleEl) {
                        var href = artTitleEl.getAttribute('href') || "";
                        var artMatch = href.match(/-([a-f0-9]+)$/);
                        if (artMatch) postArtId = artMatch[1];
                    }
                    
                    var textEl = card.querySelector('.comment-text, .comment-body, [data-testid="comment-body"]');
                    var postText = textEl ? textEl.innerText.trim() : "";
                    
                    var rplyEl = card.querySelector('.reply-to, .replied-to, [data-testid="reply-to"]');
                    var postRply = rplyEl ? rplyEl.innerText.trim() : "";
                    
                    var rply2UserId = "";
                    var rply2UserNm = "";
                    if (rplyEl) {
                        var linkEl = rplyEl.querySelector('a[href*="/profile/"]');
                        if (linkEl) {
                            rply2UserNm = linkEl.innerText.trim();
                            var href = linkEl.getAttribute('href') || "";
                            var uMatch = href.match(/\/profile\/([a-zA-Z0-9_-]+)/);
                            if (uMatch) rply2UserId = uMatch[1];
                        } else {
                            var matchName = postRply.match(/Replied to\s+(.+)/i);
                            if (matchName) rply2UserNm = matchName[1].trim();
                        }
                    }
                    
                    var timeEl = card.querySelector('.comment-time, time, [data-testid="comment-time"]');
                    var postTime = "";
                    if (timeEl) {
                        postTime = timeEl.getAttribute('datetime') || timeEl.innerText.trim();
                        postTime = window.__wsj.parseRelativeTime(postTime);
                    }
                    
                    if (postText || postArtTitle) {
                        posts.push({
                            User_ID: userId,
                            User_Nm: userNm,
                            Post_Art_Title: postArtTitle,
                            Post_Art_ID: postArtId,
                            Post_Text: postText,
                            Post_Rply: postRply,
                            Rply2_User_ID: rply2UserId,
                            Rply2_User_Nm: rply2UserNm,
                            Post_Time: postTime
                        });
                    }
                });
                
                return { success: true, data: posts };
            } catch(e) {
                throw new Error(e.message || String(e));
            }
    }

    /**
     * 6. 合并抓取归档新闻 API (Archive_Articles)
     * 支持传参过滤：
     * - params.year (可选，如 "2026"。不传则抓取所有年份)
     * - params.month (可选，如 "05" 或 "march"。不传则抓取对应年份下的所有月份)
     * - params.delayMs (可选，请求间隔延迟，默认 1000ms)
     */
    async function getArchiveArticles(params) {
        try {
            params = params || {};
            var year = params.year;
            var month = params.month;
            var delay = params.delay;
            var fullUrl = `https://www.wsj.com/news/archive/${year}/${month}/${delay}`;
            
            var text = await fetchGet(fullUrl, {}, null, window.__wsj.Options);
            var parser = new DOMParser();
            var doc = parser.parseFromString(text, 'text/html');
            var allArticles = [];
            
            // 尝试获取 <script id="__NEXT_DATA__" type="application/json">
            var scriptEl = doc.getElementById('__NEXT_DATA__') || doc.querySelector('script[id="__NEXT_DATA__"]');
            if (scriptEl) {
                var jsonText = (scriptEl.innerHTML || scriptEl.textContent || '').trim();
                if (jsonText) {
                    var nextData = null;
                    try {
                        nextData = JSON.parse(jsonText);
                    } catch (e) {
                        try {
                            // 按照用户要求使用 eval 方式解析
                            nextData = eval('(' + jsonText + ')');
                        } catch (evalErr) {
                            try {
                                // 尝试通过 var 声明赋值进行 eval
                                eval('var __NEXT_DATA__ = ' + jsonText);
                                nextData = __NEXT_DATA__;
                            } catch (err2) {
                                console.error('Failed to parse __NEXT_DATA__:', err2);
                            }
                        }
                    }
                    
                    if (nextData && nextData.props && nextData.props.pageProps && nextData.props.pageProps.newsArchiveArticles) {
                        allArticles = nextData.props.pageProps.newsArchiveArticles;
                    }
                }
            }
            
            // 兜底：如果 __NEXT_DATA__ 中没有获取到数据，则使用原有的 CSS 选择器提取
            if (!allArticles || allArticles.length === 0) {
                allArticles = [];
                doc.querySelectorAll("h3.css-fsvegl a").forEach(el => {
                    if (el.href) {
                        allArticles.push(el.href);
                    }
                });
            }
            
            return { data: allArticles };
        } catch (e) {
            throw new Error(e.message || String(e));
        }
    }

    // 导出到命名空间
    window.__wsj.getArticleInfo = getArticleInfo;
    window.__wsj.getCommentInfo = getCommentInfo;
    window.__wsj.getUserInfo = getUserInfo;
    window.__wsj.getUserPostInfo = getUserPostInfo;
    window.__wsj.getArchiveArticles = getArchiveArticles;
})();
