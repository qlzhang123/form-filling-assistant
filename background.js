/**
 * 填表助手背景脚本
 * 处理扩展内部通信和管理
 */

class FormFillingBackground {
    constructor() {
        this.activeSessions = new Map(); // 存储活跃的填表会话
        this.initialize();
    }

    initialize() {
        console.log('填表助手背景脚本初始化...');
        
        // 监听安装事件
        if (typeof chrome !== 'undefined' && chrome.runtime) {
            chrome.runtime.onInstalled.addListener((details) => {
                this.handleInstall(details);
            });
            
            // 监听来自侧边栏和内容脚本的消息
            chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
                return this.handleMessage(request, sender, sendResponse);
            });
            
            // 监听标签页移除事件，清理相关会话
            chrome.tabs.onRemoved.addListener((tabId) => {
                this.cleanupSession(tabId);
            });
        }
        
        console.log('填表助手背景脚本初始化完成');
    }

    handleInstall(details) {
        /**
         * 处理扩展安装事件
         */
        console.log('填表助手扩展安装/更新:', details.reason);
        
        if (details.reason === 'install') {
            // 首次安装时的初始化
            this.setupDefaultSettings();
        } else if (details.reason === 'update') {
            // 更新时的处理
            this.handleUpdate(details.previousVersion);
        }
    }

    setupDefaultSettings() {
        /**
         * 设置默认配置
         */
        chrome.storage.local.set({
            aiSettings: {
                model: 'deepseek-chat',
                temperature: 0.7,
                enableAI: true,
                showThoughts: false
            },
            fillHistory: [],
            extensionSettings: {
                version: chrome.runtime.getManifest().version,
                lastUpdate: new Date().toISOString()
            }
        });
    }

    handleUpdate(previousVersion) {
        /**
         * 处理扩展更新
         */
        console.log(`扩展从版本 ${previousVersion} 更新到当前版本`);
        
        // 根据版本进行迁移操作
        // 这里可以根据需要添加特定的迁移逻辑
    }

    handleMessage(request, sender, sendResponse) {
        /**
         * 处理来自侧边栏或内容脚本的消息
         */
        const { action, data, sessionId } = request;
        
        console.log('背景脚本收到消息:', action, '来自:', sender.tab ? sender.tab.id : 'popup/sidepanel');
        
        switch (action) {
            case 'parseForm':
                this.handleParseForm(sender, data, sendResponse);
                return true;
                
            case 'fillFormField':
                this.handleFillFormField(sender, data, sendResponse);
                return true;
                
            case 'extractPageContent':
                this.handleExtractPageContent(sender, data, sendResponse);
                return true;
                
            case 'getPageElements':
                this.handleGetPageElements(sender, data, sendResponse);
                return true;
                
            case 'startFillingSession':
                this.handleStartFillingSession(sender, data, sendResponse);
                return true;
                
            case 'endFillingSession':
                return this.handleEndFillingSession(sender, data, sendResponse);
                
            case 'getSessionState':
                return this.handleGetSessionState(sender, data, sendResponse);
                
            case 'updateSessionState':
                return this.handleUpdateSessionState(sender, data, sendResponse);
                
            case 'getActiveTabInfo':
                return this.handleGetActiveTabInfo(sender, data, sendResponse);
                
            default:
                console.warn('未知的消息动作:', action);
                sendResponse({ success: false, message: `未知的动作: ${action}` });
                return false;
        }
    }

    async ensureContentScript(tabId) {
        /**
         * 确保目标标签页已注入内容脚本
         */
        try {
            // 检查是否已加载
            const results = await chrome.scripting.executeScript({
                target: { tabId: tabId },
                func: () => window.formFillingScriptLoaded === true
            });

            if (!results || !results[0] || !results[0].result) {
                console.log(`正在向标签页 ${tabId} 注入内容脚本...`);
                await chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    files: ['content_script.js']
                });
                // 给一点时间让脚本初始化
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            return true;
        } catch (error) {
            console.error(`无法注入内容脚本到标签页 ${tabId}:`, error);
            return false;
        }
    }

    async handleParseForm(sender, data, sendResponse) {
        /**
         * 处理表单解析请求
         * 
         * 注意：现在的解析逻辑已迁移到 Sidebar (FormParser + LLM)，
         * background 仅负责获取 DOM 字符串传回 Sidebar。
         */
        let tabId = sender.tab?.id;
        
        if (!tabId) {
            try {
                const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
                if (tabs && tabs.length > 0) {
                    tabId = tabs[0].id;
                }
            } catch (error) {
                console.error('获取活跃标签页失败:', error);
            }
        }

        if (!tabId) {
            sendResponse({ success: false, message: '无法获取标签页ID' });
            return;
        }

        // 确保内容脚本已加载
        await this.ensureContentScript(tabId);
        
        // 不再让 Content Script 解析，而是请求它返回页面 HTML
        // Sidebar 将使用 FormParser 和 LLM 进行深度解析
        chrome.tabs.sendMessage(tabId, { action: 'getPageContent' }, (response) => {
            if (chrome.runtime.lastError) {
                console.error('发送消息失败:', chrome.runtime.lastError);
                sendResponse({ 
                    success: false, 
                    message: `与内容脚本通信失败: ${chrome.runtime.lastError.message}` 
                });
            } else {
                const finalResponse = response || { success: false, message: '内容脚本未响应' };
                if (finalResponse.success) {
                    finalResponse.tabId = tabId;
                }
                sendResponse(finalResponse);
            }
        });
    }

    async handleFillFormField(sender, data, sendResponse) {
        /**
         * 处理填写表单字段请求
         */
        let tabId = data.tabId || sender.tab?.id;

        if (!tabId) {
            try {
                const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
                if (tabs && tabs.length > 0) {
                    tabId = tabs[0].id;
                }
            } catch (error) {
                console.error('获取活跃标签页失败:', error);
            }
        }

        if (!tabId) {
            sendResponse({ success: false, message: '无法获取标签页ID' });
            return;
        }

        // 确保内容脚本已加载
        await this.ensureContentScript(tabId);
        
        // 自动聚焦到目标标签页
        try {
            chrome.tabs.update(tabId, { active: true });
        } catch (e) {
            console.warn('无法聚焦标签页:', e);
        }
        
        // 转发给内容脚本
        chrome.tabs.sendMessage(tabId, { 
            action: 'fillFormField', 
            data: { fieldName: data.fieldName, value: data.value } 
        }, (response) => {
            if (chrome.runtime.lastError) {
                console.error('发送消息失败:', chrome.runtime.lastError);
                sendResponse({ 
                    success: false, 
                    message: `与内容脚本通信失败: ${chrome.runtime.lastError.message}` 
                });
            } else {
                sendResponse(response || { success: true, message: '字段已填写（无响应）' });
            }
        });
    }

    async handleExtractPageContent(sender, data, sendResponse) {
        /**
         * 处理页面内容提取请求
         */
        let tabId = data.tabId || sender.tab?.id;

        if (!tabId) {
            try {
                const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
                if (tabs && tabs.length > 0) {
                    tabId = tabs[0].id;
                }
            } catch (error) {
                console.error('获取活跃标签页失败:', error);
            }
        }

        if (!tabId) {
            sendResponse({ success: false, message: '无法获取标签页ID' });
            return;
        }
        
        // 转发给内容脚本
        chrome.tabs.sendMessage(tabId, { action: 'extractPageContent', data }, (response) => {
            if (chrome.runtime.lastError) {
                console.error('发送消息失败:', chrome.runtime.lastError);
                sendResponse({ 
                    success: false, 
                    message: `与内容脚本通信失败: ${chrome.runtime.lastError.message}` 
                });
            } else {
                sendResponse(response || { success: false, message: '无法提取内容' });
            }
        });
    }

    async handleGetPageElements(sender, data, sendResponse) {
        /**
         * 处理获取页面元素请求
         */
        let tabId = data.tabId || sender.tab?.id;

        if (!tabId) {
            try {
                const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
                if (tabs && tabs.length > 0) {
                    tabId = tabs[0].id;
                }
            } catch (error) {
                console.error('获取活跃标签页失败:', error);
            }
        }

        if (!tabId) {
            sendResponse({ success: false, message: '无法获取标签页ID' });
            return;
        }
        
        // 转发给内容脚本
        chrome.tabs.sendMessage(tabId, { 
            action: 'getPageElements', 
            data: { selector: data.selector } 
        }, (response) => {
            if (chrome.runtime.lastError) {
                console.error('发送消息失败:', chrome.runtime.lastError);
                sendResponse({ 
                    success: false, 
                    message: `与内容脚本通信失败: ${chrome.runtime.lastError.message}` 
                });
            } else {
                sendResponse(response || { success: false, message: '无法获取元素' });
            }
        });
    }

    async handleStartFillingSession(sender, data, sendResponse) {
        /**
         * 开始填表会话
         */
        let tabId = data.tabId || sender.tab?.id;

        if (!tabId) {
            try {
                const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
                if (tabs && tabs.length > 0) {
                    tabId = tabs[0].id;
                }
            } catch (error) {
                console.error('获取活跃标签页失败:', error);
            }
        }

        if (!tabId) {
            sendResponse({ success: false, message: '无法获取标签页ID' });
            return;
        }
        
        const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        const session = {
            id: sessionId,
            tabId: tabId,
            startTime: new Date().toISOString(),
            formUrl: data.formUrl || sender.tab?.url,
            fields: data.fields || [],
            filledFields: {},
            status: 'active',
            progress: 0,
            errorCount: 0
        };
        
        this.activeSessions.set(sessionId, session);
        
        sendResponse({
            success: true,
            sessionId: sessionId,
            message: `填表会话已开始: ${sessionId}`
        });
    }

    handleEndFillingSession(sender, data, sendResponse) {
        /**
         * 结束填表会话
         */
        const { sessionId } = data;
        if (!sessionId) {
            sendResponse({ success: false, message: '会话ID缺失' });
            return false;
        }
        
        const session = this.activeSessions.get(sessionId);
        if (!session) {
            sendResponse({ success: false, message: '会话不存在' });
            return false;
        }
        
        // 更新会话状态
        session.status = 'completed';
        session.endTime = new Date().toISOString();
        session.duration = new Date(session.endTime) - new Date(session.startTime);
        
        // 保存到历史记录
        this.saveSessionToHistory(session);
        
        // 从活跃会话中移除
        this.activeSessions.delete(sessionId);
        
        sendResponse({
            success: true,
            message: '填表会话已结束并保存到历史记录'
        });
    }

    handleGetSessionState(sender, data, sendResponse) {
        /**
         * 获取会话状态
         */
        const { sessionId } = data;
        if (!sessionId) {
            sendResponse({ success: false, message: '会话ID缺失' });
            return false;
        }
        
        const session = this.activeSessions.get(sessionId);
        if (!session) {
            sendResponse({ success: false, message: '会话不存在' });
            return false;
        }
        
        sendResponse({
            success: true,
            session: session
        });
    }

    handleUpdateSessionState(sender, data, sendResponse) {
        /**
         * 更新会话状态
         */
        const { sessionId, updates } = data;
        if (!sessionId || !updates) {
            sendResponse({ success: false, message: '会话ID和更新数据缺失' });
            return false;
        }
        
        const session = this.activeSessions.get(sessionId);
        if (!session) {
            sendResponse({ success: false, message: '会话不存在' });
            return false;
        }
        
        // 更新会话属性
        Object.assign(session, updates);
        session.lastUpdate = new Date().toISOString();
        
        sendResponse({
            success: true,
            message: '会话状态已更新'
        });
    }

    handleGetActiveTabInfo(sender, data, sendResponse) {
        /**
         * 获取活跃标签页信息
         */
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (chrome.runtime.lastError) {
                sendResponse({ 
                    success: false, 
                    message: `获取标签页信息失败: ${chrome.runtime.lastError.message}` 
                });
            } else if (tabs.length > 0) {
                sendResponse({
                    success: true,
                    tab: tabs[0]
                });
            } else {
                sendResponse({
                    success: false,
                    message: '未找到活跃标签页'
                });
            }
        });
        
        return true;
    }

    cleanupSession(tabId) {
        /**
         * 清理会话数据
         */
        for (const [sessionId, session] of this.activeSessions.entries()) {
            if (session.tabId === tabId) {
                console.log(`清理标签页 ${tabId} 的会话 ${sessionId}`);
                
                // 尝试保存未完成的会话
                if (session.status !== 'completed') {
                    session.status = 'interrupted';
                    session.endTime = new Date().toISOString();
                    this.saveSessionToHistory(session);
                }
                
                this.activeSessions.delete(sessionId);
            }
        }
    }

    saveSessionToHistory(session) {
        /**
         * 保存会话到历史记录
         */
        const historyRecord = {
            id: session.id,
            formUrl: session.formUrl,
            startTime: session.startTime,
            endTime: session.endTime || new Date().toISOString(),
            duration: session.duration || (new Date() - new Date(session.startTime)),
            fieldsTotal: session.fields.length,
            fieldsFilled: Object.keys(session.filledFields).length,
            status: session.status,
            successRate: session.fields.length > 0 ? 
                (Object.keys(session.filledFields).length / session.fields.length * 100).toFixed(2) : 0
        };
        
        // 读取现有历史记录
        chrome.storage.local.get(['fillHistory'], (result) => {
            const history = result.fillHistory || [];
            
            // 添加新记录
            history.unshift(historyRecord);
            
            // 限制历史记录数量（保留最近100条）
            if (history.length > 100) {
                history.splice(100);
            }
            
            // 保存回存储
            chrome.storage.local.set({ fillHistory: history }, () => {
                if (chrome.runtime.lastError) {
                    console.error('保存历史记录失败:', chrome.runtime.lastError);
                } else {
                    console.log('会话历史记录已保存');
                }
            });
        });
    }

    getSessionById(sessionId) {
        /**
         * 根据ID获取会话
         */
        return this.activeSessions.get(sessionId);
    }

    getAllActiveSessions() {
        /**
         * 获取所有活跃会话
         */
        return Array.from(this.activeSessions.values());
    }
}

// 初始化背景脚本
const formFillingBackground = new FormFillingBackground();

// 导出实例以便在其他地方访问（如果需要）
if (typeof module !== 'undefined' && module.exports) {
    module.exports = FormFillingBackground;
}