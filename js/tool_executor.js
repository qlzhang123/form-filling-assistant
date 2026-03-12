import { searchPublications, searchAuthors, getPublicationByKey, getAuthorByPid } from './dblp_api.js';
import { searchConferenceLocation, searchConferenceOrganizers, searchConferenceEventDate } from './api_client.js';

class EnhancedToolExecutor {
    constructor() {
        this.tools = {};
        this.registerDefaultTools();
    }

    registerTool(name, description, func) {
        /**
         * 向工具箱中注册一个新工具。
         */
        if (name in this.tools) {
            console.warn(`警告:工具 '${name}' 已存在，将被覆盖。`);
        }
        this.tools[name] = {"description": description, "func": func};
        console.log(`工具 '${name}' 已注册。`);
    }

    getTool(name) {
        /**
         * 根据名称获取一个工具的执行函数。
         */
        return this.tools[name] ? this.tools[name].func : null;
    }

    getAvailableTools() {
        /**
         * 获取所有可用工具的格式化描述字符串。
         */
        return Object.entries(this.tools)
            .map(([name, info]) => `- ${name}: ${info.description}`)
            .join('\n');
    }

    async execute(toolName, input, context = {}) {
        /**
         * 执行指定的工具
         */
        const tool = this.getTool(toolName);
        if (!tool) {
            return {
                success: false,
                message: `错误:未找到名为 '${toolName}' 的工具。`
            };
        }

        try {
            // 执行工具函数
            const result = await tool(input, context);
            return result;
        } catch (error) {
            return {
                success: false,
                message: `执行工具 '${toolName}' 时出错: ${error.message}`
            };
        }
    }

    registerDefaultTools() {
        /**
         * 注册默认工具
         */
        // —— DBLP 基础数据 ——
        this.registerTool(
            'GetPaperDetails',
            '通过DBLP API获取论文详细信息。输入：论文标题字符串，或{"key": "..."}。',
            async (params) => this.getPaperDetails(params)
        );

        this.registerTool(
            'GetAuthorDetails',
            '通过DBLP API获取作者详情。输入：作者姓名字符串，或{"pid": "..."}。',
            async (params) => this.getAuthorDetails(params)
        );

        // —— 补充来源：Semantic Scholar / OpenCitations / CrossRef / OpenAlex ——
        this.registerTool(
            'GetPaperDetailsSemanticScholar',
            '通过 Semantic Scholar 获取论文详情（关键词、摘要、引用数、PDF、年份等）。输入：标题字符串，或 { doi }。',
            async (params) => this.getPaperDetailsSemanticScholar(params)
        );
        this.registerTool(
            'GetAuthorDetailsSemanticScholar',
            '通过 Semantic Scholar 获取作者信息（别名、单位、主页、hIndex 等）。输入：作者姓名字符串，或 { authorId }。',
            async (params) => this.getAuthorDetailsSemanticScholar(params)
        );
        this.registerTool(
            'GetCitationCount',
            '获取引用次数。优先 OpenCitations(需 token)，失败回退到 Semantic Scholar；输入：{ doi }',
            async (params) => this.getCitationCount(params)
        );
        this.registerTool(
            'GetWorkCrossRef',
            '通过 CrossRef 获取作品元数据；输入：{ doi }',
            async (params) => this.getWorkCrossRef(params)
        );
        this.registerTool(
            'GetWorkOpenAlex',
            '通过 OpenAlex 获取作品元数据（含会议信息等）；输入：{ doi }',
            async (params) => this.getWorkOpenAlex(params)
        );

        this.registerTool(
            'GetConferenceLocation',
            '获取会议地点；输入：{"name":"...","year":2024} 或 "name,year"',
            async (params, context = {}) => {
                const parsed = (() => {
                    if (!params) return { name: '', year: '' };
                    if (typeof params === 'string') {
                        const parts = params.split(',').map(s => s.trim()).filter(Boolean);
                        return { name: parts[0] || '', year: parts[1] || '' };
                    }
                    return { name: params.name || params.conferenceName || '', year: params.year || params.publicationYear || '' };
                })();

                const name = String(parsed.name || '').trim();
                const year = String(parsed.year || '').trim();
                if (!name || !year) return { success: false, message: '需要会议名称与年份' };

                const cacheKey = `_conference_location_${name.toLowerCase().replace(/\s+/g, ' ').trim()}_${year}`;
                const cache = context?.discoveryCache;
                if (cache && cache[cacheKey]) {
                    return { success: true, data: { location: cache[cacheKey], source: 'cache' } };
                }

                const r = await searchConferenceLocation(name, year);
                const location = r?.location ? String(r.location).trim() : '';
                if (location) {
                    if (cache) cache[cacheKey] = location;
                    return { success: true, data: { location, source: 'api' } };
                }
                return { success: false, message: '未找到会议地点' };
            }
        );

        this.registerTool(
            'GetConferenceOrganizers',
            '获取会议组织者；输入：{"name":"...","year":2024} 或 "name,year"',
            async (params, context = {}) => {
                const parsed = (() => {
                    if (!params) return { name: '', year: '' };
                    if (typeof params === 'string') {
                        const parts = params.split(',').map(s => s.trim()).filter(Boolean);
                        return { name: parts[0] || '', year: parts[1] || '' };
                    }
                    return { name: params.name || params.conferenceName || '', year: params.year || params.publicationYear || '' };
                })();

                const name = String(parsed.name || '').trim();
                const year = String(parsed.year || '').trim();
                if (!name || !year) return { success: false, message: '需要会议名称与年份' };

                const cacheKey = `_conference_organizers_${name.toLowerCase().replace(/\s+/g, ' ').trim()}__${year}`;
                const cache = context?.discoveryCache;
                if (cache && cache[cacheKey]) {
                    return { success: true, data: { organizers: cache[cacheKey], source: 'cache' } };
                }

                const r = await searchConferenceOrganizers(name, year);
                let orgs = Array.isArray(r?.organizers) ? r.organizers : [];
                // 兜底：如果 organizers 为空且 name/venue 被错误返回，强制失败
                if (!orgs.length) {
                    return { success: false, message: '未找到组织者信息' };
                }
                if (orgs.length) {
                    if (cache) cache[cacheKey] = orgs;
                    return { success: true, data: { organizers: orgs, source: r.source || 'api' } };
                }
                return { success: false, message: '未找到组织者信息' };
            }
        );

        this.registerTool(
            'GetConferenceEventDate',
            '获取会议举办日期（开始/结束/范围）；输入：{"name":"...","year":2024} 或 "name,year"',
            async (params, context = {}) => {
                const parsed = (() => {
                    if (!params) return { name: '', year: '' };
                    if (typeof params === 'string') {
                        const parts = params.split(',').map(s => s.trim()).filter(Boolean);
                        return { name: parts[0] || '', year: parts[1] || '' };
                    }
                    return { name: params.name || params.conferenceName || '', year: params.year || params.publicationYear || '' };
                })();

                const name = String(parsed.name || '').trim();
                const year = String(parsed.year || '').trim();
                if (!name || !year) return { success: false, message: '需要会议名称与年份' };

                const cacheKey = `_conference_event_date_${name.toLowerCase().replace(/\s+/g, ' ').trim()}__${year}`;
                const cache = context?.discoveryCache;
                if (cache && cache[cacheKey]) {
                    return { success: true, data: { ...cache[cacheKey], source: 'cache' } };
                }

                const r = await searchConferenceEventDate(name, year);
                const data = r?.data || null;
                if (data && data.conferenceEventDate) {
                    if (cache) cache[cacheKey] = data;
                    return { success: true, data: { ...data, source: 'api' } };
                }
                return { success: false, message: '未找到会议举办日期' };
            }
        );

        // 表单填写工具
        this.registerTool(
            'FillFormField',
            '填写指定的表单字段',
            async (params) => this.fillFormField(params)
        );

        // 获取页面元素信息工具
        this.registerTool(
            'GetPageElements',
            '获取页面上的表单元素信息',
            async (selector) => this.getPageElements(selector)
        );
    }

    // —— 通用安全取 JSON —— 
    async _safeFetchJSON(url, options = {}) {
        try {
            const res = await fetch(url, options);
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                throw new Error(`${res.status} ${res.statusText}${text ? ` - ${text.slice(0, 200)}` : ''}`);
            }
            return await res.json();
        } catch (e) {
            throw new Error(`请求失败: ${e.message}`);
        }
    }

    // —— Semantic Scholar: 论文详情 —— 
    async getPaperDetailsSemanticScholar(params) {
        try {
            if (!params) return { success: false, message: '缺少输入' };
            // 优先通过 DOI 精确获取
            if (typeof params === 'object' && params.doi) {
                const doi = params.doi.trim();
                const fields = [
                    'title','abstract','year','venue','publicationVenue',
                    'publicationDate','externalIds','authors','fieldsOfStudy',
                    'citationCount','openAccessPdf','url'
                ].join(',');
                const url = `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?fields=${fields}`;
                const data = await this._safeFetchJSON(url);
                return { success: true, data };
            }
            // 否则通过标题搜索
            const title = typeof params === 'string' ? params : params.title || '';
            const q = title.replace(/^["']|["']$/g, '').trim();
            if (!q) return { success: false, message: '无效的标题' };
            const fields = [
                'title','abstract','year','venue','publicationVenue',
                'publicationDate','externalIds','authors','fieldsOfStudy',
                'citationCount','openAccessPdf','url'
            ].join(',');
            const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(q)}&fields=${fields}&limit=5`;
            const data = await this._safeFetchJSON(url);
            const best = data?.data?.[0];
            if (!best) return { success: false, message: '未找到匹配论文' };
            return { success: true, data: best, candidates: data.data };
        } catch (e) {
            return { success: false, message: `Semantic Scholar 查询失败: ${e.message}` };
        }
    }

    // —— Semantic Scholar: 作者详情 —— 
    async getAuthorDetailsSemanticScholar(params) {
        try {
            if (!params) return { success: false, message: '缺少输入' };
            if (typeof params === 'object' && params.authorId) {
                const fields = ['name','aliases','affiliations','homepage','hIndex','paperCount'].join(',');
                const url = `https://api.semanticscholar.org/graph/v1/author/${encodeURIComponent(params.authorId)}?fields=${fields}`;
                const data = await this._safeFetchJSON(url);
                return { success: true, data };
            }
            const name = (typeof params === 'string' ? params : params.name || '').trim();
            if (!name) return { success: false, message: '无效的作者名' };
            const fields = ['name','aliases','affiliations','homepage','hIndex','paperCount'].join(',');
            const url = `https://api.semanticscholar.org/graph/v1/author/search?query=${encodeURIComponent(name)}&fields=${fields}&limit=5`;
            const data = await this._safeFetchJSON(url);
            const best = data?.data?.[0];
            if (!best) return { success: false, message: '未找到匹配作者' };
            return { success: true, data: best, candidates: data.data };
        } catch (e) {
            return { success: false, message: `Semantic Scholar 作者查询失败: ${e.message}` };
        }
    }

    // —— 引用次数：OpenCitations 优先，回退 Semantic Scholar —— 
    async getCitationCount(params) {
        try {
            if (!params || !params.doi) return { success: false, message: '需要 { doi }' };
            const doi = params.doi.trim();

            // 1) 优先 OpenCitations
            try {
                const token = (window?.localStorage?.getItem('opencitations_token') || '').trim();
                const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
                const url = `https://opencitations.net/api/v1/citations/${encodeURIComponent(doi)}`;
                const data = await this._safeFetchJSON(url, { headers });
                const count = Array.isArray(data) ? data.length : (data?.length || 0);
                if (Number.isFinite(count)) {
                    return { success: true, data: { citationCount: count, source: 'OpenCitations' } };
                }
            } catch (_ignored) {
                // 跳过，尝试回退
            }

            // 2) 回退到 Semantic Scholar 单篇接口
            try {
                const fields = 'citationCount';
                const url = `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?fields=${fields}`;
                const data = await this._safeFetchJSON(url);
                if (typeof data?.citationCount === 'number') {
                    return { success: true, data: { citationCount: data.citationCount, source: 'SemanticScholar' } };
                }
            } catch (_ignored2) {}

            return { success: false, message: '无法获取引用次数' };
        } catch (e) {
            return { success: false, message: `获取引用次数失败: ${e.message}` };
        }
    }

    // —— CrossRef: 作品元数据 —— 
    async getWorkCrossRef(params) {
        try {
            if (!params || !params.doi) return { success: false, message: '需要 { doi }' };
            const url = `https://api.crossref.org/works/${encodeURIComponent(params.doi)}`;
            const data = await this._safeFetchJSON(url);
            const message = data?.message || data;
            return { success: true, data: message };
        } catch (e) {
            return { success: false, message: `CrossRef 查询失败: ${e.message}` };
        }
    }

    // —— OpenAlex: 作品元数据 —— 
    async getWorkOpenAlex(params) {
        try {
            if (!params || !params.doi) return { success: false, message: '需要 { doi }' };
            const url = `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(params.doi)}`;
            const data = await this._safeFetchJSON(url);
            return { success: true, data };
        } catch (e) {
            return { success: false, message: `OpenAlex 查询失败: ${e.message}` };
        }
    }

    async getPaperDetails(params) {
        try {
            if (!params) {
                return { success: false, message: '缺少输入' };
            }
            if (typeof params === 'object' && params.key) {
                const detail = await getPublicationByKey(params.key);
                return { success: true, data: detail };
            }
            let query = typeof params === 'string' ? params : params.title || '';
            query = query.replace(/^["']|["']$/g, '').trim();
            if (!query) {
                return { success: false, message: '无效的查询' };
            }
            const list = await searchPublications(query);
            if (!list || list.length === 0) {
                return { success: false, message: '未找到匹配的论文' };
            }
            const candidate = list[0];
            let detail = null;
            if (candidate.key) {
                detail = await getPublicationByKey(candidate.key);
            }
            const merged = {
                title: candidate.title || detail?.title || '',
                authors: candidate.authors || detail?.authors || [],
                year: candidate.year || detail?.year || '',
                venue: candidate.venue || detail?.venue || '',
                doi: candidate.doi || detail?.doi || '',
                ee: candidate.ee || detail?.ee || '',
                key: candidate.key || detail?.key || '',
                abstract: detail?.abstract || '',
                keywords: detail?.keywords || []
            };
            return { success: true, data: merged, candidates: list.slice(0, 5) };
        } catch (e) {
            return { success: false, message: `获取论文信息失败: ${e.message}` };
        }
    }

    async getAuthorDetails(params) {
        try {
            if (!params) {
                return { success: false, message: '缺少输入' };
            }
            if (typeof params === 'object' && params.pid) {
                const detail = await getAuthorByPid(params.pid);
                return { success: true, data: detail };
            }
            let name = typeof params === 'string' ? params : params.name || '';
            name = name.replace(/^["']|["']$/g, '').trim();
            if (!name) {
                return { success: false, message: '无效的作者名' };
            }
            const list = await searchAuthors(name);
            if (!list || list.length === 0) {
                return { success: false, message: '未找到匹配的作者' };
            }
            const candidate = list[0];
            const detail = candidate.pid ? await getAuthorByPid(candidate.pid) : null;
            const merged = {
                name: candidate.name || detail?.name || '',
                pid: candidate.pid || detail?.pid || '',
                url: candidate.url || detail?.url || '',
                homepages: detail?.homepages || [],
                affiliations: detail?.affiliations || [],
                aliases: candidate.aliases || [],
                notes: detail?.notes || []
            };
            return { success: true, data: merged, candidates: list.slice(0, 5) };
        } catch (e) {
            return { success: false, message: `获取作者信息失败: ${e.message}` };
        }
    }

    async academicSearch(query) {
        /**
         * 学术搜索工具
         */
        try {
            // 清理查询词，移除可能的引号
            query = query.replace(/^["']|["']$/g, '').trim();
            
            // 构建搜索URL
            const searchUrl = `https://dblp.org/search?q=${encodeURIComponent(query)}`;
            
            let tab;
            // 在新标签页中打开搜索结果
            if (this.browserController) {
                tab = await this.browserController.openSearchPage(query, 'dblp');
            } else {
                // 如果没有浏览器控制器，模拟打开
                window.open(searchUrl, '_blank');
            }
            
            // 模拟返回搜索结果（实际上搜索页面已经打开）
            return {
                success: true,
                message: `已在标签页 ${tab ? tab.id : '未知'} 中打开 DBLP 搜索页面。关键词: "${query}"。请立即执行 'ExtractPageContent[${tab ? tab.id : 'ID'}]'。`,
                searchUrl: searchUrl,
                tabId: tab ? tab.id : null
            };
        } catch (error) {
            return {
                success: false,
                message: `学术搜索失败: ${error.message}`
            };
        }
    }

    async searchAuthor(authorName) {
        /**
         * 搜索作者工具
         */
        try {
            // 清理查询词
            authorName = authorName.replace(/^["']|["']$/g, '').trim();
            
            let tab;
            if (this.browserController) {
                tab = await this.browserController.openSearchPage(`author:${authorName}`, 'dblp');
            } else {
                window.open(`https://dblp.org/search?q=author:${encodeURIComponent(authorName)}`, '_blank');
            }
            
            return {
                success: true,
                message: `已在标签页 ${tab ? tab.id : '未知'} 中打开 DBLP 作者搜索页面。作者: "${authorName}"。请立即执行 'ExtractPageContent[${tab ? tab.id : 'ID'}]' 来查找正确的作者主页链接。`,
                tabId: tab ? tab.id : null
            };
        } catch (error) {
            return {
                success: false,
                message: `作者搜索失败: ${error.message}`
            };
        }
    }

    async webSearch(query) {
        /**
         * 网页搜索工具
         */
        try {
            // 清理查询词，移除可能的引号
            query = query.replace(/^["']|["']$/g, '').trim();
            
            // 构建搜索URL
            const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
            
            let tab;
            // 在新标签页中打开搜索结果
            if (this.browserController) {
                tab = await this.browserController.openSearchPage(query, 'google');
            } else {
                window.open(searchUrl, '_blank');
            }
            
            return {
                success: true,
                message: `已在标签页 ${tab ? tab.id : '未知'} 中打开 Google 搜索页面。关键词: "${query}"。请立即执行 'ExtractPageContent[${tab ? tab.id : 'ID'}]'。`,
                searchUrl: searchUrl,
                tabId: tab ? tab.id : null
            };
        } catch (error) {
            return {
                success: false,
                message: `网页搜索失败: ${error.message}`
            };
        }
    }

    async extractPageContent(params = {}) {
        /**
         * 提取页面内容工具
         */
        try {
            let content;
            let targetTabId = null;
            
            // 解析参数：支持多种形式
            // 1. 直接传入数字: ExtractPageContent(1202095641)
            // 2. 传入字符串数字: ExtractPageContent("1202095641") ← AI 常用
            // 3. 传入对象: ExtractPageContent({tabId: 1202095641})
            if (typeof params === 'number') {
                targetTabId = params;
            } else if (typeof params === 'string') {
                // 尝试将字符串解析为数字
                const parsed = parseInt(params, 10);
                if (!isNaN(parsed)) {
                    targetTabId = parsed;
                }
            } else if (params && typeof params === 'object' && params.tabId) {
                targetTabId = typeof params.tabId === 'number' ? params.tabId : parseInt(params.tabId, 10);
            }
            
            if (this.browserController) {
                // 优先使用传入的 tabId
                if (targetTabId && !isNaN(targetTabId)) {
                    console.log(`ExtractPageContent: 使用指定的标签页 ID ${targetTabId}`);
                    content = await this.browserController.analyzePageContent(targetTabId);
                } else {
                    // 并行安全检查：如果未指定 tabId 且当前有多个临时搜索标签页，提示 Agent
                    const tempTabs = Array.from(this.browserController.tempTabIds);
                    if (tempTabs.length > 1) {
                        return {
                            success: false,
                            message: `错误：当前有多个活动搜索标签页 [${tempTabs.join(', ')}]。你必须显式指定要提取的 tabId（如 ExtractPageContent[${tempTabs[0]}]），否则会读取到错误任务的数据。`
                        };
                    }
                    
                    // 如果没有传入 tabId，才使用当前活动标签页
                    console.log('ExtractPageContent: 未指定标签页 ID，使用当前活动标签页');
                    const currentTab = await this.browserController.getCurrentTab();
                    if (currentTab) {
                        content = await this.browserController.analyzePageContent(currentTab.id);
                    } else {
                        // 如果无法获取当前标签页，使用当前页面内容
                        content = this._extractCurrentPageContent();
                    }
                }
            } else {
                // 在非扩展环境中，直接提取当前页面内容
                content = this._extractCurrentPageContent();
            }
            
            return {
                success: true,
                message: '页面内容提取成功',
                content: content
            };
        } catch (error) {
            return {
                success: false,
                message: `页面内容提取失败: ${error.message}`
            };
        }
    }

    _extractCurrentPageContent() {
        /**
         * 从当前页面提取内容（辅助方法）
         */
        return {
            title: document.title,
            headings: Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
                         .map(el => el.textContent.trim())
                         .filter(text => text.length > 0),
            paragraphs: Array.from(document.querySelectorAll('p'))
                           .map(el => el.textContent.trim())
                           .filter(text => text.length > 20)
                           .slice(0, 10),
            links: Array.from(document.querySelectorAll('a[href]'))
                      .map(a => ({ text: a.textContent.trim(), href: a.href }))
                      .filter(a => a.text && a.href)
                      .slice(0, 10),
            forms: Array.from(document.querySelectorAll('form'))
                     .map(form => ({
                         action: form.action,
                         method: form.method,
                         inputs: Array.from(form.querySelectorAll('input, select, textarea'))
                                   .map(input => ({
                                       name: input.name || input.id,
                                       type: input.type,
                                       value: input.value
                                   }))
                     }))
        };
    }

    async fillFormField(params) {
        try {
            let fieldName, value, tabId;
            if (typeof params === 'string') {
                const parts = params.split(',').map(p => p.trim());
                if (parts.length >= 2) {
                    fieldName = parts[0];
                    value = parts.slice(1).join(',');
                } else {
                    fieldName = params;
                    value = '';
                }
            } else {
                ({ fieldName, value, tabId } = params);
            }
            if (typeof chrome !== 'undefined' && chrome.scripting) {
                if (!tabId) {
                    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
                    if (tabs && tabs.length > 0) {
                        tabId = tabs[0].id;
                    }
                }
                if (!tabId) {
                    return { success: false, message: '无法获取目标标签页ID' };
                }
                const results = await chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    func: (fieldName, value) => {
                        const normalize = (s) => {
                            if (s == null) return '';
                            const t = String(s).trim().toLowerCase();
                            return t.replace(/\s+/g, '')
                                    .replace(/[()（）\[\]【】"'“”‘’:,;；、\-]/g, '');
                        };
                        const mapEnZh = (v) => {
                            const x = String(v || '').trim().toLowerCase();
                            const m = {
                                'conference': '会议论文',
                                'conferencepaper': '会议论文',
                                'proceedings': '会议论文',
                                'oral': '分组报告',
                                'sessiontalk': '分组报告',
                                'talk': '分组报告',
                                'invitedtalk': '特邀报告',
                                'invited': '特邀报告',
                                'poster': '墙报展示',
                                'journal': '期刊论文',
                                'journalarticle': '期刊论文',
                                'article': '期刊论文',
                                'thesis': '学位论文',
                                'phdthesis': '学位论文',
                                'mastersthesis': '学位论文',
                                'technicalreport': '技术报告',
                                'techreport': '技术报告',
                                'dataset': '数据集',
                                'patent': '专利',
                                'bookchapter': '著作章节',
                                'chapter': '著作章节',
                                'preprint': '预印本',
                                'arxiv': '预印本',
                                'english': '外文',
                                'en': '外文',
                                'chinese': '中文',
                                'zh': '中文',
                                'openaccess': '开放获取',
                                'oa': '开放获取',
                                'closedaccess': '非开放获取',
                                'nonopenaccess': '非开放获取',
                                'pku': '北大中文核心期刊',
                                'pkucore': '北大中文核心期刊',
                                'pkuchinese': '北大中文核心期刊',
                                'yes': '是',
                                'true': '是',
                                'no': '否',
                                'false': '否',
                                'scie': 'SCIE',
                                'ssci': 'SSCI',
                                'ei': 'EI',
                                'cssci': 'CSSCI',
                                'istp': 'ISTP'
                            };
                            return m[x] || v;
                        };
                        const splitMulti = (v) => {
                            if (Array.isArray(v)) return v;
                            const s = String(v || '');
                            return s.split(/[;,；、|]/).map(i => i.trim()).filter(i => i);
                        };
                        const getLabelText = (el) => {
                            if (!el) return '';
                            const lab = el.labels && el.labels.length ? el.labels[0] : null;
                            if (lab) return lab.textContent.trim();
                            const p = el.closest('label');
                            if (p) return p.textContent.trim();
                            return el.getAttribute('aria-label') || el.title || '';
                        };
                        const matchOption = (option, target) => {
                            const targets = [String(target), mapEnZh(target)];
                            const ot = option.textContent ? option.textContent.trim() : '';
                            const ov = option.value != null ? String(option.value) : '';
                            for (const t of targets) {
                                if (!t) continue;
                                if (normalize(ov) === normalize(t)) return true;
                                if (normalize(ot) === normalize(t)) return true;
                                if (normalize(ot).includes(normalize(t))) return true;
                                if (normalize(t).includes(normalize(ot))) return true;
                            }
                            return false;
                        };
                        const matchLabel = (labelText, target) => {
                            const targets = [String(target), mapEnZh(target)];
                            for (const t of targets) {
                                if (!t) continue;
                                if (normalize(labelText) === normalize(t)) return true;
                                if (normalize(labelText).includes(normalize(t))) return true;
                                if (normalize(t).includes(normalize(labelText))) return true;
                            }
                            return false;
                        };
                        const isVisible = (el) => {
                            if (!el) return false;
                            const style = window.getComputedStyle(el);
                            return el.offsetParent !== null && style.visibility !== 'hidden' && style.display !== 'none';
                        };
                        const collectDropdownOptions = () => {
                            const selectors = [
                                '[role="option"]',
                                '.ant-select-item-option',
                                '.ant-select-item-option-content',
                                '.el-select-dropdown__item',
                                '.select2-results__option',
                                'li'
                            ];
                            const els = [];
                            for (const sel of selectors) {
                                try { els.push(...Array.from(document.querySelectorAll(sel))); } catch (_) {}
                            }
                            const uniq = [...new Set(els)].filter(isVisible);
                            return uniq.map(el => ({
                                el,
                                text: (el.textContent || '').trim(),
                                value: el.getAttribute('data-value') || el.getAttribute('value') || ''
                            })).filter(o => o.text.length > 0);
                        };
                        const tryClickSelectOption = (rawValue) => {
                            const targets = [String(rawValue), mapEnZh(rawValue)];
                            const options = collectDropdownOptions();
                            const matches = (opt, t) => {
                                const tt = normalize(opt.text);
                                const tv = normalize(opt.value);
                                const tx = normalize(t);
                                return (tv && (tv === tx || tv.includes(tx) || tx.includes(tv))) || (tt && (tt === tx || tt.includes(tx) || tx.includes(tt)));
                            };
                            let chosen = null;
                            for (const t of targets) {
                                chosen = options.find(o => matches(o, t));
                                if (chosen) break;
                            }
                            if (!chosen) return null;
                            try { chosen.el.click(); } catch (_) {}
                            try { chosen.el.dispatchEvent(new Event('click', { bubbles: true })); } catch (_) {}
                            try { chosen.el.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
                            return chosen;
                        };
                        const findGroupContainer = (groupName) => {
                            const labels = Array.from(document.querySelectorAll('.field-label'));
                            for (const lab of labels) {
                                if (normalize(lab.textContent).includes(normalize(groupName))) {
                                    const row = lab.closest('.field-row');
                                    if (row) return row;
                                }
                            }
                            return null;
                        };
                        let field = document.querySelector(`[name="${fieldName}"]`) ||
                                   document.querySelector(`#${fieldName}`) ||
                                   document.querySelector(`input[name="${fieldName}"]`) ||
                                   document.querySelector(`select[name="${fieldName}"]`) ||
                                   document.querySelector(`textarea[name="${fieldName}"]`);
                        if (!field) {
                            const labels = Array.from(document.querySelectorAll('label'));
                            for (const label of labels) {
                                const lt = label.textContent || '';
                                if (normalize(lt).includes(normalize(fieldName))) {
                                    const associatedField = document.querySelector(`#${label.htmlFor}`) ||
                                                           label.querySelector('input, select, textarea');
                                    if (associatedField) {
                                        field = associatedField;
                                        break;
                                    }
                                }
                            }
                        }
                        if (field) {
                            field.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            field.focus();
                            if (field.tagName.toLowerCase() === 'select') {
                                let matched = false;
                                if (field.querySelector(`option[value="${value}"]`)) {
                                    try { field.click(); } catch (_) {}
                                    field.value = value;
                                    matched = true;
                                } else {
                                    const options = field.querySelectorAll('option');
                                    for (const option of options) {
                                        if (matchOption(option, value)) {
                                            try { field.click(); } catch (_) {}
                                            field.value = option.value;
                                            matched = true;
                                            break;
                                        }
                                    }
                                    if (!matched) {
                                        const mapped = mapEnZh(value);
                                        if (mapped && field.querySelector(`option[value="${mapped}"]`)) {
                                            try { field.click(); } catch (_) {}
                                            field.value = mapped;
                                            matched = true;
                                        } else if (mapped) {
                                            for (const option of options) {
                                                if (matchOption(option, mapped)) {
                                                    try { field.click(); } catch (_) {}
                                                    field.value = option.value;
                                                    matched = true;
                                                    break;
                                                }
                                            }
                                        }
                                    }
                                }
                                if (matched) {
                                    field.dispatchEvent(new Event('input', { bubbles: true }));
                                    field.dispatchEvent(new Event('change', { bubbles: true }));
                                    return { success: true, message: `下拉框 "${fieldName}" 选择成功: ${value}` };
                                }
                                try { field.click(); } catch (_) {}
                                const clicked = tryClickSelectOption(value);
                                if (clicked) {
                                    return { success: true, message: `下拉框 "${fieldName}" 选择成功: ${clicked.text || value}` };
                                }
                                return { success: false, message: `下拉框 "${fieldName}" 未找到匹配选项: ${value}` };
                            } else if (field.type === 'checkbox' || field.type === 'radio') {
                                const groupRow = findGroupContainer(fieldName);
                                const type = field.type;
                                if (groupRow) {
                                    const inputs = Array.from(groupRow.querySelectorAll(`input[type="${type}"]`));
                                    const targets = splitMulti(value);
                                    let hits = 0;
                                    if (type === 'radio') {
                                        let done = false;
                                        for (const t of targets) {
                                            for (const el of inputs) {
                                                const labText = getLabelText(el);
                                                if (matchLabel(labText || el.value || '', t)) {
                                                    el.checked = true;
                                                    el.dispatchEvent(new Event('click', { bubbles: true }));
                                                    el.dispatchEvent(new Event('change', { bubbles: true }));
                                                    hits = 1;
                                                    done = true;
                                                    break;
                                                }
                                            }
                                            if (done) break;
                                        }
                                    } else {
                                        for (const el of inputs) {
                                            const labText = getLabelText(el);
                                            let should = false;
                                            for (const t of targets) {
                                                if (matchLabel(labText || el.value || '', t)) {
                                                    should = true;
                                                    break;
                                                }
                                            }
                                            el.checked = should;
                                            if (should) hits++;
                                            el.dispatchEvent(new Event('change', { bubbles: true }));
                                        }
                                    }
                                    if (hits > 0) {
                                        return { success: true, message: `${type === 'radio' ? '单选' : '复选'}组 "${fieldName}" 匹配成功` };
                                    }
                                }
                                const boolOn = ['true','1','yes','on','是'].includes(String(value).toLowerCase()) || value === true;
                                field.checked = boolOn;
                                field.dispatchEvent(new Event('click', { bubbles: true }));
                                field.dispatchEvent(new Event('change', { bubbles: true }));
                                return { success: true, message: `选择框 "${fieldName}" 已${boolOn ? '勾选' : '取消勾选'}` };
                            } else {
                                field.value = String(mapEnZh(value));
                                field.dispatchEvent(new Event('input', { bubbles: true }));
                                field.dispatchEvent(new Event('change', { bubbles: true }));
                                return { success: true, message: `字段 "${fieldName}" 填写成功: ${value}` };
                            }
                        }
                        const groupRow2 = findGroupContainer(fieldName);
                        if (groupRow2) {
                            const sel = groupRow2.querySelector('select');
                            if (sel) {
                                let matched = false;
                                const options = sel.querySelectorAll('option');
                                for (const option of options) {
                                    if (matchOption(option, value)) {
                                        try { sel.click(); } catch (_) {}
                                        sel.value = option.value;
                                        matched = true;
                                        break;
                                    }
                                }
                                if (matched) {
                                    sel.dispatchEvent(new Event('input', { bubbles: true }));
                                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                                    return { success: true, message: `下拉框 "${fieldName}" 选择成功: ${value}` };
                                }
                                try { sel.click(); } catch (_) {}
                                const clicked = tryClickSelectOption(value);
                                if (clicked) {
                                    return { success: true, message: `下拉框 "${fieldName}" 选择成功: ${clicked.text || value}` };
                                }
                            }
                            const radios = groupRow2.querySelectorAll('input[type="radio"]');
                            if (radios.length) {
                                const targets = splitMulti(value);
                                for (const t of targets) {
                                    for (const el of Array.from(radios)) {
                                        const lab = getLabelText(el);
                                        if (matchLabel(lab || el.value || '', t)) {
                                            el.checked = true;
                                            el.dispatchEvent(new Event('click', { bubbles: true }));
                                            el.dispatchEvent(new Event('change', { bubbles: true }));
                                            return { success: true, message: `单选组 "${fieldName}" 匹配成功` };
                                        }
                                    }
                                }
                            }
                            const checks = groupRow2.querySelectorAll('input[type="checkbox"]');
                            if (checks.length) {
                                const targets = splitMulti(value);
                                let hits = 0;
                                for (const el of Array.from(checks)) {
                                    const lab = getLabelText(el);
                                    let should = false;
                                    for (const t of targets) {
                                        if (matchLabel(lab || el.value || '', t)) {
                                            should = true;
                                            break;
                                        }
                                    }
                                    el.checked = should;
                                    if (should) hits++;
                                    el.dispatchEvent(new Event('change', { bubbles: true }));
                                }
                                if (hits > 0) {
                                    return { success: true, message: `复选组 "${fieldName}" 匹配成功` };
                                }
                        }
                        }
                        return { success: false, message: `未找到字段 "${fieldName}"` };
                    },
                    args: [fieldName, value]
                });
                return results && results[0]?.result ? results[0].result : { success: false, message: '执行脚本未返回有效结果' };
            } else {
                const field = document.querySelector(`[name="${fieldName}"], #${fieldName}`);
                if (field) {
                    if (field.tagName.toLowerCase() === 'select') {
                        field.value = value;
                        field.dispatchEvent(new Event('change', { bubbles: true }));
                    } else if (field.type === 'checkbox' || field.type === 'radio') {
                        const shouldBeChecked = value === true || String(value).toLowerCase() === 'true' || value === '1' || String(value).toLowerCase() === 'yes' || String(value).toLowerCase() === 'on';
                        field.checked = shouldBeChecked;
                        field.dispatchEvent(new Event('change', { bubbles: true }));
                    } else {
                        field.value = value;
                        field.dispatchEvent(new Event('input', { bubbles: true }));
                        field.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    return { success: true, message: `字段 "${fieldName}" 填写成功`, fieldValue: field.value };
                }
                return { success: false, message: `未找到字段 "${fieldName}"` };
            }
        } catch (error) {
            return { success: false, message: `填写表单字段失败: ${error.message}` };
        }
    }

    async getPageElements(selector = 'form input, form select, form textarea') {
        try {
            let elements;
            if (typeof chrome !== 'undefined' && chrome.scripting) {
                let tabId = null;
                const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
                if (tabs && tabs.length > 0) {
                    tabId = tabs[0].id;
                }
                if (tabId) {
                    const results = await chrome.scripting.executeScript({
                        target: { tabId: tabId },
                        func: (sel) => {
                            const els = Array.from(document.querySelectorAll(sel));
                            return els.map(el => ({
                                tagName: el.tagName,
                                id: el.id,
                                name: el.name,
                                type: el.type,
                                placeholder: el.placeholder,
                                value: el.value,
                                required: el.required,
                                label: el.labels ? Array.from(el.labels).map(l => l.textContent).join(', ') : '',
                                xpath: document.evaluate('count(./preceding-sibling::*) + 1', el, null, XPathResult.NUMBER_TYPE, null).numberValue
                            }));
                        },
                        args: [selector]
                    });
                    elements = results && results[0]?.result ? results[0].result : [];
                } else {
                    elements = this._getPageElementsFromCurrentPage(selector);
                }
            } else {
                elements = this._getPageElementsFromCurrentPage(selector);
            }
            return { success: true, message: `找到 ${elements ? elements.length : 0} 个元素`, elements: elements || [] };
        } catch (error) {
            return { success: false, message: `获取页面元素失败: ${error.message}` };
        }
    }

    _getPageElementsFromCurrentPage(selector) {
        /**
         * 从当前页面获取元素信息（辅助方法）
         */
        const elements = Array.from(document.querySelectorAll(selector));
        return elements.map(el => ({
            tagName: el.tagName.toLowerCase(),
            id: el.id,
            name: el.name,
            type: el.type,
            placeholder: el.placeholder,
            value: el.value,
            required: el.hasAttribute('required'),
            readonly: el.hasAttribute('readonly'),
            disabled: el.hasAttribute('disabled'),
            label: this._getElementLabel(el),
            xpath: this._getElementXPath(el)
        }));
    }

    _getElementLabel(element) {
        /**
         * 获取元素的标签文本（辅助方法）
         */
        // 通过for属性查找label
        if (element.id) {
            const label = document.querySelector(`label[for="${element.id}"]`);
            if (label) {
                return label.textContent.trim();
            }
        }
        
        // 查找父级label
        let parent = element.parentElement;
        while (parent && parent.tagName.toLowerCase() !== 'form') {
            const label = parent.querySelector('label');
            if (label && label.contains(element)) {
                return label.textContent.trim();
            }
            parent = parent.parentElement;
        }
        
        return element.getAttribute('aria-label') || element.title || '';
    }

    _getElementXPath(element) {
        /**
         * 获取元素的XPath（辅助方法）
         */
        if (element.id) {
            return `//*[@id="${element.id}"]`;
        }

        const parts = [];
        while (element && element.nodeType === Node.ELEMENT_NODE) {
            let nbOfPreviousSiblings = 0;
            let hasNextSiblings = false;
            let sibling = element.previousSibling;
            while (sibling) {
                if (sibling.nodeType === Node.ELEMENT_NODE && sibling.nodeName === element.nodeName) {
                    nbOfPreviousSiblings++;
                }
                sibling = sibling.previousSibling;
            }
            sibling = element.nextSibling;
            while (sibling) {
                if (sibling.nodeType === Node.ELEMENT_NODE && sibling.nodeName === element.nodeName) {
                    hasNextSiblings = true;
                    break;
                }
                sibling = sibling.nextSibling;
            }
            const prefix = element.nodeName.toLowerCase();
            const nth = nbOfPreviousSiblings || hasNextSiblings ? `[${nbOfPreviousSiblings + 1}]` : '';
            parts.push(prefix + nth);
            element = element.parentNode;
        }
        return '/' + parts.reverse().join('/');
    }
}

export { EnhancedToolExecutor };
