// ==UserScript==
// @name         Linux.do 自动浏览助手
// @namespace    http://tampermonkey.net/
// @version      1.5.0
// @description  自动浏览 Linux.do 帖子，支持所有页码浏览和精确去重，新增跳过帖子功能
// @author       Linux.Do@caanyying
// @match        https://linux.do/
// @match        https://linux.do/new
// @match        https://linux.do/latest
// @match        https://linux.do/unread
// @match        https://linux.do/c/*
// @match        https://linux.do/t/topic/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        GM_log
// @grant        GM_openInTab
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // 配置管理类
    class ConfigManager {
        constructor() {
            this.defaultConfig = {
                minStayTime: 5,
                maxStayTime: 10,
                enableAutoBrowse: true,
                hotkeyPause: 'F2',
                hotkeySkip: 'F3',
                enableLogging: true,
                useNewTab: false,
                autoRedirect: true,
                checkUnread: true,
                // 新增跳过帖子配置
                skippedPosts: [], // 存储要跳过的帖子URL
                skippedKeywords: [], // 存储要跳过的帖子标题关键词
                skipRedirects: true, // 是否自动跳过重定向
                skipExternalLinks: true, // 是否跳过包含外部链接的帖子
                externalLinkDomains: ['idcflare.com'], // 需要跳过的外部域名列表
                // 新增配置
                minNewPosts: 5, // /new页面最少帖子数，低于此数时从/unread跳转
                enableLike: true, // 是否启用点赞功能
                likeProbability: 0.3, // 点赞概率（0-1之间）
                redirectPatterns: [
                    { from: /linux\.do\/t\/topic\/1164403/, to: /idcflare\.com/ } // 特殊重定向模式
                ]
            };
        }

        getConfig() {
            const savedConfig = GM_getValue('linuxDoConfig');
            return { ...this.defaultConfig, ...savedConfig };
        }

        saveConfig(config) {
            GM_setValue('linuxDoConfig', config);
        }

        resetConfig() {
            GM_setValue('linuxDoConfig', this.defaultConfig);
            return this.defaultConfig;
        }

        // 添加跳过的帖子
        addSkippedPost(url) {
            const config = this.getConfig();
            if (!config.skippedPosts.includes(url)) {
                config.skippedPosts.push(url);
                this.saveConfig(config);
                return true;
            }
            return false;
        }

        // 移除跳过的帖子
        removeSkippedPost(url) {
            const config = this.getConfig();
            const index = config.skippedPosts.indexOf(url);
            if (index > -1) {
                config.skippedPosts.splice(index, 1);
                this.saveConfig(config);
                return true;
            }
            return false;
        }

        // 添加跳过的关键词
        addSkippedKeyword(keyword) {
            const config = this.getConfig();
            if (!config.skippedKeywords.includes(keyword)) {
                config.skippedKeywords.push(keyword);
                this.saveConfig(config);
                return true;
            }
            return false;
        }

        // 移除跳过的关键词
        removeSkippedKeyword(keyword) {
            const config = this.getConfig();
            const index = config.skippedKeywords.indexOf(keyword);
            if (index > -1) {
                config.skippedKeywords.splice(index, 1);
                this.saveConfig(config);
                return true;
            }
            return false;
        }

        // 添加外部域名
        addExternalDomain(domain) {
            const config = this.getConfig();
            if (!config.externalLinkDomains.includes(domain)) {
                config.externalLinkDomains.push(domain);
                this.saveConfig(config);
                return true;
            }
            return false;
        }

        // 移除外部域名
        removeExternalDomain(domain) {
            const config = this.getConfig();
            const index = config.externalLinkDomains.indexOf(domain);
            if (index > -1) {
                config.externalLinkDomains.splice(index, 1);
                this.saveConfig(config);
                return true;
            }
            return false;
        }
    }

    // 日志管理类
    class Logger {
        constructor(configManager) {
            this.configManager = configManager;
            this.logs = [];
            this.maxLogs = 100;
        }

        log(level, message, data = null) {
            const timestamp = new Date().toISOString();
            const logEntry = {
                timestamp,
                level,
                message,
                data
            };

            this.logs.unshift(logEntry);
            if (this.logs.length > this.maxLogs) {
                this.logs.pop();
            }

            const config = this.configManager.getConfig();
            if (config.enableLogging) {
                const consoleMessage = `[Linux.do AutoBrowse ${timestamp}] ${level}: ${message}`;
                switch (level) {
                    case 'ERROR':
                        console.error(consoleMessage, data);
                        break;
                    case 'WARN':
                        console.warn(consoleMessage, data);
                        break;
                    case 'INFO':
                        console.info(consoleMessage, data);
                        break;
                    default:
                        console.log(consoleMessage, data);
                }

                GM_log(consoleMessage);
            }

            // 更新日志显示
            this.updateLogDisplay();
        }

        updateLogDisplay() {
            const logContainer = document.getElementById('linuxDoLogs');
            if (logContainer) {
                logContainer.innerHTML = this.logs.map(log =>
                    `<div class="log-entry log-${log.level.toLowerCase()}">
                        <span class="log-time">${new Date(log.timestamp).toLocaleTimeString()}</span>
                        <span class="log-level">${log.level}</span>
                        <span class="log-message">${log.message}</span>
                        ${log.data ? `<span class="log-data">${JSON.stringify(log.data)}</span>` : ''}
                    </div>`
                ).join('');
            }
        }

        getLogs() {
            return this.logs;
        }

        clearLogs() {
            this.logs = [];
            this.updateLogDisplay();
        }
    }

    // 帖子管理类
    class PostManager {
        constructor(configManager, logger) {
            this.configManager = configManager;
            this.logger = logger;
            // 使用完整URL作为已访问记录，确保精确去重
            this.visitedPosts = new Set(GM_getValue('visitedPosts', []));
            this.currentPostId = null;
            this.timer = null;
            this.isPaused = false;
            this.currentTab = null;
            this.redirectCheckInterval = null;
        }

        // 提取帖子基础ID（用于日志显示）
        extractBasePostId(url) {
            try {
                const match = url.match(/\/t\/topic\/(\d+)/);
                return match ? match[1] : null;
            } catch (error) {
                this.logger.log('ERROR', '提取帖子ID失败', { url, error: error.message });
                return null;
            }
        }

        // 检查帖子页码
        getPostPageNumber(url) {
            try {
                const match = url.match(/\/t\/topic\/\d+\/(\d+)/);
                return match ? parseInt(match[1]) : 1;
            } catch (error) {
                this.logger.log('ERROR', '提取帖子页码失败', { url, error: error.message });
                return 1;
            }
        }

        // 检查是否已访问过（精确匹配完整URL）
        isPostVisited(url) {
            return this.visitedPosts.has(url);
        }

        // 标记帖子为已访问（使用完整URL）
        markPostAsVisited(url) {
            this.visitedPosts.add(url);
            GM_setValue('visitedPosts', Array.from(this.visitedPosts));
            const baseId = this.extractBasePostId(url);
            this.logger.log('INFO', `标记帖子为已访问`, { baseId, url, page: this.getPostPageNumber(url) });
        }

        // 检查帖子是否包含外部链接
        hasExternalLinks(linkElement) {
            const config = this.configManager.getConfig();
            if (!config.skipExternalLinks || !linkElement) return false;

            try {
                // 查找同一行或相邻元素中的外部链接
                let parent = linkElement.parentElement;
                let currentElement = linkElement;

                // 向上查找最多3级父元素
                for (let i = 0; i < 3 && parent; i++) {
                    // 检查父元素内的所有链接
                    const links = parent.querySelectorAll('a[href]');
                    for (const a of links) {
                        const href = a.href;
                        for (const domain of config.externalLinkDomains) {
                            if (href.includes(domain)) {
                                this.logger.log('INFO', '检测到外部链接', {
                                    href,
                                    domain,
                                    linkText: a.textContent.trim()
                                });
                                return true;
                            }
                        }
                    }
                    parent = parent.parentElement;
                }

                // 检查兄弟元素
                let sibling = linkElement.nextElementSibling;
                while (sibling) {
                    if (sibling.tagName === 'A') {
                        const href = sibling.href;
                        for (const domain of config.externalLinkDomains) {
                            if (href.includes(domain)) {
                                this.logger.log('INFO', '检测到兄弟元素中的外部链接', {
                                    href,
                                    domain,
                                    linkText: sibling.textContent.trim()
                                });
                                return true;
                            }
                        }
                    }
                    sibling = sibling.nextElementSibling;
                }

                return false;
            } catch (error) {
                this.logger.log('ERROR', '检查外部链接时出错', { error: error.message });
                return false;
            }
        }

        // 检查帖子元素是否匹配跳过条件
        shouldSkipByElement(linkElement) {
            const config = this.configManager.getConfig();
            if (!linkElement) return false;

            try {
                // 获取完整的HTML内容进行匹配
                const elementHTML = linkElement.outerHTML;
                const elementText = linkElement.textContent.trim();

                // 检查URL匹配
                for (const skippedUrl of config.skippedPosts) {
                    if (elementHTML.includes(skippedUrl) || elementText.includes(skippedUrl)) {
                        this.logger.log('INFO', '帖子元素包含跳过URL', {
                            skippedUrl,
                            elementText: elementText.substring(0, 100)
                        });
                        return true;
                    }

                    // 检查帖子ID匹配
                    const postId = this.extractBasePostId(linkElement.href);
                    const skippedPostId = this.extractBasePostId(skippedUrl);
                    if (postId && skippedPostId && postId === skippedPostId) {
                        this.logger.log('INFO', '帖子元素ID匹配跳过列表', {
                            postId,
                            skippedPostId,
                            elementText: elementText.substring(0, 100)
                        });
                        return true;
                    }
                }

                // 检查关键词匹配
                for (const keyword of config.skippedKeywords) {
                    if (elementText.toLowerCase().includes(keyword.toLowerCase())) {
                        this.logger.log('INFO', '帖子元素包含跳过关键词', {
                            keyword,
                            elementText: elementText.substring(0, 100)
                        });
                        return true;
                    }
                }

                return false;
            } catch (error) {
                this.logger.log('ERROR', '检查帖子元素时出错', { error: error.message });
                return false;
            }
        }

        // 检查是否应该跳过帖子（优先级最高）
        shouldSkipPost(url, title = null, linkElement = null) {
            const config = this.configManager.getConfig();

            this.logger.log('INFO', '检查帖子是否应该跳过', {
                url,
                title,
                skippedPostsCount: config.skippedPosts.length,
                skippedKeywordsCount: config.skippedKeywords.length,
                skipExternalLinks: config.skipExternalLinks,
                externalLinkDomains: config.externalLinkDomains
            });

            // 首先检查URL是否在跳过列表中
            for (const skippedUrl of config.skippedPosts) {
                // 精确匹配
                if (url === skippedUrl) {
                    this.logger.log('INFO', '帖子URL精确匹配跳过列表，跳过', { url, skippedUrl });
                    return true;
                }

                // 包含匹配（支持部分URL）
                if (url.includes(skippedUrl) || skippedUrl.includes(url)) {
                    this.logger.log('INFO', '帖子URL包含匹配跳过列表，跳过', { url, skippedUrl });
                    return true;
                }

                // 提取帖子ID进行匹配
                const postId = this.extractBasePostId(url);
                const skippedPostId = this.extractBasePostId(skippedUrl);
                if (postId && skippedPostId && postId === skippedPostId) {
                    this.logger.log('INFO', '帖子ID匹配跳过列表，跳过', { url, skippedUrl, postId, skippedPostId });
                    return true;
                }
            }

            // 检查标题是否包含跳过关键词
            if (title && config.skippedKeywords.length > 0) {
                for (const keyword of config.skippedKeywords) {
                    if (title.toLowerCase().includes(keyword.toLowerCase())) {
                        this.logger.log('INFO', '帖子标题包含跳过关键词，跳过', { url, title, keyword });
                        return true;
                    }
                }
            }

            // 检查帖子元素是否匹配跳过条件
            if (linkElement && this.shouldSkipByElement(linkElement)) {
                this.logger.log('INFO', '帖子元素匹配跳过条件，跳过', { url, title });
                return true;
            }

            // 检查是否包含外部链接
            if (linkElement && this.hasExternalLinks(linkElement)) {
                this.logger.log('INFO', '帖子包含外部链接，跳过', { url, title });
                return true;
            }

            // 检查是否是已知的重定向帖子
            for (const pattern of config.redirectPatterns) {
                if (pattern.from.test(url)) {
                    this.logger.log('INFO', '检测到已知重定向帖子，跳过', { url, pattern });
                    return true;
                }
            }

            this.logger.log('INFO', '帖子不需要跳过', { url, title });
            return false;
        }

        // 随机点赞帖子
        async likePost() {
            const config = this.configManager.getConfig();
            if (!config.enableLike) return;

            // 根据概率决定是否点赞
            if (Math.random() > config.likeProbability) {
                this.logger.log('INFO', '随机概率未达到，不点赞');
                return;
            }

            try {
                // 查找点赞按钮
                const likeButton = document.querySelector('.discourse-reactions-reaction-button[title*="点赞"], .discourse-reactions-reaction-button[title*="Like"]');

                if (likeButton) {
                    // 检查是否已经点赞
                    const isLiked = likeButton.classList.contains('reacted') ||
                                   likeButton.getAttribute('aria-pressed') === 'true';

                    if (!isLiked) {
                        this.logger.log('INFO', '执行点赞操作');
                        likeButton.click();

                        // 显示通知
                        GM_notification({
                            text: '已点赞帖子',
                            title: 'Linux.do 自动浏览',
                            timeout: 1000
                        });
                    } else {
                        this.logger.log('INFO', '帖子已点赞，跳过');
                    }
                } else {
                    this.logger.log('WARN', '未找到点赞按钮');
                }
            } catch (error) {
                this.logger.log('ERROR', '点赞操作失败', { error: error.message });
            }
        }

        // 获取随机停留时间
        getRandomStayTime() {
            const config = this.configManager.getConfig();
            return Math.floor(Math.random() * (config.maxStayTime - config.minStayTime + 1)) + config.minStayTime;
        }

        // 在新标签页打开帖子
        openPostInNewTab(url) {
            this.logger.log('INFO', '在新标签页打开帖子', { url });
            this.currentTab = GM_openInTab(url, {
                active: true,
                insert: true,
                setParent: false
            });
        }

        // 设置重定向检测
        setupRedirectDetection() {
            const config = this.configManager.getConfig();
            if (!config.skipRedirects) return;

            // 清除之前的检测
            if (this.redirectCheckInterval) {
                clearInterval(this.redirectCheckInterval);
            }

            // 定期检查是否发生重定向
            this.redirectCheckInterval = setInterval(() => {
                const currentUrl = window.location.href;

                // 检查是否跳转到了非linux.do域名
                if (!currentUrl.includes('linux.do')) {
                    this.logger.log('INFO', '检测到外部重定向，返回新帖子页面', { currentUrl });
                    this.returnToNewPage();
                    return;
                }

                // 检查特定的重定向模式
                for (const pattern of config.redirectPatterns) {
                    if (pattern.to.test(currentUrl)) {
                        this.logger.log('INFO', '检测到目标重定向页面，返回新帖子页面', { currentUrl });
                        this.returnToNewPage();
                        return;
                    }
                }
            }, 500); // 每500ms检查一次
        }

        // 开始浏览当前帖子
        async startBrowsingPost() {
            if (this.isPaused) {
                this.logger.log('INFO', '脚本已暂停，等待恢复');
                return;
            }

            const currentUrl = window.location.href;
            const baseId = this.extractBasePostId(currentUrl);

            if (!baseId) {
                this.logger.log('ERROR', '无法识别当前页面为有效帖子');
                this.returnToNewPage();
                return;
            }

            // 获取帖子标题
            const titleElement = document.querySelector('h1');
            const title = titleElement ? titleElement.textContent.trim() : null;

            // 立即检查是否应该跳过（最高优先级）
            if (this.shouldSkipPost(currentUrl, title)) {
                this.logger.log('INFO', '帖子应该跳过，立即返回', { url: currentUrl, title });
                this.returnToNewPage();
                return;
            }

            // 设置重定向检测
            this.setupRedirectDetection();

            // 检查是否已访问过（精确URL匹配）
            if (this.isPostVisited(currentUrl)) {
                this.logger.log('INFO', '检测到重复帖子链接，立即返回', { url: currentUrl });
                this.returnToNewPage();
                return;
            }

            this.currentPostId = baseId;
            this.markPostAsVisited(currentUrl);

            // 执行随机点赞
            await this.likePost();

            const stayTime = this.getRandomStayTime();
            this.logger.log('INFO', `开始浏览帖子，将在 ${stayTime} 秒后返回`, {
                postId: baseId,
                stayTime,
                currentUrl,
                pageNumber: this.getPostPageNumber(currentUrl),
                title
            });

            this.timer = setTimeout(() => {
                this.returnToNewPage();
            }, stayTime * 1000);
        }

        // 返回到新帖子页面
        returnToNewPage() {
            this.logger.log('INFO', '返回新帖子页面');

            // 清除重定向检测
            if (this.redirectCheckInterval) {
                clearInterval(this.redirectCheckInterval);
                this.redirectCheckInterval = null;
            }

            const config = this.configManager.getConfig();
            if (config.useNewTab && this.currentTab) {
                // 在新标签页模式下，关闭当前标签页
                try {
                    window.close();
                } catch (e) {
                    this.logger.log('WARN', '无法自动关闭标签页，跳转到新帖子页面', { error: e.message });
                    window.location.href = 'https://linux.do/new';
                }
            } else {
                // 在同一个标签页中导航
                window.location.href = 'https://linux.do/new';
            }
        }

        // 暂停/恢复浏览
        togglePause() {
            this.isPaused = !this.isPaused;
            if (this.isPaused && this.timer) {
                clearTimeout(this.timer);
                this.logger.log('INFO', '浏览已暂停');
            } else if (!this.isPaused && this.currentPostId) {
                this.logger.log('INFO', '浏览已恢复');
                this.startBrowsingPost();
            }
        }

        // 跳过当前帖子
        skipCurrentPost() {
            if (this.timer) {
                clearTimeout(this.timer);
            }
            this.logger.log('INFO', '跳过当前帖子');
            this.returnToNewPage();
        }

        // 清除浏览历史
        clearHistory() {
            this.visitedPosts.clear();
            GM_setValue('visitedPosts', []);
            this.logger.log('INFO', '已清除所有浏览历史');
        }

        // 获取统计信息
        getStats() {
            return {
                totalVisited: this.visitedPosts.size,
                isPaused: this.isPaused,
                currentPost: this.currentPostId
            };
        }
    }

    // UI 管理类
    class UIManager {
        constructor(configManager, postManager, logger) {
            this.configManager = configManager;
            this.postManager = postManager;
            this.logger = logger;
            this.settingsVisible = false;
            this.eventHandlers = new Map();
        }

        // 安全地添加事件监听器
        addSafeEventListener(element, event, handler) {
            if (element && typeof handler === 'function') {
                element.addEventListener(event, handler);
                const key = `${event}-${Date.now()}`;
                this.eventHandlers.set(key, { element, event, handler });
                return key;
            }
            return null;
        }

        // 清理事件监听器
        cleanupEventListeners() {
            for (const [key, { element, event, handler }] of this.eventHandlers) {
                element.removeEventListener(event, handler);
            }
            this.eventHandlers.clear();
        }

        // 创建设置面板
        createSettingsPanel() {
            const panel = document.createElement('div');
            panel.id = 'linuxDoSettings';
            panel.style.cssText = `
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: white;
                border: 2px solid #007cba;
                border-radius: 8px;
                padding: 20px;
                z-index: 10000;
                box-shadow: 0 4px 20px rgba(0,0,0,0.3);
                min-width: 600px;
                max-height: 80vh;
                overflow-y: auto;
                font-family: Arial, sans-serif;
            `;

            const config = this.configManager.getConfig();
            const stats = this.postManager.getStats();

            panel.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                    <h3 style="margin: 0; color: #007cba;">Linux.do 自动浏览设置</h3>
                    <button id="closeSettings" style="background: none; border: none; font-size: 20px; cursor: pointer;">×</button>
                </div>

                <div class="settings-section">
                    <h4>时间设置</h4>
                    <div class="setting-item">
                        <label>最小停留时间 (秒):</label>
                        <input type="number" id="minStayTime" value="${config.minStayTime}" min="1" max="60">
                    </div>
                    <div class="setting-item">
                        <label>最大停留时间 (秒):</label>
                        <input type="number" id="maxStayTime" value="${config.maxStayTime}" min="1" max="60">
                    </div>
                </div>

                <div class="settings-section">
                    <h4>浏览设置</h4>
                    <div class="setting-item">
                        <label>
                            <input type="checkbox" id="enableAutoBrowse" ${config.enableAutoBrowse ? 'checked' : ''}>
                            启用自动浏览
                        </label>
                    </div>
                    <div class="setting-item">
                        <label>
                            <input type="checkbox" id="useNewTab" ${config.useNewTab ? 'checked' : ''}>
                            在新标签页打开帖子
                        </label>
                    </div>
                    <div class="setting-item">
                        <label>
                            <input type="checkbox" id="autoRedirect" ${config.autoRedirect ? 'checked' : ''}>
                            自动跳转到/new页面
                        </label>
                    </div>
                    <div class="setting-item">
                        <label>
                            <input type="checkbox" id="checkUnread" ${config.checkUnread ? 'checked' : ''}>
                            当/new无帖子时检查/unread
                        </label>
                    </div>
                    <div class="setting-item">
                        <label>跳转到/new最少新帖子数:</label>
                        <input type="number" id="minNewPosts" value="${config.minNewPosts}" min="0" max="100">
                    </div>
                    <div class="setting-item">
                        <label>
                            <input type="checkbox" id="enableLogging" ${config.enableLogging ? 'checked' : ''}>
                            启用日志记录
                        </label>
                    </div>
                </div>

                <div class="settings-section">
                    <h4>点赞设置</h4>
                    <div class="setting-item">
                        <label>
                            <input type="checkbox" id="enableLike" ${config.enableLike ? 'checked' : ''}>
                            启用随机点赞功能
                        </label>
                    </div>
                    <div class="setting-item">
                        <label>点赞概率 (0-1):</label>
                        <input type="number" id="likeProbability" value="${config.likeProbability}" min="0" max="1" step="0.1">
                    </div>
                </div>

                <div class="settings-section">
                    <h4>跳过帖子设置</h4>
                    <div class="setting-item">
                        <label>
                            <input type="checkbox" id="skipRedirects" ${config.skipRedirects ? 'checked' : ''}>
                            自动跳过重定向页面
                        </label>
                    </div>
                    <div class="setting-item">
                        <label>
                            <input type="checkbox" id="skipExternalLinks" ${config.skipExternalLinks ? 'checked' : ''}>
                            跳过包含外部链接的帖子
                        </label>
                    </div>
                    <div style="margin-bottom: 10px;">
                        <label style="display: block; margin-bottom: 5px;">外部域名列表 (每行一个):</label>
                        <textarea id="externalLinkDomains" rows="2" style="width: 100%; padding: 5px; border: 1px solid #ddd; border-radius: 4px; resize: vertical;">${config.externalLinkDomains.join('\n')}</textarea>
                        <small style="color: #666; font-size: 11px;">包含这些域名的链接将被视为外部链接</small>
                    </div>
                    <div style="margin-bottom: 10px;">
                        <label style="display: block; margin-bottom: 5px;">跳过的帖子URL (每行一个):</label>
                        <textarea id="skippedPosts" rows="3" style="width: 100%; padding: 5px; border: 1px solid #ddd; border-radius: 4px; resize: vertical;">${config.skippedPosts.join('\n')}</textarea>
                        <small style="color: #666; font-size: 11px;">
                            支持完整URL或部分URL匹配，如：<br>
                            • https://linux.do/t/topic/1164403/1<br>
                            • linux.do/t/topic/1164403<br>
                            • 1164403
                        </small>
                    </div>
                    <div style="margin-bottom: 10px;">
                        <label style="display: block; margin-bottom: 5px;">跳过的标题关键词 (每行一个):</label>
                        <textarea id="skippedKeywords" rows="3" style="width: 100%; padding: 5px; border: 1px solid #ddd; border-radius: 4px; resize: vertical;">${config.skippedKeywords.join('\n')}</textarea>
                        <small style="color: #666; font-size: 11px;">不区分大小写匹配</small>
                    </div>
                    <div class="setting-item">
                        <button id="addCurrentToSkip" style="background: #007cba; color: white; border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer;">将当前帖子添加到跳过列表</button>
                    </div>
                </div>

                <div class="settings-section">
                    <h4>快捷键设置</h4>
                    <div class="setting-item">
                        <label>暂停/恢复 (F2):</label>
                        <input type="text" id="hotkeyPause" value="${config.hotkeyPause}" readonly>
                    </div>
                    <div class="setting-item">
                        <label>跳过帖子 (F3):</label>
                        <input type="text" id="hotkeySkip" value="${config.hotkeySkip}" readonly>
                    </div>
                </div>

                <div class="settings-section">
                    <h4>统计信息</h4>
                    <div class="stats">
                        <p>已浏览帖子: ${stats.totalVisited}</p>
                        <p>当前状态: ${stats.isPaused ? '已暂停' : '运行中'}</p>
                    </div>
                </div>

                <div class="settings-section">
                    <h4>操作</h4>
                    <div class="actions">
                        <button id="clearHistory" style="background: #ff4444; color: white; border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer;">清除浏览历史</button>
                        <button id="clearLogs" style="background: #888; color: white; border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer;">清除日志</button>
                        <button id="resetConfig" style="background: #ff8800; color: white; border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer;">重置设置</button>
                    </div>
                </div>

                <div class="settings-section">
                    <h4>日志</h4>
                    <div id="linuxDoLogs" style="max-height: 150px; overflow-y: auto; border: 1px solid #ddd; padding: 5px; font-size: 12px; background: #f9f9f9;">
                        ${this.createLogDisplay()}
                    </div>
                </div>

                <div class="settings-buttons" style="margin-top: 20px; display: flex; gap: 10px;">
                    <button id="saveSettings" style="background: #007cba; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; flex: 1;">保存设置</button>
                    <button id="cancelSettings" style="background: #666; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; flex: 1;">取消</button>
                </div>
            `;

            // 添加样式
            this.addSettingsStyles();
            document.body.appendChild(panel);
            this.attachSettingsEvents(panel);
        }

        // 创建日志显示
        createLogDisplay() {
            return this.logger.getLogs().slice(0, 10).map(log =>
                `<div class="log-entry log-${log.level.toLowerCase()}">
                    <span class="log-time">${new Date(log.timestamp).toLocaleTimeString()}</span>
                    <span class="log-level">${log.level}</span>
                    <span class="log-message">${log.message}</span>
                </div>`
            ).join('');
        }

        // 添加设置面板样式
        addSettingsStyles() {
            if (document.getElementById('linuxDoSettingsStyles')) return;

            const style = document.createElement('style');
            style.id = 'linuxDoSettingsStyles';
            style.textContent = `
                .settings-section {
                    margin-bottom: 20px;
                    padding-bottom: 15px;
                    border-bottom: 1px solid #eee;
                }
                .settings-section h4 {
                    margin: 0 0 10px 0;
                    color: #333;
                }
                .setting-item {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 10px;
                }
                .setting-item label {
                    flex: 1;
                }
                .setting-item input[type="number"] {
                    width: 80px;
                    padding: 5px;
                    border: 1px solid #ddd;
                    border-radius: 4px;
                }
                .setting-item input[type="text"] {
                    width: 100px;
                    padding: 5px;
                    border: 1px solid #ddd;
                    border-radius: 4px;
                    text-align: center;
                }
                .actions {
                    display: flex;
                    gap: 10px;
                    flex-wrap: wrap;
                }
                .stats p {
                    margin: 5px 0;
                    font-size: 14px;
                }
                .log-entry {
                    margin: 2px 0;
                    padding: 2px 5px;
                    border-radius: 3px;
                    font-family: monospace;
                }
                .log-error { background: #ffe6e6; color: #d00; }
                .log-warn { background: #fff3cd; color: #856404; }
                .log-info { background: #e6f3ff; color: #0066cc; }
                .log-time { color: #666; margin-right: 5px; }
                .log-level { font-weight: bold; margin-right: 5px; }
            `;
            document.head.appendChild(style);
        }

        // 附加设置面板事件
        attachSettingsEvents(panel) {
            // 清理之前的事件监听器
            this.cleanupEventListeners();

            // 使用安全的事件监听器
            this.addSafeEventListener(document.getElementById('closeSettings'), 'click', () => this.hideSettings());
            this.addSafeEventListener(document.getElementById('cancelSettings'), 'click', () => this.hideSettings());

            this.addSafeEventListener(document.getElementById('saveSettings'), 'click', () => {
                this.saveSettings();
                this.hideSettings();
            });

            this.addSafeEventListener(document.getElementById('addCurrentToSkip'), 'click', () => {
                const currentUrl = window.location.href;
                if (currentUrl.includes('/t/topic/')) {
                    const titleElement = document.querySelector('h1');
                    const title = titleElement ? titleElement.textContent.trim() : '';

                    if (confirm(`确定要将当前帖子添加到跳过列表吗？\n\nURL: ${currentUrl}\n标题: ${title}`)) {
                        this.configManager.addSkippedPost(currentUrl);
                        document.getElementById('skippedPosts').value = this.configManager.getConfig().skippedPosts.join('\n');
                        this.logger.log('INFO', '已将当前帖子添加到跳过列表', { url: currentUrl, title });
                    }
                } else {
                    alert('当前页面不是帖子页面，无法添加到跳过列表');
                }
            });

            this.addSafeEventListener(document.getElementById('clearHistory'), 'click', () => {
                if (confirm('确定要清除所有浏览历史吗？')) {
                    this.postManager.clearHistory();
                    this.hideSettings();
                }
            });

            this.addSafeEventListener(document.getElementById('clearLogs'), 'click', () => {
                this.logger.clearLogs();
                this.updateLogDisplay();
            });

            this.addSafeEventListener(document.getElementById('resetConfig'), 'click', () => {
                if (confirm('确定要重置所有设置为默认值吗？')) {
                    this.configManager.resetConfig();
                    this.hideSettings();
                    setTimeout(() => this.showSettings(), 100); // 重新打开显示默认值
                }
            });
        }

        // 更新日志显示
        updateLogDisplay() {
            const logContainer = document.getElementById('linuxDoLogs');
            if (logContainer) {
                logContainer.innerHTML = this.createLogDisplay();
            }
        }

        // 保存设置
        saveSettings() {
            const skippedPostsText = document.getElementById('skippedPosts').value;
            const skippedKeywordsText = document.getElementById('skippedKeywords').value;
            const externalLinkDomainsText = document.getElementById('externalLinkDomains').value;

            const newConfig = {
                minStayTime: parseInt(document.getElementById('minStayTime').value) || 5,
                maxStayTime: parseInt(document.getElementById('maxStayTime').value) || 10,
                enableAutoBrowse: document.getElementById('enableAutoBrowse').checked,
                useNewTab: document.getElementById('useNewTab').checked,
                autoRedirect: document.getElementById('autoRedirect').checked,
                checkUnread: document.getElementById('checkUnread').checked,
                minNewPosts: parseInt(document.getElementById('minNewPosts').value) || 5,
                hotkeyPause: document.getElementById('hotkeyPause').value,
                hotkeySkip: document.getElementById('hotkeySkip').value,
                enableLogging: document.getElementById('enableLogging').checked,
                skipRedirects: document.getElementById('skipRedirects').checked,
                skipExternalLinks: document.getElementById('skipExternalLinks').checked,
                enableLike: document.getElementById('enableLike').checked,
                likeProbability: parseFloat(document.getElementById('likeProbability').value) || 0.3,
                skippedPosts: skippedPostsText.split('\n').filter(url => url.trim()),
                skippedKeywords: skippedKeywordsText.split('\n').filter(keyword => keyword.trim()),
                externalLinkDomains: externalLinkDomainsText.split('\n').filter(domain => domain.trim())
            };

            this.configManager.saveConfig(newConfig);
            this.logger.log('INFO', '设置已保存', newConfig);

            // 显示通知
            GM_notification({
                text: '设置已保存',
                title: 'Linux.do 自动浏览',
                timeout: 2000
            });
        }

        // 显示设置面板
        showSettings() {
            if (!this.settingsVisible) {
                this.createSettingsPanel();
                this.settingsVisible = true;
            }
        }

        // 隐藏设置面板
        hideSettings() {
            const panel = document.getElementById('linuxDoSettings');
            if (panel) {
                panel.remove();
            }
            this.settingsVisible = false;
            this.cleanupEventListeners();
        }

        // 创建状态栏
        createStatusBar() {
            const statusBar = document.createElement('div');
            statusBar.id = 'linuxDoStatusBar';
            statusBar.style.cssText = `
                position: fixed;
                bottom: 10px;
                right: 10px;
                background: rgba(0, 124, 186, 0.9);
                color: white;
                padding: 10px;
                border-radius: 5px;
                font-family: Arial, sans-serif;
                font-size: 12px;
                z-index: 9999;
                max-width: 300px;
                max-height: 200px;
                overflow: auto;
                cursor: pointer;
            `;

            document.body.appendChild(statusBar);
            this.updateStatusBar();

            // 使用安全的事件监听器
            this.addSafeEventListener(statusBar, 'click', () => this.showSettings());
        }

        // 更新状态栏
        updateStatusBar() {
            const statusBar = document.getElementById('linuxDoStatusBar');
            if (statusBar) {
                const config = this.configManager.getConfig();
                const stats = this.postManager.getStats();
                const logs = this.logger.getLogs().slice(0, 3);

                statusBar.innerHTML = `
                    <div style="margin-bottom: 5px;">
                        <strong>Linux.do 自动浏览</strong>
                        <span style="float: right;">⚙️</span>
                    </div>
                    <div>状态: ${stats.isPaused ? '⏸️ 已暂停' : '▶️ 运行中'}</div>
                    <div>已浏览: ${stats.totalVisited} 个帖子</div>
                    <div>模式: ${config.useNewTab ? '新标签页' : '同页面'}</div>
                    <div>点赞: ${config.enableLike ? '✓' : '✗'}</div>
                    <div>跳过设置: ${config.skippedPosts.length + config.skippedKeywords.length + config.externalLinkDomains.length} 条</div>
                    <div style="margin-top: 5px; font-size: 10px; border-top: 1px solid rgba(255,255,255,0.3); padding-top: 5px;">
                        ${logs.map(log =>
                            `<div title="${log.message}">${new Date(log.timestamp).toLocaleTimeString()} ${log.level}: ${log.message.substring(0, 30)}${log.message.length > 30 ? '...' : ''}</div>`
                        ).join('')}
                    </div>
                    <div style="font-size: 9px; margin-top: 5px; opacity: 0.8;">点击打开设置</div>
                `;
            }
        }
    }

    // 快捷键管理
    class HotkeyManager {
        constructor(postManager, uiManager, logger) {
            this.postManager = postManager;
            this.uiManager = uiManager;
            this.logger = logger;
        }

        init() {
            document.addEventListener('keydown', (event) => {
                // 检查是否在输入框中，避免冲突
                if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA' || event.target.isContentEditable) {
                    return;
                }

                const config = this.postManager.configManager.getConfig();

                switch (event.code) {
                    case 'F2':
                        event.preventDefault();
                        this.postManager.togglePause();
                        this.uiManager.updateStatusBar();
                        break;

                    case 'F3':
                        event.preventDefault();
                        this.postManager.skipCurrentPost();
                        break;

                    case 'F4':
                        event.preventDefault();
                        this.uiManager.showSettings();
                        break;
                }
            });

            this.logger.log('INFO', '快捷键已初始化', {
                pause: 'F2',
                skip: 'F3',
                settings: 'F4'
            });
        }
    }

    // 页面导航器
    class PageNavigator {
        constructor(configManager, postManager, logger) {
            this.configManager = configManager;
            this.postManager = postManager;
            this.logger = logger;
        }

        // 获取/new页面的帖子数量
        getNewPostCount() {
            try {
                const newLink = document.querySelector('a[href="/new"]');
                if (newLink) {
                    const text = newLink.textContent;
                    const match = text.match(/\((\d+)\)/);
                    if (match) {
                        return parseInt(match[1]);
                    }
                }
                return 0;
            } catch (error) {
                this.logger.log('ERROR', '获取新帖子数量失败', { error: error.message });
                return 0;
            }
        }

        // 检查当前页面类型并处理
        handleCurrentPage() {
            const currentUrl = window.location.href;
            this.logger.log('INFO', '处理当前页面', { url: currentUrl });

            // 立即检查是否应该跳过当前页面
            if (currentUrl.includes('/t/topic/')) {
                const titleElement = document.querySelector('h1');
                const title = titleElement ? titleElement.textContent.trim() : null;

                if (this.postManager.shouldSkipPost(currentUrl, title)) {
                    this.logger.log('INFO', '当前页面应该跳过，立即返回', { url: currentUrl, title });
                    this.postManager.returnToNewPage();
                    return;
                }
            }

            // 如果是需要跳转的页面
            if (this.shouldRedirectToNew(currentUrl)) {
                this.logger.log('INFO', '自动跳转到/new页面');
                window.location.href = 'https://linux.do/new';
                return;
            }

            // 处理帖子页面
            if (currentUrl.includes('/t/topic/')) {
                this.handleTopicPage();
                return;
            }

            // 处理列表页面（/new 或 /unread）
            if (currentUrl.includes('/new') || currentUrl.includes('/unread')) {
                this.handleListPage();
                return;
            }
        }

        // 检查是否应该跳转到/new页面
        shouldRedirectToNew(url) {
            const config = this.configManager.getConfig();
            if (!config.autoRedirect) return false;

            // 需要跳转的页面模式
            const redirectPatterns = [
                /^https:\/\/linux\.do\/$/,
                /^https:\/\/linux\.do\/latest$/,
                /^https:\/\/linux\.do\/c\/\w+\/\d+$/
            ];

            return redirectPatterns.some(pattern => pattern.test(url));
        }

        // 处理帖子页面
        handleTopicPage() {
            const config = this.configManager.getConfig();
            if (!config.enableAutoBrowse) {
                this.logger.log('INFO', '自动浏览功能已禁用');
                return;
            }

            // 等待页面加载完成后再开始浏览
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => {
                    setTimeout(() => this.postManager.startBrowsingPost(), 1000);
                });
            } else {
                setTimeout(() => this.postManager.startBrowsingPost(), 1000);
            }
        }

        // 处理列表页面（/new 或 /unread）
        handleListPage() {
            const config = this.configManager.getConfig();
            if (!config.enableAutoBrowse) {
                this.logger.log('INFO', '自动浏览功能已禁用');
                return;
            }

            // 在/unread页面时，检查/new页面的帖子数量
            if (window.location.href.includes('/unread')) {
                const newPostCount = this.getNewPostCount();
                this.logger.log('INFO', `检查新帖子数量: ${newPostCount}, 最少需要: ${config.minNewPosts}`);

                if (newPostCount >= config.minNewPosts) {
                    this.logger.log('INFO', '新帖子数量充足，跳转到/new页面');
                    window.location.href = 'https://linux.do/new';
                    return;
                }
            }

            this.logger.log('INFO', '开始在列表页面寻找未浏览的帖子');

            // 等待页面加载完成
            setTimeout(() => {
                this.findAndClickUnvisitedPost();
            }, 2000);
        }

        // 寻找并点击未浏览的帖子
        findAndClickUnvisitedPost() {
            // 尝试多种选择器来获取帖子链接
            const selectors = [
                'a[href*="/t/topic/"]',
                '.topic-list a[href*="/t/topic/"]',
                '.topic-list-item a[href*="/t/topic/"]',
                'tr[data-topic-id] a[href*="/t/topic/"]',
                '.latest-topic-list a[href*="/t/topic/"]'
            ];

            let topicLinks = [];
            for (const selector of selectors) {
                const links = Array.from(document.querySelectorAll(selector));
                if (links.length > 0) {
                    topicLinks = links;
                    this.logger.log('INFO', `使用选择器 ${selector} 找到 ${links.length} 个帖子链接`);
                    break;
                }
            }

            if (topicLinks.length === 0) {
                this.logger.log('WARN', '未找到任何帖子链接');
                this.handleNoPostsFound();
                return;
            }

            // 去重，保留唯一的链接
            const uniqueLinks = [];
            const seenUrls = new Set();

            for (const link of topicLinks) {
                if (!seenUrls.has(link.href)) {
                    seenUrls.add(link.href);
                    uniqueLinks.push(link);
                }
            }

            this.logger.log('INFO', `找到 ${uniqueLinks.length} 个唯一帖子链接`);

            // 遍历所有帖子，找到第一个未访问且不应跳过的帖子
            for (const link of uniqueLinks) {
                const href = link.href;

                // 获取帖子标题
                let title = '';
                // 尝试多种方式获取标题
                const titleSelectors = [
                    '.title',
                    '.main-link',
                    '.topic-title',
                    'span',
                    'a'
                ];

                for (const titleSelector of titleSelectors) {
                    const titleElement = link.querySelector(titleSelector);
                    if (titleElement && titleElement.textContent.trim()) {
                        title = titleElement.textContent.trim();
                        break;
                    }
                }

                // 如果没有找到标题，使用链接文本
                if (!title) {
                    title = link.textContent.trim();
                }

                this.logger.log('INFO', '检查帖子', { url: href, title });

                // 优先检查是否应该跳过（最高优先级）
                if (this.postManager.shouldSkipPost(href, title, link)) {
                    this.logger.log('INFO', '帖子应该跳过，继续寻找下一个', { url: href, title });
                    continue;
                }

                // 检查是否已访问过
                if (!this.postManager.isPostVisited(href)) {
                    this.logger.log('INFO', '找到符合条件的帖子，准备打开', {
                        url: href,
                        title,
                        pageNumber: this.postManager.getPostPageNumber(href)
                    });

                    const config = this.configManager.getConfig();
                    if (config.useNewTab) {
                        // 在新标签页打开
                        this.postManager.openPostInNewTab(href);
                    } else {
                        // 在同一标签页打开
                        window.location.href = href;
                    }
                    return;
                } else {
                    this.logger.log('INFO', '帖子已访问过，继续寻找', { url: href, title });
                }
            }

            // 如果没有找到符合条件的帖子
            this.logger.log('WARN', '当前页面未找到符合条件的未浏览帖子');
            this.handleNoPostsFound();
        }

        // 处理没有找到帖子的情况
        handleNoPostsFound() {
            // 检查是否需要跳转到/unread页面
            if (window.location.href.includes('/new')) {
                const config = this.configManager.getConfig();
                if (config.checkUnread) {
                    this.logger.log('INFO', '/new页面没有符合条件的帖子，跳转到/unread页面');
                    window.location.href = 'https://linux.do/unread';
                } else {
                    this.logger.log('INFO', '等待页面刷新');
                    setTimeout(() => {
                        window.location.reload();
                    }, 10000);
                }
            } else {
                // 在/unread页面也没有帖子，等待刷新
                this.logger.log('INFO', '等待页面刷新');
                setTimeout(() => {
                    window.location.reload();
                }, 10000);
            }
        }
    }

    // 主控制器
    class MainController {
        constructor() {
            this.configManager = new ConfigManager();
            this.logger = new Logger(this.configManager);
            this.postManager = new PostManager(this.configManager, this.logger);
            this.uiManager = new UIManager(this.configManager, this.postManager, this.logger);
            this.hotkeyManager = new HotkeyManager(this.postManager, this.uiManager, this.logger);
            this.pageNavigator = new PageNavigator(this.configManager, this.postManager, this.logger);
        }

        async init() {
            try {
                this.logger.log('INFO', 'Linux.do 自动浏览脚本初始化开始');

                // 注册菜单命令
                GM_registerMenuCommand('📋 打开设置', () => {
                    this.uiManager.showSettings();
                });

                GM_registerMenuCommand('⏸️ 暂停/恢复', () => {
                    this.postManager.togglePause();
                    this.uiManager.updateStatusBar();
                });

                GM_registerMenuCommand('🗑️ 清除历史', () => {
                    if (confirm('确定要清除所有浏览历史吗？')) {
                        this.postManager.clearHistory();
                        this.uiManager.updateStatusBar();
                    }
                });

                // 初始化快捷键
                this.hotkeyManager.init();

                // 创建状态栏
                this.uiManager.createStatusBar();

                // 处理当前页面
                this.pageNavigator.handleCurrentPage();

                this.logger.log('INFO', 'Linux.do 自动浏览脚本初始化完成');

            } catch (error) {
                this.logger.log('ERROR', '脚本初始化失败', { error: error.message, stack: error.stack });
            }
        }
    }

    // 启动脚本
    const controller = new MainController();

    // 暴露到全局对象，方便调试
    window.linuxDoController = controller;
    window.linuxDoUIManager = controller.uiManager;
    window.linuxDoPostManager = controller.postManager;

    // 页面加载完成后初始化
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => controller.init());
    } else {
        controller.init();
    }

})();
