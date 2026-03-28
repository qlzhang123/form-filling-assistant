/**
 * 智能填表助手侧边栏主控制器
 */

import { DeepSeekLLM } from './js/llm_client.js';
import { FormFillingAgent } from './js/form_agent.js';
import { EnhancedToolExecutor } from './js/tool_executor.js';
import { fetchCrawl4AIPageContent } from './js/crawl4ai_client.js';
import { extractFormFieldsFromHtml } from './js/schema_extractor_adapter.js';
import { unifiedSearchAuthors, unifiedGetPublications, getPaperByDOI,  unifiedSearchPapers, searchConferenceEventDate } from './js/api_client.js';
import { getSemanticScholarPaperByDoi, getCrossrefPaperByDoi, getOpenAlexPaperByDoi } from './js/api_client.js';
class FormFillingSidebar {
    constructor() {
        this.fillHistory = [];
        this.aiSettings = {
            apiKey: '',
            model: 'deepseek-chat',
            temperature: 0.7,
            enableAI: true,
            showThoughts: true
        };
        this.currentFormUrl = '';
        this.formTabId = null;
        this.currentFormFields = [];
        this.fieldGroups = [];
        this.currentGroupIndex = 0;
        this.currentFieldIndexInGroup = 0;
        this.currentFieldIndex = 0;
        this.fillingInProgress = false;
        this.filledFields = {};
        this.filledContext = {}; // 存储已填写的上下文信息，供 AI 参考
        this.formFillingAgent = null; // 持久化 Agent 实例以保留发现缓存
        this.activeField = null; // 当前正在处理的字段对象（锁定，防止索引漂移）
        this.activeGroup = null; // 当前正在处理的群组对象（锁定）
        this.repeatedPatterns = []; // 存储识别到的重复群组模式
        this.batchProcessedGroups = new Set(); // 存储已通过批量方式处理过的群组索引
        this.currentBatchPattern = null; // 当前正在处理的批量模式
        this.batchExecutionCancelled = false;
        this.activeAIRequestId = 0;
        this.ignoredAIRequestIds = new Set();
        
        // 作者搜索相关状态
        this.currentAuthor = '';
        this.currentPapers = [];
        this.rawPapers = []; // 存储所有拉取到的论文
        this.currentPaperPage = 0;
        this.currentPaperTotal = 0;
        this.selectedPaper = null;
        this.availableAuthors = [];
        this.searchFilters = {};
        this.requiredPaperFields = [];
        this.batchCandidatesData = new Map();
        this.activeFilters = { year: null, venue: null, authorId: null };
        this.recentYearsWindow = 5;
        this.conferenceAliases = {};
        this.ccfRatings = {};
        this.venueAliasOverrides = {};
        this.ccfRatingOverrides = {};
        this.skipBatchMode = false;
        this._tempAuthors = [];   // 临时存储作者列表，用于 agent 创建后传递
        this.init();
    }

    async init() {
        console.log('智能填表助手侧栏管理器开始初始化...');
        
        try {
            // 等待DOM完全加载
            if (document.readyState === 'loading') {
                await new Promise(resolve => {
                    document.addEventListener('DOMContentLoaded', resolve);
                });
            }
            
            // 初始化元素
            this.initElements();
            
            // 绑定事件 (提前绑定，确保UI可交互)
            this.bindEvents();
            
            // 加载数据
            await this.loadAISettings().catch(e => console.error('加载AI设置失败:', e));
            await this.loadFillHistory().catch(e => console.error('加载历史记录失败:', e));
            await this.loadVenueMappings().catch(e => console.error('加载会议映射失败:', e));
            
            console.log('智能填表助手初始化完成');
        } catch (error) {
            console.error('初始化致命错误:', error);
            // 尝试显示错误状态
            const statusEl = document.getElementById('statusIndicator');
            if (statusEl) {
                statusEl.textContent = '初始化失败: ' + error.message;
                statusEl.className = 'status status-error';
            }
        }
    }

    normalizeVenueKey(venue) {
        if (!venue) return '';
        return String(venue)
            .toLowerCase()
            .replace(/\b(19|20)\d{2}\b/g, ' ')
            .replace(/[()（）\[\]【】{}.,:;'"“”‘’`~!@#$%^&*+=<>?/\\|_-]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    guessVenueAcronym(venue) {
        const raw = String(venue || '').trim();
        if (!raw) return '';
        const direct = raw.match(/\b[A-Z]{2,10}\b/);
        if (direct) return direct[0];
        const words = raw
            .replace(/[()（）\[\]【】{}.,:;'"“”‘’`~!@#$%^&*+=<>?/\\|_-]+/g, ' ')
            .split(/\s+/)
            .filter(Boolean);
        const stop = new Set(['the', 'a', 'an', 'of', 'on', 'and', 'for', 'in', 'to', 'with', 'international', 'conference', 'symposium', 'workshop', 'annual', 'acm', 'ieee', 'proceedings']);
        const letters = [];
        for (const w of words) {
            const lw = w.toLowerCase();
            if (stop.has(lw)) continue;
            if (/^(19|20)\d{2}$/.test(w)) continue;
            letters.push(w[0].toUpperCase());
        }
        const ac = letters.join('');
        if (ac.length >= 3 && ac.length <= 10) return ac;
        return '';
    }

    formatVenueWithYearAndCCF(venue, year) {
        const venueRaw = String(venue || '').trim();
        const normalized = this.normalizeVenueKey(venueRaw);
        const alias = this.conferenceAliases[normalized] || this.conferenceAliases[this.normalizeVenueKey(this.conferenceAliases[normalized] || '')] || '';
        const guessed = this.guessVenueAcronym(venueRaw);
        const shortName = alias || guessed || venueRaw;

        const rating =
            this.ccfRatings[normalized] ||
            this.ccfRatings[this.normalizeVenueKey(shortName)] ||
            this.ccfRatings[String(shortName || '').toLowerCase()] ||
            '';

        const y = year ? String(year).trim() : '';
        const base = y ? `${shortName} ${y}` : shortName;
        const formatted = rating ? `${base} (CCF-${rating})` : base;
        return { shortName, rating, formatted, venueRaw, normalized };
    }

    async loadVenueMappings() {
        const safeParse = (s) => {
            try { return JSON.parse(s); } catch (e) { return {}; }
        };
        this.venueAliasOverrides = safeParse(localStorage.getItem('venue_alias_overrides') || '{}');
        this.ccfRatingOverrides = safeParse(localStorage.getItem('ccf_rating_overrides') || '{}');

        // 获取文件 URL，如果 chrome.runtime 不可用（如测试环境），则使用相对路径
        const urlAliases = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
            ? chrome.runtime.getURL('data/conference_aliases.json')
            : './data/conference_aliases.json';
        const urlCcf = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
            ? chrome.runtime.getURL('data/ccf_ratings.json')
            : './data/ccf_ratings.json';

        // 加载 JSON，失败时返回空对象
        const loadJson = async (url) => {
            try {
                const response = await fetch(url);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return await response.json();
            } catch (e) {
                console.warn(`无法加载 ${url}:`, e);
                return {};
            }
        };

        const [aliasesRes, ccfRes] = await Promise.all([
            loadJson(urlAliases),
            loadJson(urlCcf)
        ]);

        const mergedAliases = { ...(aliasesRes || {}), ...(this.venueAliasOverrides || {}) };
        const mergedCcf = { ...(ccfRes || {}), ...(this.ccfRatingOverrides || {}) };

        this.conferenceAliases = {};
        for (const [k, v] of Object.entries(mergedAliases)) {
            const nk = this.normalizeVenueKey(k);
            if (!nk) continue;
            this.conferenceAliases[nk] = String(v || '').trim();
        }
        this.ccfRatings = {};
        for (const [k, v] of Object.entries(mergedCcf)) {
            const nk = this.normalizeVenueKey(k);
            if (!nk) continue;
            this.ccfRatings[nk] = String(v || '').trim().toUpperCase();
        }
    }

    initElements() {
        console.log('正在初始化元素...');
        
        // 主要按钮
        this.settingsBtn = document.getElementById('settingsBtn');
        this.closeBtn = document.getElementById('closeBtn');
        this.backToFormBtn = document.getElementById('backToFormBtn');
        this.statusIndicator = document.getElementById('statusIndicator');
        
        // AI设置元素
        this.aiSettingsPanel = document.getElementById('aiSettings');
        this.apiKeyInput = document.getElementById('apiKey');
        this.aiModelSelect = document.getElementById('aiModel');
        this.temperatureSlider = document.getElementById('temperature');
        this.tempValueDisplay = document.getElementById('tempValue');
        this.enableAICheckbox = document.getElementById('enableAI');
        this.showThoughtsCheckbox = document.getElementById('showThoughts');
        this.saveSettingsBtn = document.getElementById('saveSettings');
        this.testApiBtn = document.getElementById('testApi');
        
        // 填表助手元素
        this.formFillingSection = document.getElementById('formFillingSection');
        this.formUrlInput = document.getElementById('formUrl');
        this.useCurrentPageBtn = document.getElementById('useCurrentPage');
        this.parseFormBtn = document.getElementById('parseForm');
        
        // 作者搜索相关元素
        this.authorSearchArea = document.getElementById('authorSearchArea');
        this.authorNameInput = document.getElementById('authorNameInput');
        this.searchAuthorBtn = document.getElementById('searchAuthorBtn');
        this.paperTitleInput = document.getElementById('paperTitleInput');
        this.searchPaperTitleBtn = document.getElementById('searchPaperTitleBtn');
        this.usePaperTitleDirectBtn = document.getElementById('usePaperTitleDirectBtn');
        this.paperSelectionArea = document.getElementById('paperSelectionArea');
        this.paperList = document.getElementById('paperList');
        this.prevPaperPageBtn = document.getElementById('prevPaperPage');
        this.nextPaperPageBtn = document.getElementById('nextPaperPage');
        this.paperPageInfo = document.getElementById('paperPageInfo');


        // 填表进度元素
        this.fillingProgress = document.getElementById('fillingProgress');
        this.progressFill = document.getElementById('progressFill');
        this.progressInfo = document.getElementById('progressInfo');
        
        // 字段处理区域
        this.fieldProcessingArea = document.getElementById('fieldProcessingArea');
        this.currentFieldInfo = document.getElementById('currentFieldInfo');
        this.fieldActionChoice = document.getElementById('fieldActionChoice');
        this.chooseAIBtn = document.getElementById('chooseAI');
        this.chooseManualBtn = document.getElementById('chooseManual');
        this.chooseSkipBtn = document.getElementById('chooseSkip');
        this.chooseQuitBtn = document.getElementById('chooseQuit');
        
        this.aiThinkingDisplay = document.getElementById('aiThinkingDisplay');
        this.aiThinkingContent = document.getElementById('aiThinkingContent');
        this.skipThinkingBtn = document.getElementById('skipThinkingBtn');
        this.quitThinkingBtn = document.getElementById('quitThinkingBtn');
        this.optionsDisplay = document.getElementById('optionsDisplay');
        
        // AI推荐区域
        this.aiRecommendation = document.getElementById('aiRecommendation');
        this.recommendationContent = document.getElementById('recommendationContent');
        this.useAiRecommendationBtn = document.getElementById('useAiRecommendation');
        this.editAiRecommendationBtn = document.getElementById('editAiRecommendation');
        
        // 一键填写区域
        this.batchFillArea = document.getElementById('batchFillArea');
        this.batchFillList = document.getElementById('batchFillList');
        this.oneClickFillBtn = document.getElementById('oneClickFillBtn');
        
        // AI多选推荐区域
        this.aiMultipleChoices = document.getElementById('aiMultipleChoices');
        this.choicesList = document.getElementById('choicesList');

        // 批量处理相关元素
        this.batchProcessArea = document.getElementById('batchProcessArea');
        this.batchProcessHint = document.getElementById('batchProcessHint');
        this.batchProcessInitialActions = document.getElementById('batchProcessInitialActions');
        this.startBatchProcessBtn = document.getElementById('startBatchProcess');
        this.skipBatchProcessBtn = document.getElementById('skipBatchProcess');
        this.batchInputArea = document.getElementById('batchInputArea');
        this.batchInputLabel = document.getElementById('batchInputLabel');
        this.batchInputList = document.getElementById('batchInputList');
        this.batchCandidateArea = document.getElementById('batchCandidateArea');
        this.batchCandidateLabel = document.getElementById('batchCandidateLabel');
        this.batchCandidateList = document.getElementById('batchCandidateList');
        this.confirmBatchSelectionBtn = document.getElementById('confirmBatchSelection');
        this.switchToManualInputBtn = document.getElementById('switchToManualInput');
        this.confirmBatchInputBtn = document.getElementById('confirmBatchInput');
        this.cancelBatchInputBtn = document.getElementById('cancelBatchInput');
        this.batchProgressArea = document.getElementById('batchProgressArea');
        this.batchProgressText = document.getElementById('batchProgressText');
        this.batchProgressFill = document.getElementById('batchProgressFill');
        this.stopBatchProcessBtn = document.getElementById('stopBatchProcess');
        this.batchResultsArea = document.getElementById('batchResultsArea');
        this.batchResultsTable = document.getElementById('batchResultsTable');
        this.fillAllBatchResultsBtn = document.getElementById('fillAllBatchResults');
        this.closeBatchResultsBtn = document.getElementById('closeBatchResults');
        this.batchThoughtsLog = document.getElementById('batchThoughtsLog');
        
        // 页面提取选项区域
        this.pageExtractOptions = document.getElementById('pageExtractOptions');
        this.extractOptionsList = document.getElementById('extractOptionsList');
        
        // 手动输入区域
        this.manualInput = document.getElementById('manualInput');
        this.useManualInputBtn = document.getElementById('useManualInput');
        
        // 字段操作按钮
        this.skipFieldBtn = document.getElementById('skipField');
        this.quitFillingBtn = document.getElementById('quitFilling');
        
        // 填表统计
        this.fillingStats = document.getElementById('fillingStats');
        this.filledCount = document.getElementById('filledCount');
        this.totalFields = document.getElementById('totalFields');
        this.aiFilled = document.getElementById('aiFilled');
        this.manualFilled = document.getElementById('manualFilled');
        this.completionRate = document.getElementById('completionRate');
        
        // 填表控制按钮
        this.fillingControls = document.getElementById('fillingControls');
        this.startFillingBtn = document.getElementById('startFilling');
        this.pauseFillingBtn = document.getElementById('pauseFilling');
        this.resumeFillingBtn = document.getElementById('resumeFilling');
        this.stopFillingBtn = document.getElementById('stopFilling');
        
        // 历史记录列表
        this.fillingHistory = document.getElementById('fillingHistory');
        
        console.log('元素初始化完成');
    }

    bindEvents() {
        console.log('绑定事件...');
        
        // 主要按钮事件
        this.settingsBtn?.addEventListener('click', () => this.toggleAISettings());
        this.closeBtn?.addEventListener('click', () => this.closeSidebar());
        this.backToFormBtn?.addEventListener('click', () => {
            if (this.formTabId) {
                chrome.tabs.update(this.formTabId, { active: true });
            }
        });
        
        // AI设置事件
        this.saveSettingsBtn?.addEventListener('click', () => this.saveAISettings());
        this.testApiBtn?.addEventListener('click', () => this.testAPI());
        this.temperatureSlider?.addEventListener('input', (e) => {
            this.tempValueDisplay.textContent = e.target.value;
        });
        this.showThoughtsCheckbox?.addEventListener('change', (e) => {
            this.aiSettings.showThoughts = e.target.checked;
        });
        this.enableAICheckbox?.addEventListener('change', (e) => {
            this.aiSettings.enableAI = e.target.checked;
        });
        
        // 填表助手事件
        this.useCurrentPageBtn?.addEventListener('click', () => this.useCurrentPage());
        this.parseFormBtn?.addEventListener('click', () => this.parseCurrentForm());
        
        // 作者搜索事件
        this.searchAuthorBtn?.addEventListener('click', () => this.searchAuthorPublications());
        this.prevPaperPageBtn?.addEventListener('click', () => this.changePaperPage(-1));
        this.nextPaperPageBtn?.addEventListener('click', () => this.changePaperPage(1));
        this.searchPaperTitleBtn?.addEventListener('click', () => this.searchPaperByTitle());
        this.usePaperTitleDirectBtn?.addEventListener('click', () => this.usePaperTitleDirectly());

        // 字段操作事件
        this.useAiRecommendationBtn?.addEventListener('click', () => this.useAiRecommendation());
        this.editAiRecommendationBtn?.addEventListener('click', () => this.editAiRecommendation());
        this.useManualInputBtn?.addEventListener('click', () => this.useManualInput());
        this.skipFieldBtn?.addEventListener('click', () => this.skipCurrentField());
        this.skipThinkingBtn?.addEventListener('click', () => this.skipCurrentField());
        this.quitFillingBtn?.addEventListener('click', () => this.quitFilling());
        this.quitThinkingBtn?.addEventListener('click', () => this.quitFilling());
        
        // 填表控制事件
        this.startFillingBtn?.addEventListener('click', () => this.startFillingProcess());
        this.pauseFillingBtn?.addEventListener('click', () => this.pauseFillingProcess());
        this.resumeFillingBtn?.addEventListener('click', () => this.resumeFillingProcess());
        this.stopFillingBtn?.addEventListener('click', () => this.stopFillingProcess());
        
        // 字段选择事件
        this.chooseAIBtn?.addEventListener('click', () => this.handleChoice('ai'));
        this.chooseManualBtn?.addEventListener('click', () => this.handleChoice('manual'));
        this.chooseSkipBtn?.addEventListener('click', () => this.handleChoice('skip'));
        this.chooseQuitBtn?.addEventListener('click', () => this.handleChoice('quit'));
        
        // 批量处理事件
        this.startBatchProcessBtn?.addEventListener('click', () => this.analyzeAndFetchCandidates());
        this.skipBatchProcessBtn?.addEventListener('click', () => this.skipBatchProcess());
        this.confirmBatchSelectionBtn?.addEventListener('click', () => this.startBatchExecutionFromSelection());
        this.switchToManualInputBtn?.addEventListener('click', () => this.showBatchInput());
        this.confirmBatchInputBtn?.addEventListener('click', () => this.startBatchExecution());
        this.cancelBatchInputBtn?.addEventListener('click', () => this.cancelBatchInput());
        this.stopBatchProcessBtn?.addEventListener('click', () => this.stopBatchExecution());
        this.fillAllBatchResultsBtn?.addEventListener('click', () => this.fillAllBatchResults());
        this.closeBatchResultsBtn?.addEventListener('click', () => {
            this.batchProcessArea.style.display = 'none';
            this.processNextField();
        });

        console.log('事件绑定完成');
    }

    // ====== 基本功能 ======
    
    toggleAISettings() {
        const isVisible = this.aiSettingsPanel.style.display !== 'none';
        this.aiSettingsPanel.style.display = isVisible ? 'none' : 'block';
        this.formFillingSection.style.display = isVisible ? 'block' : 'none';
    }

    closeSidebar() {
        if (typeof chrome !== 'undefined' && chrome.sidePanel) {
            chrome.sidePanel.close();
        } else {
            window.close();
        }
    }

    setStatus(text, type = 'ready') {
        if (!this.statusIndicator) return;
        this.statusIndicator.textContent = text;
        this.statusIndicator.className = 'status';
        this.statusIndicator.classList.add(`status-${type}`);
        
        // 如果是错误，记录到日志
        if (type === 'error') {
            console.error('状态栏错误:', text);
        }
    }

    updateFieldStatus(fieldName, status, message) {
        /**
         * 更新单个字段的状态显示（如果当前正在显示该字段）
         */
        console.log(`📌 字段状态更新: ${fieldName} [${status}] - ${message}`);
        
        // 如果当前正在处理这个字段，同步更新状态栏和UI显示
        if (this.activeField && this.activeField.name === fieldName) {
            this.setStatus(message, status);
            
            // 在当前字段信息区域显示预测提示
            const predictionEl = document.getElementById('fieldPredictionTip');
            if (predictionEl) {
                predictionEl.textContent = message;
                predictionEl.style.display = 'block';
            }
        }
    }

    // ====== AI设置管理 ======
    
    async loadAISettings() {
        try {
            if (typeof chrome !== 'undefined' && chrome.storage) {
                const result = await chrome.storage.local.get(['aiSettings']);
                if (result.aiSettings) {
                    this.aiSettings = { ...this.aiSettings, ...result.aiSettings };
                    this.applyAISettingsToUI();
                }
            } else {
                // 如果不在扩展环境中，使用localStorage
                const settings = localStorage.getItem('aiSettings');
                if (settings) {
                    this.aiSettings = { ...this.aiSettings, ...JSON.parse(settings) };
                    this.applyAISettingsToUI();
                }
            }
        } catch (error) {
            console.error('加载AI设置失败:', error);
        }
    }

    applyAISettingsToUI() {
        if (!this.apiKeyInput) return;
        
        this.apiKeyInput.value = this.aiSettings.apiKey || '';
        this.aiModelSelect.value = this.aiSettings.model || 'deepseek-chat';
        this.temperatureSlider.value = this.aiSettings.temperature || 0.7;
        this.tempValueDisplay.textContent = this.aiSettings.temperature || 0.7;
        this.enableAICheckbox.checked = this.aiSettings.enableAI !== false;
        this.showThoughtsCheckbox.checked = this.aiSettings.showThoughts || false;
    }

    async saveAISettings() {
        try {
            this.aiSettings = {
                apiKey: this.apiKeyInput.value.trim(),
                model: this.aiModelSelect.value,
                temperature: parseFloat(this.temperatureSlider.value),
                enableAI: this.enableAICheckbox.checked,
                showThoughts: this.showThoughtsCheckbox.checked
            };
            
            if (typeof chrome !== 'undefined' && chrome.storage) {
                await chrome.storage.local.set({ aiSettings: this.aiSettings });
            } else {
                localStorage.setItem('aiSettings', JSON.stringify(this.aiSettings));
            }
            
            this.setStatus('AI设置已保存', 'success');
            
            // 隐藏设置面板
            setTimeout(() => {
                this.toggleAISettings();
            }, 1000);
            
        } catch (error) {
            console.error('保存AI设置失败:', error);
            this.setStatus('保存失败: ' + error.message, 'error');
        }
    }

    async testAPI() {
        const apiKey = this.apiKeyInput.value.trim();
        
        if (!apiKey) {
            this.setStatus('请输入API密钥', 'warning');
            return;
        }
        
        this.setStatus('正在测试API连接...', 'ai-thinking');
        
        try {
            const response = await fetch('https://api.deepseek.com/models', {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${apiKey}`
                }
            });
            
            if (response.ok) {
                this.setStatus('API连接成功！', 'success');
            } else {
                throw new Error(`API请求失败: ${response.status}`);
            }
            
        } catch (error) {
            console.error('API测试失败:', error);
            this.setStatus('API测试失败: ' + error.message, 'error');
        }
    }

    // ====== 填表助手功能 ======
    
    async useCurrentPage() {
        try {
            if (typeof chrome !== 'undefined' && chrome.tabs) {
                const tabs = await chrome.tabs.query({ 
                    active: true, 
                    currentWindow: true 
                });
                if (tabs.length > 0) {
                    this.formUrlInput.value = tabs[0].url;
                    this.currentFormUrl = tabs[0].url;
                    this.setStatus('已获取当前页面URL', 'success');
                }
            } else {
                // 如果不在扩展环境中，使用当前页面URL（仅用于演示）
                this.formUrlInput.value = window.location.href;
                this.currentFormUrl = window.location.href;
                this.setStatus('已获取当前页面URL', 'success');
            }
        } catch (error) {
            console.error('获取当前页面失败:', error);
            this.setStatus('获取当前页面失败: ' + error.message, 'error');
        }
    }


    async parseCurrentForm() {
        const url = this.formUrlInput.value.trim();
        if (!url) {
            this.setStatus('请输入表单URL', 'warning');
            return;
        }
        this.currentFormUrl = url;
        this.setStatus('正在获取页面内容...', 'searching');

        try {
            const crawlData = await fetchCrawl4AIPageContent(url);
            if (!crawlData || !crawlData.html) {
                const crawlError = crawlData && crawlData.error ? `: ${crawlData.error}` : '';
                this.setStatus(`Crawl4AI 解析失败${crawlError}`, 'error');
                return;
            }

            console.log('✅ 使用 Crawl4AI 获取页面成功，长度:', crawlData.html.length);
            console.log('Crawl4AI HTML 片段:', crawlData.html.substring(0, 1000));

            const { schema, fields } = await extractFormFieldsFromHtml(crawlData.html);
            console.log('schema-extractor forms:', schema?.forms || []);
            console.log('解析出的字段示例：', fields[0] || null);
            const achievementField = fields.find(f => (f.label || '').includes('成果类型') || (f.name || '').includes('成果类型'));
            console.log('成果类型字段的 options：', achievementField ? achievementField.options : null);

            if (!fields || fields.length === 0) {
                this.setStatus('未找到可填写字段', 'warning');
                return;
            }

            this.formTabId = null;
            if (typeof chrome !== 'undefined' && chrome.tabs) {
                const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
                if (tabs && tabs.length > 0) {
                    this.formTabId = tabs[0].id;
                    if (this.backToFormBtn) this.backToFormBtn.style.display = 'block';
                }
            }

            this.currentFormFields = fields;
            this.requiredPaperFields = this.deriveRequiredPaperFields(fields);
            this.renderFormFields(fields);

            const fieldCount = fields.length;
            this.resetToStartPage();
            this.setStatus(`成功解析 ${fieldCount} 个字段，请选择论文（schema-extractor）`, 'success');
            this.authorSearchArea.style.display = 'block';
            this.fillingProgress.style.display = 'none';
            this.fillingControls.style.display = 'none';
            this.fillingStats.style.display = 'none';
            this.updateStats();
        } catch (error) {
            console.error('解析表单错误:', error);
            this.setStatus('解析出错: ' + error.message, 'error');
        }
    }

    // ====== 作者搜索功能 ======

    async searchAuthorPublications() {
        const authorName = this.authorNameInput.value.trim();
        if (!authorName) {
            this.setStatus('请输入作者姓名', 'warning');
            return;
        }

        this.currentAuthor = authorName;
        this.currentPaperPage = 0;
        this.setStatus(`正在搜索 ${authorName} 的论文...`, 'searching');
        this.searchAuthorBtn.disabled = true;

        await this.fetchAndRenderPapers();
        this.searchAuthorBtn.disabled = false;
    }

    async fetchAndRenderPapers(filters = {}) {
        try {
            this.searchFilters = { ...(filters || {}) };
            // 1. 统一搜索作者 (DBLP -> Semantic Scholar)
            // 如果提供了高级过滤参数，则跳过作者搜索，直接进行论文搜索
            let authorResult = { total: 0, items: [] };
            
            // 如果没有提供过滤器，或者只提供了年份过滤器（可以基于作者搜索后过滤），则先搜作者
            // 注意：如果提供了机构或期刊，必须用高级搜索
            if (!filters.affiliation && !filters.venue) {
                authorResult = await unifiedSearchAuthors(this.currentAuthor);
            }
            
            // 如果找到多个作者，且不是高级搜索模式，弹出选择框
            // 注意：使用 items.length 判断而不是 total，因为 total 可能很大但当前页只返回了部分
            if (authorResult.items.length > 1 && !filters.affiliation && !filters.venue) {
                console.log(`找到 ${authorResult.items.length} 位作者，请求用户消歧...`);
                // 不再弹窗，而是通过 renderStatsChips 显示筛选
            }
            
            // 定义结果处理函数
            const handleResult = (result) => {
                // 如果结果太多 (>100) 且没有使用过滤，提示用户使用高级搜索
                // 注意：如果已经是在高级搜索模式下，就不再提示了，除非结果实在太多且用户想进一步过滤
                if (result.total > 100 && !filters.affiliation && !filters.venue && !filters.yearStart) {
                     this.showAdvancedSearchPrompt(result.total);
                }
                
                const processed = this.processPapersForDisplay(result.items || []);

                this.rawPapers = processed;
                this.originalPaperTotal = result.total;
                this.currentPaperTotal = processed.length;
                this.currentSource = result.source;
                
                // 提取统计信息 (Year, Venue, Author)
                this.extractPaperStats(this.rawPapers);
                
                // 应用客户端过滤 (Year, Venue, Author)
                this.filterAndRenderPapers();
            };

            if (authorResult.items.length === 0) {
                 // 如果完全找不到作者，提示用户是否使用关键字搜索
                 // 不再自动进行 broad paper search (Fallback Chain)
                 
                 // 如果是高级搜索（带 filters），直接搜论文是可以接受的
                 if (filters.affiliation || filters.venue) {
                     const limit = 100;
                     const result = await unifiedGetPublications(this.currentAuthor, 0, limit, filters, this.requiredPaperFields);
                     handleResult(result);
                     return;
                 }
                 
                 // 如果只是按名字搜作者失败，弹出提示
                 this.showAuthorNotFoundModal(this.currentAuthor);
                 return;
            }

            // 2. 如果找到作者（且只有1个），获取第一个作者的 PID/ID
            // 如果找到多个作者，这里不应该直接选第一个，而是应该在 handleResult 之前让用户选？
            // 不，用户的意思是：在论文列表界面显示所有相关作者作为筛选项
            
            // 为了实现"显示所有可能的作者"，我们需要：
            // 1. 获取所有同名作者的论文？这可能太多了。
            // 2. 或者，如果用户选择了"直接搜论文"，我们从结果中提取作者。
            // 3. 用户的场景是：搜"Xianling Mao"，DBLP 返回了多个作者，但他不想弹窗选，而是想先看论文，然后通过 Chips 过滤。
            
            // 现在的逻辑是：如果 authorResult > 1，弹窗。
            // 用户的需求是：像选年份一样选作者。这意味着我们需要把所有可能作者的论文都拉取下来？
            // 或者，我们可以把 searchAuthors 的结果作为 Filter Chips 显示，点击某个作者再 Fetch 那个作者的论文。
            
            // 修改方案：
            // 如果找到多个作者，不再弹模态框，而是显示"作者筛选" Chips。
            // 默认情况下，我们可能需要显示提示，或者默认拉取第一个作者的论文？
            // 或者，我们可以不拉取论文，只显示作者 Chips，让用户点？
            
            // 更好的方案：
            // 1. 如果找到多个作者，将它们渲染为 Filter Chips (Author Filter)。
            // 2. 默认拉取最匹配的作者（第一个）的论文，并在 UI 上选中该作者 Chip。
            // 3. 用户点击其他作者 Chip 时，重新 Fetch 该作者的论文。
            
            const authors = authorResult.items;
            this.availableAuthors = authors;
            
            const defaultAuthor = authors[0];
            this.activeFilters.authorId = defaultAuthor.id;

            const result = await this.fetchRecentPapersForAuthor(defaultAuthor, filters);
            handleResult(result);

        } catch (error) {
            console.error('搜索流程失败:', error);
            // 最后的兜底
            try {
                const limit = 100;
                const result = await unifiedGetPublications(this.currentAuthor, 0, limit, filters, this.requiredPaperFields);
                
                this.rawPapers = result.items;
                this.currentPaperTotal = result.total;
                this.extractPaperStats(this.rawPapers);
                this.filterAndRenderPapers();
                
            } catch (fallbackError) {
                this.setStatus('搜索失败: ' + fallbackError.message, 'error');
            }
        }
    }

    showAuthorNotFoundModal(authorName) {
        let modal = document.getElementById('authorNotFoundModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'authorNotFoundModal';
            modal.style.cssText = `
                display: none; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
                background: white; padding: 20px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);
                z-index: 10002; width: 300px; border: 1px solid #e2e8f0; text-align: center;
            `;
            document.body.appendChild(modal);
        }
        
        modal.innerHTML = `
            <div style="font-size: 24px; margin-bottom: 10px;">🤔</div>
            <h4 style="margin: 0 0 10px 0;">未找到作者档案</h4>
            <p style="font-size: 13px; color: #718096; margin-bottom: 20px;">
                在 DBLP 和 Semantic Scholar 中未找到名为 "<strong>${this.escapeHtml(authorName)}</strong>" 的作者。
            </p>
            <div style="display: flex; flex-direction: column; gap: 10px;">
                <button id="searchAsKeywordBtn" class="btn btn-primary" style="width: 100%;">
                    作为关键字直接搜索论文
                </button>
                <button id="useAdvancedSearchBtn" class="btn btn-secondary" style="width: 100%;">
                    使用高级搜索 (机构/期刊)
                </button>
                <button id="cancelNotFoundBtn" class="btn btn-text" style="width: 100%; color: #a0aec0;">
                    取消
                </button>
            </div>
        `;
        
        modal.querySelector('#searchAsKeywordBtn').onclick = async () => {
            modal.style.display = 'none';
            this.setStatus(`正在搜索包含 "${authorName}" 的论文...`, 'searching');
            const limit = 100;
            const result = await unifiedGetPublications(authorName, 0, limit, {}, this.requiredPaperFields);
            this.rawPapers = result.items;
            this.currentPaperTotal = result.total;
            this.currentSource = result.source;
            this.extractPaperStats(this.rawPapers);
            this.filterAndRenderPapers();
        };
        
        modal.querySelector('#useAdvancedSearchBtn').onclick = () => {
            modal.style.display = 'none';
            this.showAdvancedSearchPrompt(0); // Show advanced search modal
        };
        
        modal.querySelector('#cancelNotFoundBtn').onclick = () => {
            modal.style.display = 'none';
            this.setStatus('已取消搜索', 'warning');
        };
        
        modal.style.display = 'block';
    }

    showAuthorSelectionModal(authors) {
        // 创建或显示作者选择模态框
        let modal = document.getElementById('authorSelectionModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'authorSelectionModal';
            modal.style.cssText = `
                display: none; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
                background: white; padding: 20px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);
                z-index: 10001; width: 350px; border: 1px solid #e2e8f0; max-height: 80vh; overflow-y: auto;
            `;
            // 添加到 body
            document.body.appendChild(modal);
        }
        
        modal.innerHTML = `
            <h4 style="margin-top:0; margin-bottom: 10px;">👤 请选择正确的作者</h4>
            <p style="font-size: 12px; color: #718096; margin-bottom: 10px;">找到多位同名作者，请根据信息选择：</p>
            <div id="authorList" style="display: flex; flex-direction: column; gap: 8px;"></div>
            <div style="display:flex; justify-content:flex-end; margin-top: 15px;">
                <button id="cancelAuthorSelect" class="btn btn-secondary">取消</button>
            </div>
        `;
        
        const listContainer = modal.querySelector('#authorList');
        
        authors.forEach(author => {
            const div = document.createElement('div');
            div.style.cssText = `
                padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px; cursor: pointer;
                transition: background 0.2s;
            `;
            div.onmouseover = () => div.style.background = '#f7fafc';
            div.onmouseout = () => div.style.background = 'white';
            
            // 构建别名显示
            const aliases = author.aliases && author.aliases.length > 0 ? 
                `<div style="font-size: 11px; color: #718096;">别名: ${author.aliases.join(', ')}</div>` : '';
            
            // 构建元数据显示 (例如 S2 的论文数)
            const meta = author.meta ? 
                `<div style="font-size: 11px; color: #4a5568; margin-top: 2px;">${author.meta}</div>` : '';
                
            div.innerHTML = `
                <div style="font-weight: bold; color: #2d3748;">${author.name} <span style="font-weight:normal; font-size:11px; color:#a0aec0;">(${author.source})</span></div>
                ${aliases}
                ${meta}
            `;
            
            div.onclick = async () => {
                modal.style.display = 'none';
                this.setStatus(`已选择作者: ${author.name}，正在获取论文...`, 'searching');
                
                // 使用选中的作者获取论文
                try {
                    const limit = 100;
                    const result = await this.fetchRecentPapersForAuthor(author, this.searchFilters);
                    
                    this.rawPapers = result.items;
                    this.currentPaperTotal = result.total;
                    this.currentSource = result.source;
                    this.extractPaperStats(this.rawPapers);
                    this.filterAndRenderPapers();
                } catch (e) {
                    this.setStatus('获取论文失败: ' + e.message, 'error');
                }
            };
            
            listContainer.appendChild(div);
        });
        
        modal.querySelector('#cancelAuthorSelect').onclick = () => {
            modal.style.display = 'none';
            this.setStatus('已取消作者选择', 'warning');
        };
        
        modal.style.display = 'block';
    }

    extractPaperStats(papers) {
        // 统计年份
        const yearStats = {};
        papers.forEach(p => {
            if (p.year) {
                yearStats[p.year] = (yearStats[p.year] || 0) + 1;
            }
        });
        // 排序年份 (倒序)
        this.yearOptions = Object.entries(yearStats)
            .sort((a, b) => b[0].localeCompare(a[0]))
            .map(([year, count]) => ({ value: year, label: `${year} (${count})` }));

        // 统计期刊/会议 (Venue)
        const venueStats = {};
        papers.forEach(p => {
            if (p.venue) {
                // 简单清理 venue 名称
                const v = p.venue.trim();
                venueStats[v] = (venueStats[v] || 0) + 1;
            }
        });
        // 排序 Venue (按数量倒序)
        this.venueOptions = Object.entries(venueStats)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10) // 只取前10个
            .map(([venue, count]) => ({ value: venue, label: `${venue} (${count})` }));
            
        // 渲染统计 Chips
        this.renderStatsChips();
    }

    renderStatsChips() {
        const container = document.getElementById('paperStatsChips');
        if (!container) {
            // 如果不存在，创建它 (插入到 authorSearchArea 中，paperList 之前)
            const newContainer = document.createElement('div');
            newContainer.id = 'paperStatsChips';
            newContainer.style.marginBottom = '10px';
            newContainer.style.display = 'flex';
            newContainer.style.flexDirection = 'column'; // 改为垂直布局以容纳多行
            newContainer.style.gap = '8px';
            
            const list = document.getElementById('paperList');
            // 确保 list 存在且有父节点
            if (list && list.parentNode) {
                list.parentNode.insertBefore(newContainer, list);
            } else {
                // 兜底：添加到 selection area
                this.paperSelectionArea.appendChild(newContainer);
            }
            this.paperStatsChips = newContainer;
        }
        
        this.paperStatsChips.innerHTML = '';
        
        // 1. 渲染作者筛选栏 (Author Filter)
        if (this.availableAuthors && this.availableAuthors.length > 1) {
            const authorRow = document.createElement('div');
            authorRow.style.cssText = 'display: flex; flex-wrap: wrap; gap: 5px; align-items: center; background: #f7fafc; padding: 8px; border-radius: 6px; border: 1px dashed #cbd5e0;';
            
            const label = document.createElement('span');
            label.textContent = '👤 可能是以下作者 (点击切换):';
            label.style.cssText = 'font-size: 11px; color: #718096; font-weight: bold; margin-right: 4px;';
            authorRow.appendChild(label);
            
            this.availableAuthors.forEach(author => {
                const btn = document.createElement('button');
                const isActive = this.activeFilters.authorId === author.id;
                
                // 构建显示名称
                let displayName = author.name;
                // 如果有别名，显示第一个别名作为补充
                // if (author.aliases && author.aliases.length > 0) displayName += ` / ${author.aliases[0]}`;
                // 显示来源标记
                displayName += ` (${author.source})`;
                
                btn.textContent = displayName;
                btn.className = isActive ? 'filter-chip active' : 'filter-chip';
                btn.style.cssText = `
                    padding: 4px 10px; border-radius: 12px; font-size: 11px; border: 1px solid; cursor: pointer; transition: all 0.2s;
                    ${isActive 
                        ? 'background: #3182ce; color: white; border-color: #2b6cb0; box-shadow: 0 1px 2px rgba(0,0,0,0.1);' 
                        : 'background: white; color: #4a5568; border-color: #e2e8f0;'}
                `;
                
                btn.onclick = async () => {
                    if (isActive) return;
                    
                    // 切换作者
                    this.activeFilters.authorId = author.id;
                    this.renderStatsChips(); // 立即更新 UI 状态
                    
                    // 重新加载该作者的论文
                    this.setStatus(`正在切换至作者: ${author.name}...`, 'searching');
                    try {
                        const result = await this.fetchRecentPapersForAuthor(author, this.searchFilters);
                        
                        this.rawPapers = result.items;
                        this.currentPaperTotal = result.total;
                        this.currentSource = result.source;
                        
                        // 重新提取统计并渲染 (会再次调用 renderStatsChips，但状态已更新)
                        this.extractPaperStats(this.rawPapers);
                        this.filterAndRenderPapers();
                        
                    } catch (e) {
                        this.setStatus('切换作者失败: ' + e.message, 'error');
                    }
                };
                
                authorRow.appendChild(btn);
            });
            
            this.paperStatsChips.appendChild(authorRow);
        }

        // 2. 渲染年份和会议筛选栏 (Year & Venue Filters)
        const filtersRow = document.createElement('div');
        filtersRow.style.cssText = 'display: flex; flex-wrap: wrap; gap: 5px; align-items: center;';
        
        // 辅助函数：创建 Chip
        const createChip = (label, value, type) => {
            const btn = document.createElement('button');
            const isActive = this.activeFilters[type] === value;
            btn.textContent = label;
            btn.style.cssText = `
                padding: 3px 8px; border-radius: 12px; font-size: 11px; border: 1px solid #e2e8f0; cursor: pointer;
                background: ${isActive ? '#ebf8ff' : 'white'};
                color: ${isActive ? '#2b6cb0' : '#4a5568'};
                border-color: ${isActive ? '#bee3f8' : '#e2e8f0'};
            `;
            btn.onclick = () => this.toggleFilter(type, value);
            return btn;
        };

        // 年份
        if (this.yearOptions && this.yearOptions.length > 0) {
            this.yearOptions.forEach(opt => {
                filtersRow.appendChild(createChip(opt.label, opt.value, 'year'));
            });
            
            // 分隔符
            if (this.venueOptions && this.venueOptions.length > 0) {
                const sep = document.createElement('span');
                sep.style.cssText = 'width: 1px; height: 16px; background: #cbd5e0; margin: 0 4px;';
                filtersRow.appendChild(sep);
            }
        }

        // 会议
        if (this.venueOptions && this.venueOptions.length > 0) {
            this.venueOptions.forEach(opt => {
                filtersRow.appendChild(createChip(opt.label, opt.value, 'venue'));
            });
        }
        
        if (filtersRow.children.length > 0) {
            this.paperStatsChips.appendChild(filtersRow);
        }
    }

    toggleFilter(type, value) {
        if (this.activeFilters[type] === value) {
            this.activeFilters[type] = null; // 取消选中
        } else {
            this.activeFilters[type] = value; // 选中
        }
        this.renderStatsChips(); // 更新选中状态样式
        this.filterAndRenderPapers();
    }

    filterAndRenderPapers() {
        let filtered = this.rawPapers || [];
        
        if (this.activeFilters.year) {
            filtered = filtered.filter(p => p.year == this.activeFilters.year);
        }
        if (this.activeFilters.venue) {
            filtered = filtered.filter(p => p.venue && p.venue.trim() == this.activeFilters.venue);
        }
        
        this.currentPapers = filtered;
        // 更新总数显示 (显示过滤后的数量 / 总数量)
        // this.currentPaperTotal 是原始总数，这里我们只显示当前过滤后的列表
        // 实际分页逻辑变得复杂，因为是客户端过滤。简单起见，我们对过滤后的结果进行分页。
        this.filteredTotal = filtered.length;
        this.currentPaperPage = 0; // 重置页码
        
        this.renderPaperList();
        this.updatePagination(); // 注意 updatePagination 需要适配 filteredTotal
        
        const sourceText = this.currentSource ? ` (来源: ${this.currentSource})` : '';
        const recentText = this.lastRecentInfo ? ` (${this.lastRecentInfo})` : '';
        if (filtered.length > 0) {
            this.paperSelectionArea.style.display = 'block';
            const baseTotal = typeof this.originalPaperTotal === 'number' ? this.originalPaperTotal : this.currentPaperTotal;
            const totalText = baseTotal !== this.currentPaperTotal ? ` (共 ${baseTotal}，过滤后 ${this.currentPaperTotal})` : ` (共 ${this.currentPaperTotal})`;
            this.setStatus(`显示 ${filtered.length} 篇论文${totalText}${recentText}${sourceText}`, 'success');
        } else {
            const baseTotal = typeof this.originalPaperTotal === 'number' ? this.originalPaperTotal : this.currentPaperTotal;
            const totalText = baseTotal !== this.currentPaperTotal ? ` (共 ${baseTotal}，过滤后 ${this.currentPaperTotal})` : ` (共 ${this.currentPaperTotal})`;
            this.setStatus(`未找到匹配的论文${totalText}${recentText}${sourceText}`, 'warning');
            this.paperList.innerHTML = '<div style="padding:10px; color:#718096; text-align:center;">无匹配结果</div>';
        }
    }

    showAdvancedSearchPrompt(total) {
        // 创建或显示高级搜索提示模态框
        let modal = document.getElementById('advancedSearchModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'advancedSearchModal';
            modal.style.cssText = `
                display: none; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
                background: white; padding: 20px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);
                z-index: 10000; width: 300px; border: 1px solid #e2e8f0;
            `;
            modal.innerHTML = `
                <h4 style="margin-top:0">🔍 搜索结果过多 (${total}+)</h4>
                <p style="font-size: 12px; color: #718096;">请输入更多信息以缩小范围：</p>
                <div style="margin-bottom: 10px;">
                    <label style="display:block; font-size:12px; font-weight:bold;">所属机构 (Affiliation)</label>
                    <input type="text" id="advAffiliation" style="width:100%; padding:6px; border:1px solid #cbd5e0; border-radius:4px;" placeholder="例如: Tsinghua University">
                </div>
                <div style="margin-bottom: 10px;">
                    <label style="display:block; font-size:12px; font-weight:bold;">期刊/会议 (Venue)</label>
                    <input type="text" id="advVenue" style="width:100%; padding:6px; border:1px solid #cbd5e0; border-radius:4px;" placeholder="例如: CVPR">
                </div>
                <div style="margin-bottom: 15px;">
                    <label style="display:block; font-size:12px; font-weight:bold;">年份范围</label>
                    <div style="display:flex; gap:5px;">
                        <input type="number" id="advYearStart" style="width:50%; padding:6px; border:1px solid #cbd5e0; border-radius:4px;" placeholder="开始年份">
                        <input type="number" id="advYearEnd" style="width:50%; padding:6px; border:1px solid #cbd5e0; border-radius:4px;" placeholder="结束年份">
                    </div>
                </div>
                <div style="display:flex; justify-content:flex-end; gap:8px;">
                    <button id="advCancel" class="btn btn-secondary">暂不使用</button>
                    <button id="advSearch" class="btn btn-primary">重新搜索</button>
                </div>
            `;
            document.body.appendChild(modal);
            
            // 绑定事件
            modal.querySelector('#advCancel').onclick = () => modal.style.display = 'none';
            modal.querySelector('#advSearch').onclick = () => {
                const filters = {
                    affiliation: document.getElementById('advAffiliation').value.trim(),
                    venue: document.getElementById('advVenue').value.trim(),
                    yearStart: document.getElementById('advYearStart').value.trim(),
                    yearEnd: document.getElementById('advYearEnd').value.trim()
                };
                modal.style.display = 'none';
                this.setStatus('正在使用高级过滤搜索...', 'searching');
                this.currentPaperPage = 0; // 重置页码
                this.fetchAndRenderPapers(filters);
            };
        }
        
        // 填充提示文本并显示
        modal.querySelector('h4').textContent = `🔍 搜索结果过多 (${total}+)`;
        modal.style.display = 'block';
    }

    _renderPublications(result) {
        this.currentPapers = result.items;
        this.currentPaperTotal = result.total;
        
        this.renderPaperList();
        this.updatePagination();
        
        if (this.currentPapers.length > 0) {
            this.paperSelectionArea.style.display = 'block';
            const sourceText = result.source ? ` (来源: ${result.source})` : '';
            this.setStatus(`找到 ${result.total} 篇论文${sourceText}`, 'success');
        } else {
            this.paperSelectionArea.style.display = 'none';
            if (result.error) {
                this.setStatus(`搜索失败: ${result.error}`, 'error');
            } else {
                this.setStatus('未找到相关论文', 'warning');
            }
        }
    }

    renderPaperList() {
        this.paperList.innerHTML = '';
        const list = Array.isArray(this.currentPapers) ? this.currentPapers : [];
        const start = this.currentPaperPage * 10;
        const end = start + 10;
        const pageItems = list.slice(start, end);
        
        pageItems.forEach((paper) => {
            const div = document.createElement('div');
            div.style.padding = '10px';
            div.style.borderBottom = '1px solid #edf2f7';
            div.style.cursor = 'pointer';
            div.style.fontSize = '12px';
            div.className = 'paper-item';
            
            const authors = Array.isArray(paper.authors) ? paper.authors.join(', ') : (paper.authors || '');
            const venue = paper.venue ? `${paper.venue} ${paper.year}` : paper.year;
            
            div.innerHTML = `
                <div style="font-weight: bold; color: #2d3748; margin-bottom: 4px;">${this.escapeHtml(paper.title)}</div>
                <div style="color: #718096; margin-bottom: 2px;">${this.escapeHtml(authors)}</div>
                <div style="color: #4a5568; font-style: italic;">${this.escapeHtml(venue)}</div>
            `;
            
            div.onclick = async () => {
                await this.selectPaper(paper);
            };
            this.paperList.appendChild(div);
        });
    }

    updatePagination() {
        this.paperPageInfo.textContent = `第 ${this.currentPaperPage + 1} 页`;
        this.prevPaperPageBtn.disabled = this.currentPaperPage === 0;
        const total = typeof this.filteredTotal === 'number' ? this.filteredTotal : this.currentPaperTotal;
        this.nextPaperPageBtn.disabled = (this.currentPaperPage + 1) * 10 >= total;
    }

    async changePaperPage(delta) {
        this.currentPaperPage += delta;
        if (this.currentPaperPage < 0) this.currentPaperPage = 0;
        if (this.rawPapers && this.rawPapers.length) {
            this.renderPaperList();
            this.updatePagination();
            return;
        }
        this.setStatus(`正在加载第 ${this.currentPaperPage + 1} 页...`, 'searching');
        await this.fetchAndRenderPapers(this.searchFilters);
    }

    async selectPaper(paper) {
        console.log('用户选择了论文:', paper);
        this.selectedPaper = { ...(paper || {}) };
        window.__tempAuthors = (this.selectedPaper.authors || []).map((name, index) => {
            let affiliation = '';
            if (this.selectedPaper.authorAffiliations && this.selectedPaper.authorAffiliations[index]) {
                affiliation = this.selectedPaper.authorAffiliations[index];
            }
            return { name, affiliation };
        });
        console.log('✅ 已保存作者列表到 window.__tempAuthors:', window.__tempAuthors);
        this.setStatus(`已选择: ${paper.title}，正在补充元数据...`, 'searching');
        
        const doi = this.selectedPaper.doi;
        if (doi) {
            const merged = { ...(this.selectedPaper || {}) };
            try {
                // 基础字段（总是需要的）
                const baseFields = ['title', 'authors', 'year', 'venue', 'doi', 'url'];
                
                // 根据表单需求动态决定是否需要额外字段
                const needAbstract = this.requiredPaperFields.includes('abstract');
                const needKeywords = this.requiredPaperFields.includes('keywords');
                const needCitation = this.requiredPaperFields.includes('citationCount');
                const needGrants = this.requiredPaperFields.includes('grants');
                
                // 构建各个API的 select/fields 参数
                let selectOpenAlex = [...baseFields];
                if (needAbstract) selectOpenAlex.push('abstract_inverted_index');
                if (needKeywords) selectOpenAlex.push('keywords');
                if (needCitation) selectOpenAlex.push('cited_by_count');
                if (needGrants) selectOpenAlex.push('grants');
                
                let selectCrossref = [...baseFields];
                if (needAbstract) selectCrossref.push('abstract');
                if (needKeywords) selectCrossref.push('subject');
                // 注意：CrossRef 本身不提供 citationCount，但我们保留占位，实际从其他API获取
                if (needCitation) selectCrossref.push('citationCount'); // 可能无效，但保留
                
                let selectS2 = [...baseFields];
                if (needAbstract) selectS2.push('abstract');
                if (needKeywords) selectS2.push('fieldsOfStudy');
                if (needCitation) selectS2.push('citationCount');
                
                // 并行调用API，只请求必要字段
                const [s2Result, crossrefResult, openalexResult] = await Promise.allSettled([
                    getSemanticScholarPaperByDoi(doi, selectS2.join(',')),
                    getCrossrefPaperByDoi(doi, selectCrossref.join(',')),
                    getOpenAlexPaperByDoi(doi, selectOpenAlex.join(','))
                ]);
                
                // 处理 Crossref 结果
                if (crossrefResult.status === 'fulfilled') {
                    const crossref = crossrefResult.value;
                    merged.conferenceName = crossref.conferenceName || merged.conferenceName;
                    merged.conferenceLocation = crossref.conferenceLocation || merged.conferenceLocation;
                    merged.articleNumber = crossref.articleNumber || merged.articleNumber;
                    merged.firstPage = crossref.firstPage || merged.firstPage;
                    merged.lastPage = crossref.lastPage || merged.lastPage;
                    merged.pageRange = crossref.pageRange || merged.pageRange;
                    merged.publicationDate = crossref.publicationDate || merged.publicationDate;
                    merged.publicationMonth = crossref.publicationMonth || merged.publicationMonth;
                    merged.publicationDay = crossref.publicationDay || merged.publicationDay;
                    merged.conferenceEventDate = crossref.conferenceEventDate || merged.conferenceEventDate;
                    merged.conferenceStartDate = crossref.conferenceStartDate || merged.conferenceStartDate;
                    merged.conferenceEndDate = crossref.conferenceEndDate || merged.conferenceEndDate;
                    merged.language = crossref.language || merged.language;
                    if (crossref.keywords) {
                        merged.keywords = [...new Set([...(merged.keywords || []), ...crossref.keywords])];
                    }
                    if (needAbstract && crossref.abstract) {
                        merged.abstract = crossref.abstract;
                    }
                }
                
                // 处理 OpenAlex 结果
                if (openalexResult.status === 'fulfilled') {
                    const openalex = openalexResult.value;
                    if (needCitation && merged.citationCount == null && openalex.citationCount != null) {
                        merged.citationCount = openalex.citationCount;
                    }
                    if (needAbstract && !merged.abstract && openalex.abstract) {
                        merged.abstract = openalex.abstract;
                    }
                    if (needGrants && openalex.grants) {
                        merged.grants = openalex.grants;
                    }
                    merged.articleNumber = merged.articleNumber || openalex.articleNumber;
                    merged.firstPage = merged.firstPage || openalex.firstPage;
                    merged.lastPage = merged.lastPage || openalex.lastPage;
                    merged.pageRange = merged.pageRange || openalex.pageRange;
                    merged.publicationDate = merged.publicationDate || openalex.publicationDate;
                    merged.publicationMonth = merged.publicationMonth || openalex.publicationMonth;
                    merged.publicationDay = merged.publicationDay || openalex.publicationDay;
                    merged.language = merged.language || openalex.language;
                    if (openalex.keywords) {
                        merged.keywords = [...new Set([...(merged.keywords || []), ...openalex.keywords])];
                    }
                }
                
                // 处理 Semantic Scholar 结果
                if (s2Result.status === 'fulfilled') {
                    const s2 = s2Result.value;
                    if (needCitation && merged.citationCount == null && s2.citationCount != null) {
                        merged.citationCount = s2.citationCount;
                    }
                    if (needAbstract && !merged.abstract && s2.abstract) {
                        merged.abstract = s2.abstract;
                    }
                    merged.openAccessPdf = merged.openAccessPdf || s2.openAccessPdf;
                    merged.publicationDate = merged.publicationDate || s2.publicationDate;
                    if (s2.keywords) {
                        merged.keywords = [...new Set([...(merged.keywords || []), ...s2.keywords])];
                    }
                }
                
                // 更新 this.selectedPaper
                this.selectedPaper = merged;
            } catch (e) {
                console.warn('补充论文元数据失败:', e);
                // 如果失败，保留原始选中的论文
            }
        }

        const venueBase = this.selectedPaper.venue || this.selectedPaper.conferenceName || '';
        const { formatted, shortName, rating } = this.formatVenueWithYearAndCCF(venueBase, this.selectedPaper.year);
        this.selectedPaper.venueRaw = venueBase;
        this.selectedPaper.venueFormatted = formatted || venueBase;
        this.selectedPaper.venueShort = shortName || '';
        this.selectedPaper.ccfRating = rating || '';
        
        this.setStatus(`已选择: ${this.selectedPaper.title}`, 'success');
        
        const filterCtx = {
            year: this.activeFilters.year,
            venue: this.activeFilters.venue,
            affiliation: this.searchFilters?.affiliation || '',
            venueQuery: this.searchFilters?.venue || '',
            yearStart: this.searchFilters?.yearStart || '',
            yearEnd: this.searchFilters?.yearEnd || ''
        };

        this.filledContext = {
            '论文标题': { label: '论文标题', answer: this.selectedPaper.title || '', fieldType: 'text' },
            '论文作者': { label: '论文作者', answer: Array.isArray(this.selectedPaper.authors) ? this.selectedPaper.authors.join(', ') : (this.selectedPaper.authors || ''), fieldType: 'text' },
            '期刊/会议': { label: '期刊/会议', answer: this.selectedPaper.venueFormatted || this.selectedPaper.venue || '', fieldType: 'text' },
            '期刊/会议(原始)': { label: '期刊/会议(原始)', answer: this.selectedPaper.venueRaw || this.selectedPaper.venue || '', fieldType: 'text' },
            '会议简称': { label: '会议简称', answer: this.selectedPaper.venueShort || '', fieldType: 'text' },
            'CCF评级': { label: 'CCF评级', answer: this.selectedPaper.ccfRating || '', fieldType: 'text' },
            '年份': { label: '年份', answer: this.selectedPaper.year || '', fieldType: 'text' },
            'DOI': { label: 'DOI', answer: this.selectedPaper.doi || '', fieldType: 'text' },
            '链接': { label: '链接', answer: this.selectedPaper.url || '', fieldType: 'url' },
            '摘要': { label: '摘要', answer: this.selectedPaper.abstract || '', fieldType: 'text' },
            '关键词': { label: '关键词', answer: Array.isArray(this.selectedPaper.keywords) ? this.selectedPaper.keywords.join(', ') : (this.selectedPaper.keywords || ''), fieldType: 'text' },
            '引用次数': { label: '引用次数', answer: this.selectedPaper.citationCount != null ? String(this.selectedPaper.citationCount) : '', fieldType: 'text' },
            '基金/资助': { label: '基金/资助', answer: Array.isArray(this.selectedPaper.grants) ? JSON.stringify(this.selectedPaper.grants) : (this.selectedPaper.grants || ''), fieldType: 'text' },
            '文章号/编码': { label: '文章号/编码', answer: this.selectedPaper.articleNumber || '', fieldType: 'text' },
            '起始页码': { label: '起始页码', answer: this.selectedPaper.firstPage || '', fieldType: 'text' },
            '终止页码': { label: '终止页码', answer: this.selectedPaper.lastPage || '', fieldType: 'text' },
            '页码范围': { label: '页码范围', answer: this.selectedPaper.pageRange || '', fieldType: 'text' },
            '发表日期': { label: '发表日期', answer: this.selectedPaper.publicationDate || '', fieldType: 'text' },
            '发表月份': { label: '发表月份', answer: this.selectedPaper.publicationMonth || '', fieldType: 'text' },
            '发表日': { label: '发表日', answer: this.selectedPaper.publicationDay || '', fieldType: 'text' },
            '会议举办日期': { label: '会议举办日期', answer: this.selectedPaper.conferenceEventDate || '', fieldType: 'text' },
            '会议开始日期': { label: '会议开始日期', answer: this.selectedPaper.conferenceStartDate || '', fieldType: 'text' },
            '会议结束日期': { label: '会议结束日期', answer: this.selectedPaper.conferenceEndDate || '', fieldType: 'text' },
            '会议开始月份': { label: '会议开始月份', answer: this.selectedPaper.conferenceStartMonth || '', fieldType: 'text' },
            '会议开始日': { label: '会议开始日', answer: this.selectedPaper.conferenceStartDay || '', fieldType: 'text' },
            '会议结束月份': { label: '会议结束月份', answer: this.selectedPaper.conferenceEndMonth || '', fieldType: 'text' },
            '会议结束日': { label: '会议结束日', answer: this.selectedPaper.conferenceEndDay || '', fieldType: 'text' },
            '文章语言': { label: '文章语言', answer: this.selectedPaper.language || '', fieldType: 'text' },
            '语言': { label: '语言', answer: this.selectedPaper.language || '', fieldType: 'text' },
            '会议名称': { label: '会议名称', answer: this.selectedPaper.conferenceName || '', fieldType: 'text' },
            '会议地点': { label: '会议地点', answer: this.selectedPaper.conferenceLocation || '', fieldType: 'text' },
            '作者检索词': { label: '作者检索词', answer: this.currentAuthor || '', fieldType: 'text' },
            '筛选条件': { label: '筛选条件', answer: JSON.stringify(filterCtx), fieldType: 'text' },
            '数据来源': { label: '数据来源', answer: this.selectedPaper.source || this.currentSource || '', fieldType: 'text' }
        };

        // 将作者列表存入发现缓存，供表格处理使用
        if (this.formFillingAgent) {
            // 将作者列表存入临时变量，供后续 agent 使用
            const authorsWithAffil = (this.selectedPaper.authors || []).map((name, index) => {
                let affiliation = '';
                if (this.selectedPaper.authorAffiliations && this.selectedPaper.authorAffiliations[index]) {
                    affiliation = this.selectedPaper.authorAffiliations[index];
                }
                return { name, affiliation };
            });

            // 保存到临时属性，确保即使 agent 未创建也不会丢失
            this._tempAuthors = authorsWithAffil;

            // 如果 agent 已存在，直接存入缓存（兼容性处理）
            if (this.formFillingAgent) {
                this.formFillingAgent.discoveryCache._current_paper_authors = authorsWithAffil;
            }
        }
        
        // 隐藏搜索区域，显示填表控制
        this.authorSearchArea.style.display = 'none';
        this.fillingProgress.style.display = 'block';
        this.fillingControls.style.display = 'grid';
        this.fillingStats.style.display = 'block';
        this.startFillingBtn.disabled = false;

        if (!this.fillingInProgress) {
            this.startFillingProcess();
        }
    }

    /**
    * 根据论文标题猜测语言（中文/英文）
    * @param {string} title - 论文标题
    * @returns {string} 'zh' 或 'en' 或 ''
    */
    guessLanguageFromTitle(title) {
        if (!title) return '';
        // 检测是否包含中文字符
        const chineseRegex = /[\u4e00-\u9fa5]/;
        if (chineseRegex.test(title)) {
            return 'zh';
        }
        // 默认假设为英文
        return 'en';
    }

    renderFormFields(fields) {
        // 更新 UI 显示统计信息
        this.totalFields.textContent = fields.length;
        this.progressInfo.textContent = `已解析 ${fields.length} 个字段`;
        this.fillingProgress.style.display = 'block';
        
        // 显示填表控制按钮
        this.fillingControls.style.display = 'grid';
        this.fillingStats.style.display = 'block';
        
        // 初始化统计数据
        this.updateStats(0, 0, 0, 0);
    }

    async startFillingProcess() {
        if (this.currentFormFields.length === 0) {
            this.setStatus('请先解析表单', 'warning');
            return;
        }
        
        this.fillingInProgress = true;
        this.currentFieldIndex = 0;
        this.currentGroupIndex = 0;
        this.currentFieldIndexInGroup = 0;
        this.filledFields = {};
        
        this.setStatus('开始对字段进行逻辑分组...', 'ai-thinking');
        this.startFillingBtn.disabled = true;

        try {
            // 初始化 Agent
            const llmClient = new DeepSeekLLM(this.aiSettings.apiKey, this.aiSettings.model);
            const toolExecutor = new EnhancedToolExecutor(this.formTabId); // 传入当前表单标签页的 ID
            
            this.formFillingAgent = new FormFillingAgent(llmClient, toolExecutor, (stepInfo) => {
                this.handleAgentStep(stepInfo);
            });

            // 将暂存的作者列表存入 agent 缓存
            if (this._tempAuthors && this._tempAuthors.length > 0) {
                this.formFillingAgent.discoveryCache._current_paper_authors = this._tempAuthors;
            }
            this.formFillingAgent.formTabId = this.formTabId; // 供 agent 内部使用

            // 准备表单结构并分组
            const formStructure = {
                title: '当前表单',
                description: '通过填表助手填写的表单',
                fields: this.currentFormFields
            };
            
            this.fieldGroups = await this.formFillingAgent._groupFields(this.currentFormFields, formStructure);
            // 强制将作者相关的群组标记为表格
            this.fieldGroups.forEach(group => {
                // 如果群组名称或标签包含“作者”，则视为表格
                if ((group.name && group.name.includes('作者')) || (group.label && group.label.includes('作者'))) {
                    group.isTable = true;
                    // 确保 children 存在（用于表格处理）
                    if (!group.children && group.fields) {
                        group.children = group.fields.map(f => ({ ...f, isField: true }));
                    }
                }
            });
            console.log('字段分组完成:', this.fieldGroups);
            
            // 注入已选择的论文信息到 Discovery Cache
            if (this.selectedPaper) {
                // 构造缓存键名（尽量覆盖常见变体）
                const title = this.selectedPaper.title;
                this.formFillingAgent.discoveryCache[`_paper_meta_for_${title}`] = {
                    title: title,
                    authors: this.selectedPaper.authors,
                    venue: this.selectedPaper.venueFormatted || this.selectedPaper.venue,
                    venueRaw: this.selectedPaper.venueRaw || this.selectedPaper.venue,
                    venueShort: this.selectedPaper.venueShort || '',
                    ccfRating: this.selectedPaper.ccfRating || '',
                    year: this.selectedPaper.year,
                    doi: this.selectedPaper.doi,
                    url: this.selectedPaper.url,
                    abstract: this.selectedPaper.abstract || '',
                    keywords: this.selectedPaper.keywords || [],
                    citationCount: this.selectedPaper.citationCount,
                    grants: this.selectedPaper.grants || [],
                    articleNumber: this.selectedPaper.articleNumber || '',
                    firstPage: this.selectedPaper.firstPage || '',
                    lastPage: this.selectedPaper.lastPage || '',
                    pageRange: this.selectedPaper.pageRange || '',
                    publicationDate: this.selectedPaper.publicationDate || '',
                    publicationMonth: this.selectedPaper.publicationMonth || '',
                    publicationDay: this.selectedPaper.publicationDay || '',
                    conferenceEventDate: this.selectedPaper.conferenceEventDate || '',
                    conferenceStartDate: this.selectedPaper.conferenceStartDate || '',
                    conferenceEndDate: this.selectedPaper.conferenceEndDate || '',
                    conferenceStartMonth: this.selectedPaper.conferenceStartMonth || '',
                    conferenceStartDay: this.selectedPaper.conferenceStartDay || '',
                    conferenceEndMonth: this.selectedPaper.conferenceEndMonth || '',
                    conferenceEndDay: this.selectedPaper.conferenceEndDay || '',
                    language: this.selectedPaper.language || '',
                    conferenceName: this.selectedPaper.conferenceName || '',
                    conferenceLocation: this.selectedPaper.conferenceLocation || '',
                    conferenceEvent: this.selectedPaper.conferenceEvent || null,
                    organizers: this.selectedPaper.organizers || []
                };
                // 单独字段缓存
                this.formFillingAgent.discoveryCache[`_venue_for_${title}`] = this.selectedPaper.venueFormatted || this.selectedPaper.venue;
                this.formFillingAgent.discoveryCache[`_venue_raw_for_${title}`] = this.selectedPaper.venueRaw || this.selectedPaper.venue;
                this.formFillingAgent.discoveryCache[`_year_for_${title}`] = this.selectedPaper.year;
                if (this.selectedPaper.abstract) this.formFillingAgent.discoveryCache[`_abstract_for_${title}`] = this.selectedPaper.abstract;
                if (this.selectedPaper.keywords && this.selectedPaper.keywords.length) this.formFillingAgent.discoveryCache[`_keywords_for_${title}`] = Array.isArray(this.selectedPaper.keywords) ? this.selectedPaper.keywords.join(', ') : this.selectedPaper.keywords;
                if (this.selectedPaper.citationCount != null) this.formFillingAgent.discoveryCache[`_citation_for_${title}`] = this.selectedPaper.citationCount;
                
                // 将 filledContext 同步给 agent
                this.formFillingAgent.filledContext = this.filledContext;
            }

            // 【新增】识别重复模式
            this.detectRepeatedGroups();
            this.batchProcessedGroups = new Set();
            this.currentBatchPattern = null;

            this.setStatus('开始填表...', 'ready');
            
            // 开始填表循环
            await this.processNextField();
        } catch (error) {
            console.error('初始化填表流程失败:', error);
            this.setStatus('初始化失败: ' + error.message, 'error');
            this.startFillingBtn.disabled = false;
        }
    }

    async processNextField() {
        if (!this.fillingInProgress || this.currentGroupIndex >= this.fieldGroups.length) {
            this.finishFilling();
            return;
        }

        const currentGroup = this.fieldGroups[this.currentGroupIndex];

        if (currentGroup.isTable) {
            this.setStatus(`正在批量填写表格: ${currentGroup.label}...`, 'searching');
            try {
                // 调用 agent 的表格处理方法
                await this.formFillingAgent.processTable(currentGroup, 0, []);

                // 将表格内的所有字段标记为已填写（AI 方式）
                currentGroup.fields.forEach(field => {
                    if (!this.filledFields[field.name]) {
                        this.filledFields[field.name] = {
                            label: field.label || field.name,
                            method: 'ai',
                            timestamp: Date.now()
                        };
                        // 同时更新上下文（如果有值）
                        if (this.formFillingAgent.filledContext[field.name]) {
                            this.filledContext[field.name] = this.formFillingAgent.filledContext[field.name];
                        }
                    }
                });

                // 标记该群组已处理
                this.batchProcessedGroups.add(this.currentGroupIndex);

                // 更新进度条和统计
                this.updateStats();
                const totalFilled = Object.keys(this.filledFields).length;
                const progressPercent = (totalFilled / this.currentFormFields.length) * 100;
                this.progressFill.style.width = `${progressPercent}%`;
                this.progressInfo.textContent = `已填写 ${totalFilled}/${this.currentFormFields.length} 个字段`;

                this.setStatus(`表格处理完成`, 'success');
                // 移动到下一个群组
                this.currentGroupIndex++;
                this.currentFieldIndexInGroup = 0;
                this.processNextField();
            } catch (error) {
                console.error('处理表格出错:', error);
                this.setStatus(`表格处理出错: ${error.message}`, 'error');
                // 出错时也跳过该群组，避免卡死
                this.currentGroupIndex++;
                this.currentFieldIndexInGroup = 0;
                this.processNextField();
            }
            return;
        }

        // ===== 原有重复群组批量模式检测（跳过表格群组）=====
        const pattern = this.repeatedPatterns.find(p => p.groupIdxs[0] === this.currentGroupIndex);
        const authorRowCtx = this.getAuthorRowContextForGroup(this.currentGroupIndex, currentGroup);
        if (pattern && !this.batchProcessedGroups.has(this.currentGroupIndex) && !currentGroup.isTable) {
            if (this.skipBatchMode) {
                // 用户选择跳过批量，直接进入单个字段处理
            } else {
                this.currentBatchPattern = pattern;
                this.showBatchProcessHint(pattern);
                return;
            }
        }

        // 单个字段处理
        const field = currentGroup.fields[this.currentFieldIndexInGroup];
        this.activeField = field;
        this.activeGroup = currentGroup;

        this.displayCurrentFieldInfo(field, currentGroup);
        this.fieldActionChoice.style.display = 'none';
        this.aiThinkingDisplay.style.display = 'none';
        this.optionsDisplay.style.display = 'none';

        // 如果字段已填写（可能被之前的批量处理标记），直接跳过
        if (this.filledFields[field.name]) {
            console.log(`字段 ${field.name} 已填写，跳过`);
            this._moveToNextField();
            return;
        }

        await this.processFieldWithAI(field);
    }

    /**
     * 顺序移动到下一个字段/群组（不检查是否已填）
     * 用于跳过当前字段后直接进入下一个
     */
    _moveToNextField() {
        if (this.currentGroupIndex >= this.fieldGroups.length) {
            this.finishFilling();
            return;
        }

        const currentGroup = this.fieldGroups[this.currentGroupIndex];
        this.currentFieldIndexInGroup++;

        if (this.currentFieldIndexInGroup >= currentGroup.fields.length) {
            this.currentGroupIndex++;
            this.currentFieldIndexInGroup = 0;
        }

        this.processNextField();
    }

    async handleChoice(choice) {
        this.fieldActionChoice.style.display = 'none';
        
        // 使用锁定的 activeField 确保逻辑与 UI 完全同步
        const field = this.activeField;
        const currentGroup = this.activeGroup;

        if (!field) {
            console.error('未找到当前活跃字段');
            return;
        }

        // 无论选择什么，都尝试回到原表单页面，确保用户能看到操作
        if (this.formTabId && typeof chrome !== 'undefined' && chrome.tabs) {
            try {
                chrome.tabs.update(this.formTabId, { active: true });
            } catch (e) {}
        }

        if (choice === 'ai') {
            await this.processFieldWithAI(field);
        } else if (choice === 'manual') {
            this.showManualInputInterface(field);
        } else if (choice === 'skip') {
            this.skipCurrentField();
        } else if (choice === 'quit') {
            this.quitFilling();
        }
    }

    handleAgentStep(stepInfo) {
        if (stepInfo && typeof stepInfo.requestId === 'number' && this.ignoredAIRequestIds.has(stepInfo.requestId)) {
            return;
        }
        if (stepInfo && typeof stepInfo.requestId === 'number' && stepInfo.requestId !== this.activeAIRequestId) {
            return;
        }
        console.log('收到智能体步骤:', stepInfo);
        
        // 如果没有开启显示思考过程，则只更新状态栏
        if (!this.aiSettings.showThoughts) {
            this.setStatus(`AI正在执行第 ${stepInfo.step} 步: ${stepInfo.type}`, 'ai-thinking');
        }

        const stepId = `step-${stepInfo.step}-${stepInfo.type}`;
        let stepElement = document.getElementById(stepId);
        
        // 如果是 thought 且是 partial，我们寻找或创建一个专门的 content 区域
        if (stepInfo.isPartial && stepInfo.type === 'thought') {
            if (!stepElement) {
                const stepPrefix = `<div style="color: #9f7aea; font-size: 11px; margin-top: 8px; border-top: 1px dashed #e2e8f0; padding-top: 5px;">第 ${stepInfo.step} 步:</div>`;
                const container = document.createElement('div');
                container.id = stepId;
                container.innerHTML = `${stepPrefix}<div class="step-content" style="color: #4a5568; font-style: italic;">思考: </div>`;
                this.aiThinkingContent.appendChild(container);
                stepElement = container;
            }
            const contentArea = stepElement.querySelector('.step-content');
            if (contentArea) {
                // 处理 Markdown 格式，移除代码块等干扰字符
                let cleanContent = this.stripMarkdown(stepInfo.content);
                contentArea.textContent = `思考: ${cleanContent}`;
            }
            
            // 滚动到底部
            this.aiThinkingDisplay.scrollTop = this.aiThinkingDisplay.scrollHeight;
            return;
        }

        let content = '';
        const stepPrefix = `<div style="color: #9f7aea; font-size: 11px; margin-top: 8px; border-top: 1px dashed #e2e8f0; padding-top: 5px;">第 ${stepInfo.step} 步:</div>`;
        
        switch (stepInfo.type) {
            case 'thought':
                // 如果已经存在（由 partial 创建），我们不再重复创建
                if (stepElement) {
                    const contentArea = stepElement.querySelector('.step-content');
                    if (contentArea) contentArea.textContent = `思考: ${this.stripMarkdown(stepInfo.content)}`;
                } else {
                    const cleanThought = this.stripMarkdown(stepInfo.content);
                    content = `${stepPrefix}<div class="step-content" style="color: #4a5568; font-style: italic;">思考: ${this.escapeHtml(cleanThought)}</div>`;
                }
                break;
            case 'action':
                // 用户要求：只显示“调用工具”，不显示具体名称和参数
                content = `${stepPrefix}<div style="color: #2b6cb0;">行动: 调用工具</div>`;
                break;
            case 'observation':
                // 限制观察结果显示长度 - 已隐藏显示
                // const obs = stepInfo.content.length > 200 ? stepInfo.content.substring(0, 200) + '...' : stepInfo.content;
                // content = `<div style="color: #38a169; font-size: 11px;">观察: ${this.escapeHtml(obs)}</div>`;
                // 不显示观察步骤
                break;
            case 'options':
                content = `${stepPrefix}<div style="color: #ed8936; font-weight: bold;">提示: 发现多个候选项，等待用户选择</div>`;
                break;
            case 'finish':
                content = `${stepPrefix}<div style="color: #805ad5; font-weight: bold;">完成: 得到最终答案</div>`;
                break;
        }

        if (content) {
            const container = document.createElement('div');
            container.id = stepId;
            container.innerHTML = content;
            this.aiThinkingContent.appendChild(container);
        }
        
        // 滚动到底部
        this.aiThinkingDisplay.scrollTop = this.aiThinkingDisplay.scrollHeight;
    }

    displayCurrentFieldInfo(field, group = null) {
        const getFieldTypeLabel = (type) => {
            const typeMap = {
                text: '文本',
                textarea: '多行文本',
                select: '下拉选择',
                radio: '单选',
                checkbox: '复选',
                email: '邮箱',
                url: '链接',
                number: '数字',
                date: '日期'
            };
            return typeMap[String(type || '').toLowerCase()] || (type || 'text');
        };

        let groupHtml = '';
        if (group) {
            const relText = group.relationship === 'or' ? '(互斥/二选一)' : 
                           group.relationship === 'range' ? '(范围)' : 
                           group.relationship === 'table' ? '(表格)' : '';
            const relColor = group.relationship === 'or' ? '#ed8936' : '#9f7aea';
            groupHtml = `<div class="field-detail" style="color: ${relColor}; font-weight: bold;">📦 群组: ${group.name} ${relText}</div>`;
        }
        this.currentFieldInfo.innerHTML = `
            ${groupHtml}
            <h4>正在处理: ${field.label || field.name}</h4>
            <div class="field-detail"><strong>字段名:</strong> ${field.name}</div>
            <div class="field-detail"><strong>类型:</strong> ${getFieldTypeLabel(field.type)}</div>
            <div class="field-detail"><strong>必填:</strong> ${field.required ? '是' : '否'}</div>
            <div id="fieldPredictionTip" class="field-detail" style="color: #38a169; display: none; margin-top: 5px; font-weight: bold;"></div>
        `;
        
        this.fieldProcessingArea.style.display = 'block';
    }

    async processFieldWithAI(field) {
        const requestId = ++this.activeAIRequestId;
        let timeoutId = null;
        try {
            this.showAIThinking();
            if (this.formFillingAgent) {
                this.formFillingAgent.currentRequestId = requestId;
            }
            
            const currentGroup = this.fieldGroups[this.currentGroupIndex];
            
            // 准备表单结构信息
            const formStructure = {
                title: '当前表单',
                description: '通过填表助手填写的表单',
                action: this.currentFormUrl,
                method: 'POST',
                fields: this.currentFormFields
            };
            
            const timeoutMs = 45000;
            const aiCall = this.formFillingAgent._aiFillField(field, formStructure, currentGroup, this.filledContext);
            const timeoutPromise = new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    if (this.activeAIRequestId !== requestId) return;
                    this.ignoredAIRequestIds.add(requestId);
                    if (this.formFillingAgent) {
                        this.formFillingAgent.cancelCurrentTask();
                    }
                    reject(new Error(`AI_TIMEOUT:${timeoutMs}`));
                }, timeoutMs);
            });
            const aiResult = await Promise.race([
                aiCall,
                timeoutPromise
            ]);

            if (this.activeAIRequestId !== requestId || this.activeField !== field) {
                return;
            }
            
            console.log('AI字段结果:', { fieldName: field?.name, fieldLabel: field?.label, groupName: currentGroup?.name, result: aiResult });
            
            // ========== 新增：处理取消结果 ==========
            // 当用户在 AI 思考过程中点击“跳过字段”或“停止填表”时，
            // _aiFillField 会返回 { type: 'cancelled' }
            if (aiResult && aiResult.type === 'cancelled') {
                console.log('AI 任务已被用户取消，跳过当前字段');
                this.hideAIThinking();
                return;
            }
            // =====================================
            
            // 1. 空结果检查
            if (!aiResult) {
                this.setStatus('AI 未返回有效结果，请手动输入', 'warning');
                this.showManualInputInterface(field);
                this.hideAIThinking();
                return;
            }
            
            // 2. 缓存命中分支
            if (aiResult.fromCache) {
                const ans = String(aiResult.answer || '').trim();
                if (!ans || ans.toUpperCase() === 'UNKNOWN') {
                    this.updateFieldStatus(field.name, 'warning', `⚠️ 缓存中无有效答案`);
                    this.setStatus('AI 未找到答案，请手动输入', 'warning');
                    this.showManualInputInterface(field);
                    this.hideAIThinking();
                    return;
                }
                this.updateFieldStatus(field.name, 'success', `✨ 从缓存中找到答案`);
                this.showAIRecommendation(field, ans);
                if (aiResult.discoveryData) {
                    this._applyDiscoveryDataToUI(aiResult.discoveryData, ans);
                }
                this.setStatus('已生成推荐答案（来自缓存）', 'success');
                this.hideAIThinking();
                return;
            }
            
            // 3. AI 成功生成结果
            if (aiResult.success) {
                // 如果 AI 在本次思考中提取到了额外信息，同步到缓存
                if (aiResult.discoveryData) {
                    console.log('💡 AI 发现了群组缓存数据:', aiResult.discoveryData);
                    Object.assign(this.formFillingAgent.discoveryCache, aiResult.discoveryData);
                }
                
                // 3.1 普通答案（Finish）
                if (aiResult.type === 'finish') {
                    const ans = String(aiResult.answer || '').trim();
                    if (!ans || ans.toUpperCase() === 'UNKNOWN') {
                        this.setStatus('AI 未找到答案，请手动输入', 'warning');
                        this.showManualInputInterface(field);
                        this.hideAIThinking();
                        return;
                    }
                    // 显示推荐答案
                    this.showAIRecommendation(field, ans);
                    this.setStatus('已生成推荐答案', 'success');
                    this.hideAIThinking();
                    return;
                }
                
                // 3.2 多选项（Options）
                else if (aiResult.type === 'options') {
                    const opts = Array.isArray(aiResult.options) ? aiResult.options : [];
                    console.log('AI 返回 options 列表:', opts);
                    if (!opts.length) {
                        this.setStatus('AI 未找到可选答案，请手动输入', 'warning');
                        this.showManualInputInterface(field);
                        this.hideAIThinking();
                        return;
                    }
                    this.resetOptionsDisplay();
                    this.showAIMultipleChoices(field, opts, aiResult.discoveryData);
                    this.setStatus('发现多个候选，请选择', 'info');
                    this.aiMultipleChoices.style.display = 'block';
                    this.optionsDisplay.style.display = 'block';
                    this.hideAIThinking();
                    return;
                }
                
                // 3.3 未知类型（兜底）
                else {
                    console.warn('AI 返回了未知结果类型:', aiResult.type);
                    this.setStatus('AI 返回了未知结果类型，请手动输入', 'warning');
                    this.showManualInputInterface(field);
                    this.hideAIThinking();
                    return;
                }
            }
            
            // 4. AI 未成功生成结果
            else {
                console.error('AI未能生成答案:', aiResult.message);
                this.setStatus(`AI生成答案失败: ${aiResult.message}`, 'error');
                this.showManualInputInterface(field);
                this.hideAIThinking();
                return;
            }
            
        } catch (error) {
            if (this.activeAIRequestId !== requestId || this.activeField !== field) {
                return;
            }
            console.error('AI处理字段失败:', error);
            const msg = String(error?.message || '');
            if (msg.startsWith('AI_TIMEOUT:')) {
                this.setStatus('AI 处理超时，已停止当前思考。可手动输入或点击跳过', 'warning');
            } else {
                this.setStatus(`AI处理失败: ${error.message}`, 'error');
            }
            this.showManualInputInterface(field);
            this.hideAIThinking();
        } finally {
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
        }
    }

    generateSampleRecommendation(field) {
        // 生成样本推荐答案，实际应用中这会来自AI
        const recommendations = {
            name: '张三',
            email: 'zhangsan@example.com',
            company: '示例公司',
            position: '软件工程师'
        };
        
        return recommendations[field.name] || `AI推荐的${field.label || field.name}答案`;
    }

    showAIThinking() {
        this.aiThinkingDisplay.style.display = 'block';
        this.aiThinkingContent.innerHTML = '<div style="color: #718096; font-style: italic; font-size: 12px;">AI 正在启动思考引擎...</div>';
        
        // 彻底隐藏所有其他交互区域
        this.fieldActionChoice.style.display = 'none';
        this.optionsDisplay.style.display = 'none';
        this.aiRecommendation.style.display = 'none';
        this.aiMultipleChoices.style.display = 'none';
        
        // 自动滚动到底部
        this.aiThinkingDisplay.scrollTop = 0;
    }

    hideAIThinking() {
        this.aiThinkingDisplay.style.display = 'none';
    }

    resetOptionsDisplay() {
        this.aiRecommendation.style.display = 'none';
        this.batchFillArea.style.display = 'none';
        this.aiMultipleChoices.style.display = 'none';
        this.pageExtractOptions.style.display = 'none';
        this.optionsDisplay.style.display = 'none';
        this.manualInput.value = '';
    }

    showAIRecommendation(field, recommendation) {
        this.resetOptionsDisplay();
        this.recommendationContent.textContent = recommendation;
        this.aiRecommendation.style.display = 'block';
        this.optionsDisplay.style.display = 'block';
    }

    showAIMultipleChoices(field, options, discoveryData = null) {
        console.log('显示多选推荐，选项数量:', options.length);
        
        this.resetOptionsDisplay();
        this.choicesList.innerHTML = '';
        
        // 构建字段选项映射（文本 -> 值）
        const fieldOptionsMap = new Map();
        if (field.options && field.options.length) {
            field.options.forEach(opt => {
                fieldOptionsMap.set(opt.text, opt.value);
                if (opt.value) fieldOptionsMap.set(opt.value, opt.value);
            });
        }
        
        const displayOptions = options
            .map(opt => {
                let text = '';
                let value = '';
                if (typeof opt === 'string') {
                    text = opt;
                    // 尝试匹配字段选项中的值或文本
                    if (fieldOptionsMap.has(opt)) {
                        value = fieldOptionsMap.get(opt);
                    } else {
                        // 尝试查找文本包含关系
                        for (let [k, v] of fieldOptionsMap.entries()) {
                            if (k.includes(opt) || opt.includes(k)) {
                                value = v;
                                text = k;
                                break;
                            }
                        }
                        if (!value) value = opt;
                    }
                } else if (opt && typeof opt === 'object') {
                    text = opt.text || '';
                    value = opt.value || opt.text || '';
                    // 同样尝试匹配
                    if (fieldOptionsMap.has(value)) value = fieldOptionsMap.get(value);
                    if (fieldOptionsMap.has(text)) value = fieldOptionsMap.get(text);
                }
                return { text, value };
            })
            .filter(opt => opt.text)
            .slice(0, 10);
        
        if (displayOptions.length === 0) {
            console.warn('没有有效的候选项可显示');
            this.setStatus('AI 返回的候选项无效，请手动输入', 'warning');
            this.showManualInputInterface(field);
            this.hideAIThinking();
            return;
        }
        
        this._currentCandidateOptions = displayOptions;
        
        displayOptions.forEach(opt => {
            const btn = document.createElement('button');
            btn.className = 'btn choice-item';
            btn.textContent = opt.text;
            btn.onclick = () => {
                this.fillCurrentFieldWithValue(opt.value, 'ai', opt.text);
            };
            this.choicesList.appendChild(btn);
        });
        
        this.aiMultipleChoices.style.display = 'block';
        this.optionsDisplay.style.display = 'block';
    }

    async fillCurrentFieldWithValue(value, method, displayText = null) {
        const field = this.activeField;
        if (!field) return;

        // 立即重置 UI
        this.resetOptionsDisplay();
        this.aiThinkingDisplay.style.display = 'none';
        this.fieldActionChoice.style.display = 'none';
        
        try {
            // 通过 background 填写
            const response = await this.sendMessageToBackground({
                action: 'fillFormField',
                data: {
                    fieldName: field.name,
                    value: value,
                    fieldSelector: field.selector || '',
                    tabId: this.formTabId
                }
            });
            
            if (response.success) {
                // 记录已填写的字段
                this.filledFields[field.name] = {
                    label: field.label || field.name,
                    answer: value,
                    value: value,
                    method: method,
                    fieldType: field.type || 'text',
                    timestamp: Date.now()
                };
                
                // 同步上下文
                this.filledContext[field.name] = {
                    label: field.label || field.name,
                    answer: value,
                    fieldType: field.type || 'text'
                };
                
                // 更新统计和进度
                this.updateStats();
                const totalFilled = Object.keys(this.filledFields).length;
                const progressPercent = (totalFilled / this.currentFormFields.length) * 100;
                this.progressFill.style.width = `${progressPercent}%`;
                this.progressInfo.textContent = `已填写 ${Object.keys(this.filledFields).length}/${this.currentFormFields.length} 个字段`;
                
                // 移动到下一个未填字段
                await this.moveToNextUnfilledField();
            } else {
                this.setStatus('填写字段失败: ' + response.message, 'error');
            }
        } catch (error) {
            console.error('填写字段失败:', error);
            this.setStatus('填写字段失败: ' + error.message, 'error');
        }
    }

    showManualInputInterface(field) {
        this.resetOptionsDisplay();
        this.manualInput.placeholder = `请输入${field.label || field.name}...`;
        this.optionsDisplay.style.display = 'block';
    }

    async useAiRecommendation() {
        const recommendation = this.recommendationContent.textContent;
        await this.fillCurrentFieldWithValue(recommendation, 'ai');
    }

    editAiRecommendation() {
        const currentRecommendation = this.recommendationContent.textContent;
        this.manualInput.value = currentRecommendation;
        this.manualInput.focus();
        
        // 当用户点击使用手动输入时会处理编辑后的内容
    }

    async useManualInput() {
        const userInput = this.manualInput.value.trim();
        if (!userInput) {
            this.setStatus('请输入答案', 'warning');
            return;
        }
        await this.fillCurrentFieldWithValue(userInput, 'manual');
    }

    _applyDiscoveryDataToUI(discoveryData, currentFieldAnswer = null) {
        /**
         * 将发现的元数据同步显示在 UI 上，实现“一搜多显”
         */
        if ((!discoveryData || Object.keys(discoveryData).length === 0) && !currentFieldAnswer) return;

        console.log("📦 正在同步发现的数据到 UI:", discoveryData, "当前字段答案:", currentFieldAnswer);
        
        const currentGroup = this.activeGroup;
        if (!currentGroup) return;

        const batchSuggestions = [];

        // 首先处理当前正在处理的字段
        if (currentFieldAnswer && this.activeField) {
            batchSuggestions.push({ field: this.activeField, value: currentFieldAnswer });
        }

        // 遍历当前群组的所有字段，检查是否有可用的发现数据
        currentGroup.fields.forEach(field => {
            // 如果该字段还没填，且不是当前正在处理的字段（已在上面处理）
            if (!this.filledFields[field.name] && field.name !== this.activeField?.name) {
                const fieldLabel = field.label || field.name;
                const value = discoveryData[field.name] || discoveryData[fieldLabel] || this._fuzzyMatchDiscovery(fieldLabel, discoveryData);
                
                if (value && typeof value === 'string' && !value.includes('{')) {
                    // 仅当值是字符串且不是嵌套对象时才显示
                    
                    // 如果该字段属于当前群组，则加入一键填写建议
                    batchSuggestions.push({ field, value });
                    
                    // 同时更新 UI 状态提示（可选）
                    // this.updateFieldStatus(field.name, 'success', `✨ 已预测: ${value}`);
                }
            }
        });

        // 如果有多个建议（至少包含一个除了当前活跃字段以外的其他同组字段），显示一键填写区域
        if (batchSuggestions.length > 1) {
            this.showBatchFillUI(batchSuggestions);
        }
    }

    showBatchFillUI(suggestions) {
        if (!this.batchFillArea || !this.batchFillList) return;

        this.batchFillList.innerHTML = '';
        suggestions.forEach(item => {
            const div = document.createElement('div');
            div.style.margin = '5px 0';
            div.style.padding = '5px';
            div.style.borderBottom = '1px dashed #cbd5e0';
            div.innerHTML = `
                <strong style="color: #4a5568;">${item.field.label || item.field.name}:</strong> 
                <span style="color: #2d3748;">${item.value}</span>
            `;
            this.batchFillList.appendChild(div);
        });

        this.batchFillArea.style.display = 'block';
        
        // 绑定一键填写按钮事件
        if (this.oneClickFillBtn) {
            // 移除旧的监听器
            const newBtn = this.oneClickFillBtn.cloneNode(true);
            this.oneClickFillBtn.parentNode.replaceChild(newBtn, this.oneClickFillBtn);
            this.oneClickFillBtn = newBtn;
            
            this.oneClickFillBtn.addEventListener('click', () => {
                this.handleBatchFill(suggestions);
            });
        }
    }

    async handleBatchFill(suggestions) {
        console.log('🚀 执行一键填写:', suggestions);
        this.batchFillArea.style.display = 'none';
        this.setStatus('正在执行一键填写...', 'searching');

        // 如果当前正在处理的字段（activeField）不在一键填写列表中，将其标记为跳过
        // 这表示用户选择了跳过当前字段，直接填写其他字段
        if (this.activeField && !suggestions.some(s => s.field.name === this.activeField.name)) {
            if (!this.filledFields[this.activeField.name]) {
                console.log(`⚠️ 当前字段 ${this.activeField.name} 不在一键填写列表中，标记为跳过`);
                this.filledFields[this.activeField.name] = {
                    label: this.activeField.label || this.activeField.name,
                    method: 'skip',
                    timestamp: Date.now()
                };
            }
        }

        // 记录已填写的数量，用于最后跳转
        let newlyFilledCount = 0;

        for (const item of suggestions) {
            try {
                this.setStatus(`正在填写: ${item.field.label || item.field.name}`, 'searching');
                
                const response = await this.sendMessageToBackground({
                    action: 'fillFormField',
                    data: {
                        fieldName: item.field.name,
                        value: item.value,
                        fieldSelector: item.field.selector || '',
                        tabId: this.formTabId
                    }
                });

                if (response.success) {
                    // 记录已填写的字段
                    this.filledFields[item.field.name] = {
                        label: item.field.label || item.field.name,
                        answer: item.value,
                        value: item.value,
                        method: 'ai',
                        fieldType: item.field.type || 'text',
                        timestamp: Date.now()
                    };
                    
                    // 更新 Agent 的上下文
                    if (this.formFillingAgent) {
                        this.formFillingAgent.filledContext[item.field.name] = {
                            label: item.field.label || item.field.name,
                            answer: item.value,
                            fieldType: item.field.type || 'text'
                        };
                    }
                    
                    newlyFilledCount++;
                }
            } catch (error) {
                console.error(`填写字段 ${item.field.name} 失败:`, error);
            }
        }

        this.setStatus('一键填写完成', 'success');
        
        // 更新统计和进度
        const totalFilled = Object.keys(this.filledFields).length;
        const aiCount = Object.values(this.filledFields).filter(f => f.method === 'ai').length;
        const manualCount = Object.values(this.filledFields).filter(f => f.method === 'manual').length;
        const completionRate = Math.round((totalFilled / this.currentFormFields.length) * 100);
        
        this.updateStats(totalFilled, aiCount, manualCount, completionRate);
        
        const progressPercent = (totalFilled / this.currentFormFields.length) * 100;
        this.progressFill.style.width = `${progressPercent}%`;
        this.progressInfo.textContent = `已填写 ${totalFilled}/${this.currentFormFields.length} 个字段`;

        // 找到下一个未填写的字段并处理
        await this.moveToNextUnfilledField();
    }

    async moveToNextUnfilledField() {
        /**
         * 寻找并跳转到最前面的未填写字段
         */
        const oldGroupIndex = this.currentGroupIndex;
        let found = false;
        
        for (let gIdx = 0; gIdx < this.fieldGroups.length; gIdx++) {
            const group = this.fieldGroups[gIdx];
            for (let fIdx = 0; fIdx < group.fields.length; fIdx++) {
                const field = group.fields[fIdx];
                if (!this.filledFields[field.name]) {
                    this.currentGroupIndex = gIdx;
                    this.currentFieldIndexInGroup = fIdx;
                    // 同时更新全局索引以保持同步
                    this.currentFieldIndex = this.currentFormFields.findIndex(f => f.name === field.name);
                    found = true;
                    break;
                }
            }
            if (found) break;
        }

        

        if (found) {
            setTimeout(() => {
                this.processNextField();
            }, 500);
        } else {
            this.finishFilling();
        }
    }

    _fuzzyMatchDiscovery(label, data) {
        const normalizedLabel = label.toLowerCase();
        for (const [key, value] of Object.entries(data)) {
            const normalizedKey = key.toLowerCase();
            if (normalizedLabel.includes(normalizedKey) || normalizedKey.includes(normalizedLabel)) {
                // 确保返回的 value 是字符串类型，否则跳过
                if (typeof value === 'string') {
                    return value;
                }
            }
        }
        return null;
    }

    async fillCurrentField(value, method) {
        const field = this.activeField;
        const currentGroup = this.activeGroup;
        
        if (!field) return;

        // 立即重置 UI，避免上一个字段的选择框残留
        this.resetOptionsDisplay();
        this.aiThinkingDisplay.style.display = 'none';
        this.fieldActionChoice.style.display = 'none';
        
        try {
            // 通过background script与content script通信来填写字段
            const response = await this.sendMessageToBackground({
                action: 'fillFormField',
                data: {
                    fieldName: field.name,
                    value: value,
                    fieldSelector: field.selector || '',
                    tabId: this.formTabId
                }
            });
            
            if (response.success) {
                // 记录已填写的字段
                this.filledFields[field.name] = {
                    label: field.label || field.name,
                    answer: value,
                    value: value,
                    method: method,
                    fieldType: field.type || 'text',
                    timestamp: Date.now()
                };

                // 同步更新上下文信息
                this.filledContext[field.name] = {
                    label: field.label || field.name,
                    answer: value,
                    fieldType: field.type || 'text'
                };
                
                // 更新统计
                const aiCount = Object.values(this.filledFields).filter(f => f.method === 'ai').length;
                const manualCount = Object.values(this.filledFields).filter(f => f.method === 'manual').length;
                const completionRate = Math.round(((this.currentFieldIndex + 1) / this.currentFormFields.length) * 100);
                
                this.updateStats(this.currentFieldIndex + 1, aiCount, manualCount, completionRate);
                
                // 更新进度条
                const progressPercent = ((this.currentFieldIndex + 1) / this.currentFormFields.length) * 100;
                this.progressFill.style.width = `${progressPercent}%`;
                this.progressInfo.textContent = `已填写 ${this.currentFieldIndex + 1}/${this.currentFormFields.length} 个字段`;
                
                // 移动到下一个未填写的字段（跳过已填写和已跳过的字段）
                await this.moveToNextUnfilledField();
            } else {
                this.setStatus('填写字段失败: ' + response.message, 'error');
            }
        } catch (error) {
            console.error('填写字段失败:', error);
            this.setStatus('填写字段失败: ' + error.message, 'error');
        }
    }

    updateStats(filled, ai, manual, rate) {
        if (filled === undefined) {
            // 如果没传参数，自动计算
            const allFilled = Object.values(this.filledFields);
            const aiCount = allFilled.filter(f => f.method === 'ai').length;
            const manualCount = allFilled.filter(f => f.method === 'manual').length;
            const totalFilled = allFilled.length;
            const completionRate = this.currentFormFields.length > 0 
                ? Math.round((totalFilled / this.currentFormFields.length) * 100) 
                : 0;
            
            this.filledCount.textContent = totalFilled;
            this.aiFilled.textContent = aiCount;
            this.manualFilled.textContent = manualCount;
            this.completionRate.textContent = `${completionRate}%`;
            return;
        }
        this.filledCount.textContent = filled;
        this.aiFilled.textContent = ai;
        this.manualFilled.textContent = manual;
        this.completionRate.textContent = `${rate}%`;
    }

    skipCurrentField() {
        this.ignoredAIRequestIds.add(this.activeAIRequestId);
        this.activeAIRequestId++;

        // 如果正在运行 AI 任务，立即取消
        if (this.formFillingAgent) {
            this.formFillingAgent.cancelCurrentTask();
        }

        const field = this.activeField;
        if (!field) return;

        this.hideAIThinking();
        this.resetOptionsDisplay();

        // 将字段标记为跳过
        this.filledFields[field.name] = {
            label: field.label || field.name,
            method: 'skip',
            timestamp: Date.now()
        };

        this.setStatus(`已跳过字段: ${field.label || field.name}`, 'info');

        // 顺序移动到下一个字段
        this._moveToNextField();
    }

    _moveToImmediateNextField() {
        const currentGroup = this.activeGroup;
        this.currentFieldIndex++;
        this.currentFieldIndexInGroup++;
        
        if (this.currentFieldIndexInGroup >= currentGroup.fields.length) {
            this.currentGroupIndex++;
            this.currentFieldIndexInGroup = 0;
        }

        if (this.currentFieldIndex < this.currentFormFields.length) {
            this.processNextField();
        } else {
            this.finishFilling();
        }
    }

    quitFilling() {
        this.ignoredAIRequestIds.add(this.activeAIRequestId);
        // 取消正在运行的 AI 任务
        if (this.formFillingAgent) {
            this.formFillingAgent.cancelCurrentTask();
        }

        this.fillingInProgress = false;
        this.setStatus('填表已退出', 'info');
        this.resetToStartPage();
    }

    finishFilling() {
        this.fillingInProgress = false;
        this.setStatus('填表完成！', 'success');
        
        
        
        // 添加到历史记录
        this.addToFillHistory({
            url: this.currentFormUrl,
            fieldsCount: this.currentFormFields.length,
            filledCount: Object.keys(this.filledFields).length,
            completedAt: new Date().toISOString()
        });
        
        this.resetToStartPage();
    }

    resetToStartPage() {
        // 重置填表相关状态
        this.fillingInProgress = false;
        this.currentFieldIndex = 0;
        this.currentGroupIndex = 0;
        this.currentFieldIndexInGroup = 0;
        this.filledFields = {};
        this.filledContext = {};
        this.activeField = null;
        this.activeGroup = null;
        this.batchProcessedGroups.clear();
        this.currentBatchPattern = null;
        this.skipBatchMode = false;
        this.batchCandidatesData.clear();
        this.batchExecutionCancelled = false;

        // 清空选中的论文及列表（让用户重新选择）
        this.selectedPaper = null;
        this.currentPapers = [];
        this.rawPapers = [];
        this._tempAuthors = [];

        // 隐藏所有填表相关 UI 区域
        this.fieldProcessingArea.style.display = 'none';
        this.fieldActionChoice.style.display = 'none';
        this.aiThinkingDisplay.style.display = 'none';
        this.optionsDisplay.style.display = 'none';
        this.aiRecommendation.style.display = 'none';
        this.batchFillArea.style.display = 'none';
        this.aiMultipleChoices.style.display = 'none';
        this.pageExtractOptions.style.display = 'none';
        this.batchProcessArea.style.display = 'none';
        this.batchResultsArea.style.display = 'none';
        this.fillingProgress.style.display = 'none';
        this.fillingControls.style.display = 'none';
        this.fillingStats.style.display = 'none';

        // 显示开始页面（作者搜索区域 & 论文选择区域）
        this.authorSearchArea.style.display = 'block';
        // 若已有论文列表（从之前的搜索中），则显示；若为空，用户可重新搜索
        this.paperSelectionArea.style.display = 'block';

        // 启用“开始填表”按钮
        this.startFillingBtn.disabled = false;
        this.startFillingBtn.textContent = '开始填表';

        // 清空当前字段信息显示
        this.currentFieldInfo.innerHTML = '';
    }

    pauseFillingProcess() {
        this.fillingInProgress = false;
        this.setStatus('填表已暂停', 'info');
    }

    resumeFillingProcess() {
        if (this.currentFieldIndex < this.currentFormFields.length) {
            this.fillingInProgress = true;
            this.processNextField();
            this.setStatus('继续填表...', 'ai-thinking');
        }
    }

    stopFillingProcess() {
        this.ignoredAIRequestIds.add(this.activeAIRequestId);
        // 取消正在运行的 AI 任务
        if (this.formFillingAgent) {
            this.formFillingAgent.cancelCurrentTask();
        }

        this.fillingInProgress = false;
        this.setStatus('填表已停止', 'info');
        this.resetToStartPage();
    }

    // ====== 填表历史管理 ======
    
    addToFillHistory(record) {
        const historyItem = {
            id: Date.now(),
            url: record.url,
            fieldsCount: record.fieldsCount,
            filledCount: record.filledCount,
            completedAt: new Date().toLocaleString(),
            summary: `${record.filledCount}/${record.fieldsCount} 字段已填写`
        };
        
        this.fillHistory.unshift(historyItem);
        
        if (this.fillHistory.length > 10) {
            this.fillHistory = this.fillHistory.slice(0, 10);
        }
        
        this.saveFillHistory();
        this.updateFillHistoryDisplay();
    }

    async saveFillHistory() {
        try {
            if (typeof chrome !== 'undefined' && chrome.storage) {
                await chrome.storage.local.set({ 
                    fillHistory: this.fillHistory 
                });
            } else {
                localStorage.setItem('fillHistory', JSON.stringify(this.fillHistory));
            }
            console.log('填表历史已保存');
        } catch (error) {
            console.error('保存填表历史失败:', error);
        }
    }

    async loadFillHistory() {
        try {
            if (typeof chrome !== 'undefined' && chrome.storage) {
                const result = await chrome.storage.local.get(['fillHistory']);
                if (result.fillHistory) {
                    this.fillHistory = result.fillHistory;
                    this.updateFillHistoryDisplay();
                    console.log('填表历史已加载:', this.fillHistory.length);
                }
            } else {
                const history = localStorage.getItem('fillHistory');
                if (history) {
                    this.fillHistory = JSON.parse(history);
                    this.updateFillHistoryDisplay();
                }
            }
        } catch (error) {
            console.error('加载填表历史失败:', error);
        }
    }

    updateFillHistoryDisplay() {
        if (!this.fillingHistory) return;
        
        if (this.fillHistory.length === 0) {
            this.fillingHistory.innerHTML = '<div style="color: #a0aec0; text-align: center; padding: 20px; font-size: 13px;">暂无填表历史</div>';
            return;
        }
        
        const historyHTML = this.fillHistory.map(item => `
            <div class="history-item" data-id="${item.id}">
                <div style="margin-bottom: 5px; font-weight: bold;">${this.escapeHtml(item.summary)}</div>
                <div style="font-size: 12px; color: #718096;">${this.escapeHtml(item.url.substring(0, 40))}${item.url.length > 40 ? '...' : ''}</div>
                <div style="display: flex; justify-content: space-between; font-size: 11px; color: #718096; margin-top: 5px;">
                    <span>共${item.fieldsCount}字段</span>
                    <span>${item.completedAt}</span>
                </div>
            </div>
        `).join('');
        
        this.fillingHistory.innerHTML = historyHTML;
    }

    // ====== 通信方法 ======
    
    async sendMessageToBackground(message) {
        return new Promise((resolve, reject) => {
            if (typeof chrome !== 'undefined' && chrome.runtime) {
                chrome.runtime.sendMessage(message, (response) => {
                    if (chrome.runtime.lastError) {
                        console.error('发送消息到background失败:', chrome.runtime.lastError);
                        reject(new Error(chrome.runtime.lastError.message));
                    } else {
                        resolve(response);
                    }
                });
            } else {
                // 如果不在扩展环境中，模拟响应
                console.warn('非扩展环境，使用模拟响应');
                resolve({ success: true, message: '模拟响应' });
            }
        });
    }

    // ====== 工具函数 ======
    
    stripMarkdown(text) {
        if (!text) return '';
        // 移除 Markdown 标记，使侧边栏显示更纯净
        return text
            .replace(/```[\s\S]*?(?:```|$)/g, '') // 移除代码块
            .replace(/`([^`]+)`/g, '$1')         // 移除行内代码符但保留内容
            .replace(/[*_~]{1,3}/g, '')          // 移除粗体、斜体、删除线标记
            .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1') // 移除链接标记保留文本
            .replace(/^#+\s+/gm, '')             // 移除标题标记
            .trim();
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    deriveRequiredPaperFields(fields) {
        const req = new Set();
        const allText = (fields || []).map(f => `${f.label || ''} ${f.name || ''} ${f.placeholder || ''} ${f.description || ''}`).join(' ').toLowerCase();
        if (allText.includes('abstract') || allText.includes('摘要')) req.add('abstract');
        if (allText.includes('keyword') || allText.includes('关键词')) req.add('keywords');
        if (allText.includes('citation') || allText.includes('引用')) req.add('citationCount');
        if (allText.includes('grant') || allText.includes('fund') || allText.includes('基金') || allText.includes('资助')) req.add('grants');
        return Array.from(req);
    }

    processPapersForDisplay(items) {
        const list = Array.isArray(items) ? items.slice() : [];
        list.sort((a, b) => {
            const ay = a && a.year ? parseInt(a.year, 10) : -1;
            const by = b && b.year ? parseInt(b.year, 10) : -1;
            if (by !== ay) return by - ay;
            const ac = typeof a.citationCount === 'number' ? a.citationCount : -1;
            const bc = typeof b.citationCount === 'number' ? b.citationCount : -1;
            return bc - ac;
        });
        return list;
    }

    getRecentYearRange(filters = {}) {
        const nowYear = new Date().getFullYear();
        const explicitStart = filters.yearStart ? parseInt(filters.yearStart, 10) : null;
        const explicitEnd = filters.yearEnd ? parseInt(filters.yearEnd, 10) : null;
        const endYear = Number.isFinite(explicitEnd) ? explicitEnd : nowYear;
        const startYear = Number.isFinite(explicitStart) ? explicitStart : (nowYear - (Math.max(1, this.recentYearsWindow || 5) - 1));
        return { startYear, endYear };
    }

    filterPapersByYearRange(items, startYear, endYear) {
        const list = Array.isArray(items) ? items : [];
        return list.filter(p => {
            const y = p && p.year ? parseInt(p.year, 10) : NaN;
            if (!Number.isFinite(y)) return false;
            if (Number.isFinite(endYear) && y > endYear) return false;
            return y >= startYear;
        });
    }

    isAuthorRowGroup(group) {
        if (!group || !Array.isArray(group.fields)) return false;
        const text = group.fields.map(f => `${f.label || ''} ${f.name || ''}`).join(' ').toLowerCase();
        const hasAuthor = text.includes('作者') || text.includes('author') || text.includes('姓名') || text.includes('name');
        const hasPaper = text.includes('论文') || text.includes('paper') || text.includes('title') || text.includes('题目') || text.includes('标题');
        const isContactish = text.includes('单位') || text.includes('affiliation') || text.includes('机构') || text.includes('email') || text.includes('邮箱');
        return hasAuthor && !hasPaper && isContactish;
    }

    getAuthorRowContextForGroup(groupIdx, group) {
        if (!this.selectedPaper || !Array.isArray(this.selectedPaper.authors) || this.selectedPaper.authors.length === 0) return null;
        if (!this.isAuthorRowGroup(group)) return null;
        const pattern = (this.repeatedPatterns || []).find(p => Array.isArray(p.groupIdxs) && p.groupIdxs.includes(groupIdx));
        if (!pattern) return null;
        const idx = pattern.groupIdxs.indexOf(groupIdx);
        if (idx < 0 || idx >= this.selectedPaper.authors.length) return null;
        return { index: idx, name: this.selectedPaper.authors[idx] };
    }

    async fetchRecentPapersForAuthor(author, filters = {}) {
        const { startYear, endYear } = this.getRecentYearRange(filters);
        this.lastRecentInfo = `近${Math.max(1, this.recentYearsWindow || 5)}年(${startYear}-${endYear})`;

        if (author && author.source === 'DBLP' && author.id) {
            const r = await unifiedGetPublications(author, 0, 1000000, filters, this.requiredPaperFields);
            const recent = this.filterPapersByYearRange(r.items || [], startYear, endYear);
            return { total: recent.length, source: r.source, items: this.processPapersForDisplay(recent) };
        }

        if (author && author.source === 'OpenAlex' && author.id) {
            const pageSize = 200;
            let offset = 0;
            const all = [];
            while (true) {
                const r = await unifiedGetPublications(author, offset, pageSize, { ...filters, yearStart: String(startYear), yearEnd: String(endYear) }, this.requiredPaperFields);
                const batch = r.items || [];
                all.push(...batch);
                if (batch.length < pageSize) return { total: all.length, source: r.source, items: this.processPapersForDisplay(all) };
                offset += pageSize;
                if (offset > 20000) return { total: all.length, source: r.source, items: this.processPapersForDisplay(all) };
            }
        }

        if (author && author.source === 'Semantic Scholar' && author.id) {
            const pageSize = 1000;
            let offset = 0;
            const all = [];
            const seen = new Set();
            while (true) {
                const r = await unifiedGetPublications(author, offset, pageSize, filters, this.requiredPaperFields);
                const batch = r.items || [];
                if (!batch.length) break;
                let maxYear = -1;
                for (const p of batch) {
                    const y = p && p.year ? parseInt(p.year, 10) : NaN;
                    if (Number.isFinite(y) && y > maxYear) maxYear = y;
                    if (!Number.isFinite(y)) continue;
                    if (y < startYear || y > endYear) continue;
                    const key = p.doi || `${p.title || ''}__${p.year || ''}__${p.venue || ''}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    all.push(p);
                }
                if (maxYear !== -1 && maxYear < startYear) break;
                if (batch.length < pageSize) break;
                offset += pageSize;
                if (offset > 20000) break;
            }
            return { total: all.length, source: 'Semantic Scholar', items: this.processPapersForDisplay(all) };
        }

        const r = await unifiedGetPublications(author, 0, 200, filters, this.requiredPaperFields);
        const recent = this.filterPapersByYearRange(r.items || [], startYear, endYear);
        return { total: recent.length, source: r.source, items: this.processPapersForDisplay(recent) };
    }

    async searchPaperByTitle() {
        const q = this.paperTitleInput ? this.paperTitleInput.value.trim() : '';
        if (!q) {
            this.setStatus('请输入论文标题或 DOI', 'warning');
            return;
        }
        this.setStatus(`正在搜索论文: ${q}...`, 'searching');
        try {
            this.currentPaperPage = 0;
            const result = await unifiedSearchPapers(q, 0, 50, {}, this.requiredPaperFields);
            this.lastRecentInfo = '';
            const processed = this.processPapersForDisplay(result.items || []);
            this.rawPapers = processed;
            this.originalPaperTotal = result.total;
            this.currentPaperTotal = processed.length;
            this.currentSource = result.source || result.sourceText || result.source_name || result.source;
            this.extractPaperStats(this.rawPapers);
            this.filterAndRenderPapers();
        } catch (e) {
            this.setStatus('论文搜索失败: ' + e.message, 'error');
        }
    }

    usePaperTitleDirectly() {
        const q = this.paperTitleInput ? this.paperTitleInput.value.trim() : '';
        if (!q) {
            this.setStatus('请输入论文标题或 DOI', 'warning');
            return;
        }
        const paper = {
            title: q,
            authors: [],
            venue: '',
            year: '',
            doi: q.includes('/') && q.includes('.') ? q : '',
            url: '',
            source: 'Manual'
        };
        this.selectPaper(paper);
    }

    getValueFromPaperForField(field, paper) {
        if (!paper || !field) return '';
        const label = String(field.label || field.name || '').toLowerCase();
        const authors = Array.isArray(paper.authors) ? paper.authors.join(', ') : (paper.authors || '');

        if (label.includes('title') || label.includes('论文题') || label.includes('题目')) return paper.title || '';
        if (label.includes('author') || label.includes('作者')) return authors;
        if (label.includes('组织者') || label.includes('organizer') || label.includes('organiser') || label.includes('chair')) {
            if (Array.isArray(paper.organizers) && paper.organizers.length) return paper.organizers.join(', ');
            return '';
        }
        const isStartPage = (label.includes('起始') || label.includes('首页') || label.includes('start') || label.includes('first')) && label.includes('page');
        const isEndPage = (label.includes('终止') || label.includes('末页') || label.includes('end') || label.includes('last')) && label.includes('page');
        const isPageRange = (label.includes('页码') || label.includes('pages') || label.includes('page range')) && !isStartPage && !isEndPage;
        if (isStartPage) return paper.firstPage || '';
        if (isEndPage) return paper.lastPage || '';
        if (isPageRange) return paper.pageRange || '';
        const isConferenceDateField =
            (label.includes('会议') || label.includes('conference') || label.includes('event')) &&
            (label.includes('日期') || label.includes('时间') || label.includes('date') || label.includes('time')) &&
            !(label.includes('发表') || label.includes('出版') || label.includes('publication') || label.includes('publish'));
        const isConferenceStartDateField =
            isConferenceDateField && (label.includes('开始') || label.includes('start') || label.includes('from') || label.includes('起始'));
        const isConferenceEndDateField =
            isConferenceDateField && (label.includes('结束') || label.includes('end') || label.includes('to') || label.includes('终止'));
        if (isConferenceStartDateField) return paper.conferenceStartDate || '';
        if (isConferenceEndDateField) return paper.conferenceEndDate || '';
        if (isConferenceDateField) return paper.conferenceEventDate || paper.conferenceStartDate || '';

        if (label.includes('发表日期') || label.includes('出版日期') || (label.includes('publication') && label.includes('date')) || (label.includes('publish') && label.includes('date'))) return paper.publicationDate || '';
        if (label.includes('发表月份') || label.includes('出版月份') || ((label.includes('month') || label.includes('月份') || label.includes('月')) && (label.includes('发表') || label.includes('出版') || label.includes('publish') || label.includes('publication')))) return paper.publicationMonth || '';
        if (label.includes('发表日') || label.includes('出版日') || ((label.includes('day') || label.includes('日')) && (label.includes('发表') || label.includes('出版') || label.includes('publish') || label.includes('publication')))) return paper.publicationDay || '';
        if (label.includes('language') || label.includes('语言')) {
            const code = String(paper.language || '').toLowerCase().trim();
            if (!code) return '';
            if (label.includes('language')) {
                if (code === 'en') return 'English';
                if (code === 'zh') return 'Chinese';
                return code;
            }
            if (code === 'en') return '英文';
            if (code === 'zh') return '中文';
            return code;
        }
        if (label.includes('地点') || label.includes('地址') || label.includes('address') || label.includes('location')) return paper.conferenceLocation || '';
        if (
            (label.includes('venue') || label.includes('conference') || label.includes('journal') || label.includes('期刊') || label.includes('会议')) &&
            !(label.includes('地址') || label.includes('地点') || label.includes('address') || label.includes('location') || label.includes('组织者') || label.includes('organizer') || label.includes('organiser') || label.includes('chair'))
        ) return paper.venueFormatted || paper.venue || '';
        if (label.includes('year') || label.includes('年份') || label.includes('出版年')) return paper.year || '';
        const isArticleNumber =
            label.includes('文章号') || label.includes('文章编号') || label.includes('文章编码') ||
            label.includes('articlenumber') || (label.includes('article') && label.includes('number')) ||
            (label.includes('编号') && !label.includes('doi')) || (label.includes('编码') && !label.includes('doi'));
        if (isArticleNumber) return paper.articleNumber || '';
        if (label.includes('doi')) return paper.doi || '';
        if (label.includes('url') || label.includes('link') || label.includes('链接') || (field.type || '').toLowerCase() === 'url') return paper.url || '';
        if (label.includes('abstract') || label.includes('摘要')) return paper.abstract || '';
        if (label.includes('keyword') || label.includes('关键词')) {
            if (Array.isArray(paper.keywords)) return paper.keywords.join(', ');
            return paper.keywords || '';
        }
        if (label.includes('citation') || label.includes('引用')) return paper.citationCount != null ? String(paper.citationCount) : '';
        if (label.includes('grant') || label.includes('fund') || label.includes('基金') || label.includes('资助')) {
            if (Array.isArray(paper.grants)) return JSON.stringify(paper.grants);
            return paper.grants || '';
        }
        return '';
    }

    // ====== 批量处理逻辑 ======

    detectRepeatedGroups() {
        this.repeatedPatterns = [];
        if (!this.fieldGroups || this.fieldGroups.length < 2) return;

        let i = 0;
        while (i < this.fieldGroups.length) {
            const structure = this.getGroupStructure(this.fieldGroups[i]);
            let j = i + 1;
            const groupIdxs = [i];
            
            while (j < this.fieldGroups.length) {
                const nextStructure = this.getGroupStructure(this.fieldGroups[j]);
                if (this.isStructureSimilar(structure, nextStructure)) {
                    groupIdxs.push(j);
                    j++;
                } else {
                    break;
                }
            }
            
            if (groupIdxs.length >= 2) {
                this.repeatedPatterns.push({
                    name: this.fieldGroups[i].name.replace(/\d+|一|二|三|四|五/g, '').trim(),
                    groupIdxs: groupIdxs,
                    structure: structure
                });
                i = j;
            } else {
                i++;
            }
        }
        console.log('✨ 识别到重复群组模式:', this.repeatedPatterns);
    }

    getGroupStructure(group) {
        if (!group || !group.fields) return [];
        return group.fields.map(f => ({
            type: f.type,
            label: (f.label || '').replace(/\d+/g, '').trim(),
            name: f.name.replace(/\d+/g, '').trim()
        }));
    }

    isStructureSimilar(s1, s2) {
        if (s1.length !== s2.length || s1.length === 0) return false;
        for (let i = 0; i < s1.length; i++) {
            if (s1[i].type !== s2[i].type) return false;
            const l1 = s1[i].label.toLowerCase();
            const l2 = s2[i].label.toLowerCase();
            if (l1 !== l2 && !l1.includes(l2) && !l2.includes(l1)) return false;
        }
        return true;
    }

    showBatchProcessHint(pattern) {
        this.fieldActionChoice.style.display = 'none';
        this.batchProcessArea.style.display = 'block';
        this.batchProcessInitialActions.style.display = 'flex';
        this.batchInputArea.style.display = 'none';
        this.batchProgressArea.style.display = 'none';
        this.batchResultsArea.style.display = 'none';
        
        this.batchProcessHint.textContent = `检测到连续 ${pattern.groupIdxs.length} 个相似的 "${pattern.name}" 群组，是否要进行批量并行处理？`;
    }

    showBatchInput() {
        this.batchProcessInitialActions.style.display = 'none';
        this.batchCandidateArea.style.display = 'none';
        this.batchInputArea.style.display = 'block';
        this.batchInputLabel.textContent = `请输入要处理的 ${this.currentBatchPattern.name} 核心信息 (每行一个，最多 ${this.currentBatchPattern.groupIdxs.length} 个):`;
        this.batchInputList.placeholder = `例如：\n项目 1 名称\n项目 2 名称\n...`;
        this.batchInputList.focus();
    }

    async analyzeAndFetchCandidates() {
        this.batchProcessInitialActions.style.display = 'none';
        this.batchCandidateArea.style.display = 'block';
        this.batchCandidateList.innerHTML = '';
        
        const pattern = this.currentBatchPattern;
        
        try {
            const maxCount = pattern.groupIdxs.length;
            const base = Array.isArray(this.currentPapers) && this.currentPapers.length ? this.currentPapers : (this.rawPapers || []);
            if (!base.length) {
                this.batchCandidateList.innerHTML = '<div style="padding: 15px; color: #718096; font-size: 13px;">当前没有可用的论文列表。请先在作者搜索中选择作者并加载论文。</div>';
                return;
            }

            const sorted = [...base].sort((a, b) => {
                const ay = parseInt(a.year || '0', 10);
                const by = parseInt(b.year || '0', 10);
                if (by !== ay) return by - ay;
                const ac = typeof a.citationCount === 'number' ? a.citationCount : -1;
                const bc = typeof b.citationCount === 'number' ? b.citationCount : -1;
                return bc - ac;
            });

            const candidates = sorted.slice(0, Math.min(50, sorted.length));
            this.batchCandidatesData = new Map();
            this.batchCandidateLabel.textContent = `已从学术 API 获取候选论文。请勾选要批量填写的论文 (最多 ${maxCount} 项):`;

            let listHTML = '';
            candidates.forEach((paper, index) => {
                const key = paper.doi || paper.url || `${paper.title}__${paper.year || ''}__${paper.venue || ''}`;
                this.batchCandidatesData.set(key, paper);
                const desc = `${paper.year || ''} ${paper.venue || ''}`.trim();
                listHTML += `
                    <div style="padding: 8px; border-bottom: 1px solid #edf2f7; display: flex; align-items: flex-start; gap: 10px;">
                        <input type="checkbox" id="cb-${index}" value="${this.escapeHtml(key)}" style="margin-top: 3px;">
                        <label for="cb-${index}" style="font-size: 12px; color: #4a5568; cursor: pointer; line-height: 1.4;">
                            <div style="font-weight: 600; color: #2d3748;">${this.escapeHtml(paper.title || '')}</div>
                            <div style="font-size: 11px; color: #718096;">${this.escapeHtml(desc)}</div>
                        </label>
                    </div>
                `;
            });

            this.batchCandidateList.innerHTML = listHTML;

        } catch (error) {
            console.error('批量搜寻执行失败:', error);
            this.batchCandidateList.innerHTML = `<div style="padding: 15px; color: #e53e3e; font-size: 13px;">搜索执行出错: ${error.message}。将恢复逐个填写。</div>`;
            setTimeout(() => {
                this.batchProcessedGroups.add(pattern.groupIdxs[0]);
                this.batchProcessArea.style.display = 'none';
                this.processNextField();
            }, 3000);
        }
    }

    async startBatchExecutionFromSelection() {
        const checkboxes = this.batchCandidateList.querySelectorAll('input[type="checkbox"]:checked');
        const selectedItems = Array.from(checkboxes).map(cb => cb.value);
        
        if (selectedItems.length === 0) {
            this.setStatus('请至少选择一个项目', 'warning');
            return;
        }

        const pattern = this.currentBatchPattern;
        if (selectedItems.length > pattern.groupIdxs.length) {
            this.setStatus(`最多只能选择 ${pattern.groupIdxs.length} 项，您选择了 ${selectedItems.length} 项。`, 'warning');
            return;
        }

        // 切换到进度展示，并将选择的项目填充到 inputList 中（以便 startBatchExecution 逻辑复用）
        this.batchCandidateArea.style.display = 'none';
        this.batchInputList.value = selectedItems.join('\n');
        
        // 复用现有的执行逻辑
        this.startBatchExecution();
    }

    skipBatchProcess() {
        this.skipBatchMode = true;  // 新增属性，在构造函数中初始化为 false
        this.batchProcessArea.style.display = 'none';
        this.processNextField();
    }

    cancelBatchInput() {
        this.batchInputArea.style.display = 'none';
        this.batchProcessInitialActions.style.display = 'flex';
    }

    async startBatchExecution() {
        const inputText = this.batchInputList.value.trim();
        if (!inputText) {
            this.setStatus('请输入项目信息', 'warning');
            return;
        }

        const items = inputText.split('\n').map(line => line.trim()).filter(Boolean);
        if (items.length === 0) return;

        const pattern = this.currentBatchPattern;
        const taskCount = Math.min(items.length, pattern.groupIdxs.length);
        const processingItems = items.slice(0, taskCount);

        this.batchInputArea.style.display = 'none';
        this.batchProgressArea.style.display = 'block';
        this.batchThoughtsLog.innerHTML = '<div style="color: #48bb78;">> 启动并行处理引擎...</div>';
        this.batchExecutionCancelled = false;
        this.updateBatchProgress(0, taskCount);

        const results = [];
        const concurrency = 2; // 并发数控制
        
        // 获取第一组的字段作为模板（用于结果对齐）
        const templateFields = this.fieldGroups[pattern.groupIdxs[0]].fields;

        try {
            for (let i = 0; i < taskCount; i += concurrency) {
                if (this.batchExecutionCancelled) break;

                const chunk = processingItems.slice(i, i + concurrency);
                
                // 增强稳定性：在每一批（Chunk）之间添加一小段延迟，防止并发过高被网站拦截
                if (i > 0) {
                    this.logBatchThought(`等待引擎冷却并准备下一批任务...`, '#718096');
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }

                const promises = chunk.map(async (item, chunkIdx) => {
                    const globalIdx = i + chunkIdx;
                    
                    // 为同一批内的任务也添加微小的交错延迟，模拟人类操作
                    if (chunkIdx > 0) {
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                    
                    const groupIdx = pattern.groupIdxs[globalIdx];
                    const group = this.fieldGroups[groupIdx];
                    return this.processBatchItem(item, group, globalIdx, templateFields);
                });

                const chunkResults = await Promise.all(promises);
                results.push(...chunkResults);
                this.updateBatchProgress(results.length, taskCount);
            }

            if (!this.batchExecutionCancelled) {
                this.showBatchResultsTable(pattern, results);
            }
        } catch (error) {
            console.error('批量执行出错:', error);
            this.setStatus('批量执行出错: ' + error.message, 'error');
        }
    }

    async processBatchItem(itemValue, group, index, templateFields) {
        this.logBatchThought(`[项目 ${index + 1}] 正在从学术 API 获取元数据...`, '#4299e1', `status-${index}`);

        const itemResults = { _item: itemValue };
        templateFields.forEach(f => { itemResults[f.name] = ''; });

        let paper = this.batchCandidatesData?.get(itemValue);
        if (!paper) {
            const maybeDoi = String(itemValue || '').trim();
            if (maybeDoi.includes('/') && maybeDoi.includes('.')) {
                const byDoi = await getPaperByDOI(maybeDoi);
                if (byDoi.success) paper = byDoi.paper;
            }
        }
        if (!paper) {
            const r = await unifiedGetPublications(itemValue, 0, 5, {}, this.requiredPaperFields);
            paper = r.items?.[0];
        }
        if (!paper) {
            templateFields.forEach(f => { itemResults[f.name] = '未找到答案'; });
            this.logBatchThought(`[项目 ${index + 1}] 未找到对应论文`, '#f56565', `status-${index}`);
            return itemResults;
        }

        for (let fIdx = 0; fIdx < group.fields.length; fIdx++) {
            if (this.batchExecutionCancelled) break;
            const field = group.fields[fIdx];
            const templateFieldName = templateFields[fIdx]?.name;
            if (!templateFieldName) continue;
            const v = this.getValueFromPaperForField(field, paper);
            itemResults[templateFieldName] = v || '未找到答案';
        }

        this.logBatchThought(`[项目 ${index + 1}] 处理完成 ✅`, '#48bb78', `status-${index}`);
        return itemResults;
    }

    logBatchThought(msg, color = '#a0aec0', key = null) {
        if (!this.batchThoughtsLog) return;
        
        let div = key ? this.batchThoughtsLog.querySelector(`[data-key="${key}"]`) : null;
        if (!div) {
            div = document.createElement('div');
            if (key) div.setAttribute('data-key', key);
            div.style.marginBottom = '2px';
            this.batchThoughtsLog.appendChild(div);
        }
        
        div.style.color = color;
        div.textContent = `> ${msg}`;
        this.batchThoughtsLog.scrollTop = this.batchThoughtsLog.scrollHeight;
        
        // 限制总行数 (只针对非 Key 绑定的普通日志进行限制)
        if (!key && this.batchThoughtsLog.childNodes.length > 50) {
            this.batchThoughtsLog.removeChild(this.batchThoughtsLog.firstChild);
        }
    }

    updateBatchProgress(completed, total) {
        const percent = Math.round((completed / total) * 100);
        this.batchProgressFill.style.width = `${percent}%`;
        this.batchProgressText.textContent = `${completed}/${total}`;
    }

    stopBatchExecution() {
        this.batchExecutionCancelled = true;
        this.batchProgressArea.style.display = 'none';
        this.batchProcessArea.style.display = 'none';
        this.setStatus('批量处理已停止', 'warning');
        this.processNextField();
    }

    showBatchResultsTable(pattern, results) {
        this.batchProgressArea.style.display = 'none';
        this.batchResultsArea.style.display = 'block';
        
        const fields = this.fieldGroups[pattern.groupIdxs[0]].fields;
        
        // 生成表头
        let tableHTML = '<thead><tr>';
        fields.forEach(f => {
            tableHTML += `<th>${f.label || f.name}</th>`;
        });
        tableHTML += '</tr></thead><tbody>';
        
        // 生成内容
        results.forEach((row, rowIdx) => {
            tableHTML += '<tr>';
            fields.forEach(f => {
                const val = row[f.name] || '';
                tableHTML += `<td><input type="text" data-row="${rowIdx}" data-field="${f.name}" value="${this.escapeHtml(val)}"></td>`;
            });
            tableHTML += '</tr>';
        });
        tableHTML += '</tbody>';
        
        this.batchResultsTable.innerHTML = tableHTML;
    }

    async fillAllBatchResults() {
        const pattern = this.currentBatchPattern;
        const rows = this.batchResultsTable.querySelectorAll('tbody tr');
        const templateFields = this.fieldGroups[pattern.groupIdxs[0]].fields;
        
        this.setStatus('正在批量填入表单...', 'searching');
        
        for (let i = 0; i < rows.length; i++) {
            const groupIdx = pattern.groupIdxs[i];
            const group = this.fieldGroups[groupIdx];
            const inputs = rows[i].querySelectorAll('input');
            
            for (let fIdx = 0; fIdx < inputs.length; fIdx++) {
                const input = inputs[fIdx];
                const value = input.value;
                // 使用索引来找到当前群组中对应的字段，而不是用 data-field 名
                const field = group.fields[fIdx];
                
                if (field && value && value !== '未找到答案' && value !== '错误') {
                    await this.sendMessageToBackground({
                        action: 'fillFormField',
                        data: {
                            fieldName: field.name,
                            value: value,
                            fieldSelector: field.selector || '',
                            tabId: this.formTabId
                        }
                    });
                    
                    // 记录到已填写
                    this.filledFields[field.name] = {
                        label: field.label || field.name,
                        answer: value,
                        method: 'ai',
                        timestamp: Date.now()
                    };
                    
                    this.filledContext[field.name] = {
                        label: field.label || field.name,
                        answer: value,
                        fieldType: field.type || 'text'
                    };
                }
            }
        }
        
        // 标记这些群组已处理
        pattern.groupIdxs.forEach(idx => this.batchProcessedGroups.add(idx));
        
        // 更新统计信息
        this.updateStats();
        
        // 更新进度条 UI
        const totalFilled = Object.keys(this.filledFields).length;
        const progressPercent = (totalFilled / this.currentFormFields.length) * 100;
        this.progressFill.style.width = `${progressPercent}%`;
        this.progressInfo.textContent = `已填写 ${totalFilled}/${this.currentFormFields.length} 个字段`;
        
        this.setStatus('批量填写完成', 'success');
        this.batchProcessArea.style.display = 'none';
        
        // 核心修正：定位到未处理的群组
        let nextIdx = pattern.groupIdxs[pattern.groupIdxs.length - 1] + 1;
        while (nextIdx < this.fieldGroups.length && this.batchProcessedGroups.has(nextIdx)) {
            nextIdx++;
        }
        this.currentGroupIndex = nextIdx;
        this.currentFieldIndexInGroup = 0;
        
        // 继续处理下一个
        this.processNextField();
    }
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
    window.formFillingSidebar = new FormFillingSidebar();
});
