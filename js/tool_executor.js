import {  searchAuthors, getPublicationByKey, getAuthorByPid } from './dblp_api.js';
import { searchConferenceLocation, searchConferenceOrganizers, searchConferenceEventDate,fetchWithRetry, APIS, normalizeDoi } from './api_client.js';
import { 
    SEMANTIC_SCHOLAR_PAPER_SCHEMA, 
    SEMANTIC_SCHOLAR_AUTHOR_SCHEMA,
    CROSSREF_WORK_SCHEMA,
    OPENALEX_WORK_SCHEMA,
    DBLP_PAPER_SCHEMA,
    DBLP_AUTHOR_SCHEMA
} from './schemas.js';

class EnhancedToolExecutor {
    //constructor() {
    //    this.tools = {};
    //    this.registerDefaultTools();
    //}

    constructor(tabId = null) {
        this.tools = {};
        this.tabId = tabId;          // 保存当前活动的标签页 ID
        this.registerDefaultTools();
    }

    // 设置标签页 ID（可在运行时更新）
    setTabId(tabId) {
        this.tabId = tabId;
    }

    registerTool(name, description, func, schema = null) {
        if (name in this.tools) {
            console.warn(`警告:工具 '${name}' 已存在，将被覆盖。`);
        }
        this.tools[name] = {
            description: description,
            func: func,
            schema: schema
        };
        console.log(`工具 '${name}' 已注册。`);
    }

    getToolsDescription() {
        let desc = '';
        for (const [name, tool] of Object.entries(this.tools)) {
            desc += `### ${name}\n`;
            desc += `描述: ${tool.description}\n`;
            if (tool.schema && tool.schema.parameters) {
                desc += `输入参数:\n`;
                const props = tool.schema.parameters.properties || {};
                const required = tool.schema.parameters.required || [];
                for (const [pName, pDef] of Object.entries(props)) {
                    const reqMark = required.includes(pName) ? '(必需)' : '(可选)';
                    desc += `- ${pName} ${reqMark}: ${pDef.type || 'any'} - ${pDef.description || ''}\n`;
                }
                // 添加提示：如何按需请求字段
                if (name === 'GetPaperDetailsSemanticScholar') {
                    desc += `- 使用示例: GetPaperDetailsSemanticScholar[{"doi": "10.xxx", "fields": ["title", "authors"]}]  // 只请求标题和作者\n`;
                } else if (name === 'GetWorkOpenAlex') {
                    desc += `- 使用示例: GetWorkOpenAlex[{"doi": "10.xxx", "select": ["title", "authorships", "publication_year"]}]  // 只请求标题、作者、年份\n`;
                } else if (name === 'GetWorkCrossRef') {
                    desc += `- 使用示例: GetWorkCrossRef[{"doi": "10.xxx", "select": ["DOI", "title", "author"]}]  // 只请求必要字段\n`;
                }
            }
            desc += `返回字段: 包含该 API 提供的所有元数据（标题、作者、年份、期刊/会议、DOI、摘要、关键词、引用数等）\n\n`;
        }
        return desc;
    }

    getTool(name) {
        /**
         * 根据名称获取一个工具的执行函数。
         */
        return this.tools[name] ? this.tools[name].func : null;
    }

    // 在 EnhancedToolExecutor 类中添加以下方法
    async _retryAsync(fn, maxRetries = 3, baseDelay = 1000) {
        let lastError;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await fn();
            } catch (error) {
                console.warn(`尝试 ${attempt}/${maxRetries} 失败: ${error.message}`);
                lastError = error;
                if (attempt === maxRetries) break;
                // 指数退避 + 随机抖动
                const delay = baseDelay * Math.pow(2, attempt - 1) + Math.random() * 500;
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        throw lastError;
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
            async (params) => this.getPaperDetails(params), DBLP_PAPER_SCHEMA
        );

        this.registerTool(
            'GetAuthorDetails',
            '通过DBLP API获取作者详情。输入：作者姓名字符串，或{"pid": "..."}。',
            async (params) => this.getAuthorDetails(params), DBLP_AUTHOR_SCHEMA
        );

        // —— 补充来源：Semantic Scholar / OpenCitations / CrossRef / OpenAlex ——
        this.registerTool(
            'GetPaperDetailsSemanticScholar', 
            '通过 Semantic Scholar 获取论文详情（关键词、摘要、引用数、PDF、年份等）。输入：标题字符串，或 { doi }。', 
            async (params) => this.getPaperDetailsSemanticScholar(params), SEMANTIC_SCHOLAR_PAPER_SCHEMA
        );
        this.registerTool(
            'GetAuthorDetailsSemanticScholar',
            '通过 Semantic Scholar 获取作者信息（别名、单位、主页、hIndex 等）。输入：作者姓名字符串，或 { authorId }。',
            async (params) => this.getAuthorDetailsSemanticScholar(params), SEMANTIC_SCHOLAR_AUTHOR_SCHEMA
        );
        this.registerTool(
            'GetCitationCount',
            '获取引用次数。优先 OpenCitations(需 token)，失败回退到 Semantic Scholar；输入：{ doi }',
            async (params) => this.getCitationCount(params)
        );
        this.registerTool(
            'GetWorkCrossRef',
            '通过 CrossRef 获取作品元数据；输入：{ doi }',
            async (params) => this.getWorkCrossRef(params), CROSSREF_WORK_SCHEMA
        );
        this.registerTool(
            'GetWorkOpenAlex',
            '通过 OpenAlex 获取作品元数据（含会议信息等）；输入：{ doi }',
            async (params) => this.getWorkOpenAlex(params), OPENALEX_WORK_SCHEMA
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
            '获取页面上的表单元素信息。可以传入 CSS 选择器，也支持通过字段名或标签文本进行智能查找。返回匹配元素的详细信息，包括 select 的所有选项、radio/checkbox 的选项列表等。特别适用于获取某个字段的可选值列表，以便进行匹配选择。例如：GetPageElements["select[name=\'成果类型\']"] 或 GetPageElements["成果类型"] 都可以尝试查找。',
            async (selector) => this.getPageElements(selector)
        );

        this.registerTool(
            'ClickElement',
            '点击指定的元素，用于添加表格行等操作。输入格式：可以是 CSS 选择器字符串，或 { selector: "...", tabId: 123 }。需要提供标签页 ID。',
            async (params, context = {}) => {
                try {
                    // 解析参数
                    let selector, tabId;
                    if (typeof params === 'string') {
                        selector = params;
                        tabId = context.tabId || this.tabId;
                    } else if (params && typeof params === 'object') {
                        selector = params.selector;
                        tabId = params.tabId || context.tabId || this.tabId;
                    }

                    if (!selector) {
                        return { success: false, message: '缺少 CSS 选择器' };
                    }
                    if (!tabId) {
                        return { success: false, message: '缺少标签页 ID，无法确定目标页面' };
                    }

                    // 发送消息到目标标签页的内容脚本
                    return new Promise((resolve) => {
                        chrome.tabs.sendMessage(
                            tabId,
                            { action: 'clickElement', data: { selector } },
                            (response) => {
                                if (chrome.runtime.lastError) {
                                    resolve({
                                        success: false,
                                        message: `与内容脚本通信失败: ${chrome.runtime.lastError.message}`
                                    });
                                } else {
                                    resolve(response || { success: true, message: '已触发点击' });
                                }
                            }
                        );
                    });
                } catch (error) {
                    return { success: false, message: `执行点击工具时出错: ${error.message}` };
                }
            }
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
            let args = params;
            if (typeof params === 'string') {
                try { args = JSON.parse(params); } catch(e) { args = { title: params }; }
            }
            // 解析字段参数，若未指定则使用默认基础字段
            let fields = args.fields;
            if (!fields) {
                fields = ['title', 'authors', 'year', 'venue', 'externalIds', 'url']; // 基础字段
            }
            const fieldsParam = Array.isArray(fields) ? fields.join(',') : fields;

            const buildRequest = () => {
                if (args.doi) {
                    return { url: `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(args.doi)}?fields=${fieldsParam}` };
                } else if (args.paperId) {
                    return { url: `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(args.paperId)}?fields=${fieldsParam}` };
                } else if (args.arxivId) {
                    return { url: `https://api.semanticscholar.org/graph/v1/paper/arXiv:${encodeURIComponent(args.arxivId)}?fields=${fieldsParam}` };
                } else if (args.title || args.query) {
                    const query = args.title || args.query;
                    const limit = args.limit || 5;
                    return { url: `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&fields=${fieldsParam}` };
                } else {
                    throw new Error('缺少有效查询参数');
                }
            };
            const { url } = buildRequest();
            const data = await this._retryAsync(() => this._safeFetchJSON(url), 3);
            return { success: true, data };
        } catch (e) {
            return { success: false, message: `Semantic Scholar 查询失败: ${e.message}` };
        }
    }

    // —— Semantic Scholar: 作者详情 —— 
    async getAuthorDetailsSemanticScholar(params) {
        try {
            // 解析参数
            let args = params;
            if (typeof params === 'string') {
                try {
                    args = JSON.parse(params);
                } catch(e) {
                    args = { name: params };
                }
            }

            // 按 authorId 获取
            if (args.authorId) {
                const fields = args.fields ? args.fields.join(',') : 'name,aliases,affiliations,homepage,hIndex,paperCount';
                const url = `https://api.semanticscholar.org/graph/v1/author/${encodeURIComponent(args.authorId)}?fields=${fields}`;
                const data = await this._safeFetchJSON(url);
                return { success: true, data };
            }
            // 按名称搜索
            else if (args.name || args.query) {
                const query = args.name || args.query;
                const limit = args.limit || 5;
                const fields = args.fields ? args.fields.join(',') : 'name,aliases,affiliations,homepage,hIndex,paperCount';
                const url = `https://api.semanticscholar.org/graph/v1/author/search?query=${encodeURIComponent(query)}&limit=${limit}&fields=${fields}`;
                const data = await this._safeFetchJSON(url);
                const best = data?.data?.[0];
                if (!best) return { success: false, message: '未找到匹配作者' };
                return { success: true, data: best, candidates: data.data };
            } else {
                return { success: false, message: '缺少有效查询参数' };
            }
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
                const data = await this._retryAsync(() => this._safeFetchJSON(url, { headers }), 3);
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
                const data = await this._retryAsync(() => this._safeFetchJSON(url), 3);
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
            let args = params;
            if (typeof params === 'string') {
                try {
                    args = JSON.parse(params);
                } catch(e) {
                    args = { doi: params };
                }
            }
            // 默认 select 基础字段
            let select = args.select;
            if (!select) {
                select = ['DOI', 'title', 'author', 'container-title', 'issued', 'page'];
            }
            const selectParam = Array.isArray(select) ? select.join(',') : select;

            if (args.doi) {
                const url = `https://api.crossref.org/works/${encodeURIComponent(args.doi)}?select=${selectParam}`;
                const data = await this._retryAsync(() => this._safeFetchJSON(url), 3);
                return { success: true, data: data.message };
            } else if (args.query) {
                let url = `https://api.crossref.org/works?query=${encodeURIComponent(args.query)}&select=${selectParam}`;
                if (args.rows) url += `&rows=${args.rows}`;
                if (args.offset) url += `&offset=${args.offset}`;
                if (args.sort) url += `&sort=${args.sort}`;
                if (args.order) url += `&order=${args.order}`;
                if (args.filter) {
                    const filterStr = Object.entries(args.filter)
                        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
                        .join(',');
                    if (filterStr) url += `&filter=${filterStr}`;
                }
                const data = await this._retryAsync(() => this._safeFetchJSON(url), 3);
                return { success: true, data: data.message };
            } else {
                return { success: false, message: '缺少有效查询参数' };
            }
        } catch (e) {
            return { success: false, message: `CrossRef 查询失败: ${e.message}` };
        }
    }

    // —— OpenAlex: 作品元数据 —— 
    async getWorkOpenAlex(params) {
        try {
            let args = params;
            if (typeof params === 'string') {
                try {
                    args = JSON.parse(params);
                } catch(e) {
                    args = { doi: params };
                }
            }
            let select = args.select || args.fields;
            if (!select) {
                select = ['title', 'authorships', 'publication_year', 'doi', 'id', 'primary_location'];
            }
            const selectParam = Array.isArray(select) ? select.join(',') : select;

            if (args.doi) {
                const url = `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(args.doi)}?select=${selectParam}`;
                const data = await this._retryAsync(() => this._safeFetchJSON(url), 3);
                return { success: true, data };
            } else if (args.openalex_id) {
                const url = `https://api.openalex.org/works/${encodeURIComponent(args.openalex_id)}?select=${selectParam}`;
                const data = await this._retryAsync(() => this._safeFetchJSON(url), 3);
                return { success: true, data };
            } else if (args.title || args.query) {
                let url = `https://api.openalex.org/works?search=${encodeURIComponent(args.title || args.query)}&select=${selectParam}`;
                if (args.filter) url += `&filter=${encodeURIComponent(args.filter)}`;
                if (args['per-page']) url += `&per-page=${args['per-page']}`;
                if (args.page) url += `&page=${args.page}`;
                if (args.sort) url += `&sort=${encodeURIComponent(args.sort)}`;
                const data = await this._retryAsync(() => this._safeFetchJSON(url), 3);
                const best = data?.results?.[0];
                if (!best) return { success: false, message: '未找到匹配作品' };
                return { success: true, data: best, candidates: data.results };
            } else {
                return { success: false, message: '缺少有效查询参数' };
            }
        } catch (e) {
            return { success: false, message: `OpenAlex 查询失败: ${e.message}` };
        }
    }

    async getPaperDetails(params) {
        try {
            let args = params;
            if (typeof params === 'string') {
                try {
                    args = JSON.parse(params);
                } catch(e) {
                    args = { title: params };
                }
            }

            // 按 key 获取单篇
            if (args.key) {
                const detail = await getPublicationByKey(args.key);
                return { success: true, data: detail };
            }
            // 按标题/作者/年份等组合搜索
            else if (args.title || args.query) {
                let query = args.title || args.query;
                if (args.author) query += ` author:"${args.author}"`;
                if (args.venue) query += ` venue:"${args.venue}"`;
                if (args.year) query += ` year:${args.year}`;
                const h = args.h || args.limit || 10;
                const f = args.f || args.offset || 0;
                const url = `${APIS.DBLP.SEARCH_PUBL}?q=${encodeURIComponent(query)}&h=${h}&f=${f}&format=json`;
                const data = await fetchWithRetry(url, 'DBLP');
                const hits = data.result?.hits?.hit || [];
                if (!hits.length) return { success: false, message: '未找到匹配论文' };
                const hit = hits[0];
                const info = hit.info;
                const authors = info.authors?.author ? (Array.isArray(info.authors.author) ? info.authors.author.map(a => a.text || a) : [info.authors.author.text || info.authors.author]) : [];
                const paper = {
                    title: info.title,
                    authors,
                    venue: info.venue,
                    year: info.year,
                    type: info.type,
                    key: info.key,
                    doi: info.doi,
                    url: info.url,
                    ee: info.ee
                };
                if (paper.key) {
                    const detail = await getPublicationByKey(paper.key);
                    Object.assign(paper, detail);
                }
                return { success: true, data: paper, candidates: hits.slice(0, 5).map(h => h.info) };
            } else {
                return { success: false, message: '缺少有效查询参数' };
            }
        } catch (e) {
            return { success: false, message: `获取论文信息失败: ${e.message}` };
        }
    }

    async getAuthorDetails(params) {
        try {
            let args = params;
            if (typeof params === 'string') {
                try {
                    args = JSON.parse(params);
                } catch(e) {
                    args = { name: params };
                }
            }

            if (args.pid) {
                const detail = await getAuthorByPid(args.pid);
                return { success: true, data: detail };
            } else if (args.name) {
                const list = await searchAuthors(args.name);
                if (!list || list.length === 0) return { success: false, message: '未找到匹配作者' };
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
            } else {
                return { success: false, message: '缺少有效查询参数' };
            }
        } catch (e) {
            return { success: false, message: `获取作者信息失败: ${e.message}` };
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
                            // ========== 增强查找函数 ==========
                            const findElementByLabel = (labelText) => {
                                // 1. 通过 .field-row 结构查找
                                const rows = Array.from(document.querySelectorAll('.field-row'));
                                for (const row of rows) {
                                    const labelDiv = row.querySelector('.field-label');
                                    if (labelDiv) {
                                        const rawLabel = labelDiv.textContent.trim().replace(/\*/g, '').trim();
                                        if (rawLabel.includes(labelText) || labelText.includes(rawLabel)) {
                                            const select = row.querySelector('select');
                                            if (select) return select;
                                            const input = row.querySelector('input:not([type="hidden"])');
                                            if (input) return input;
                                            const textarea = row.querySelector('textarea');
                                            if (textarea) return textarea;
                                        }
                                    }
                                }
                                // 2. 通过 label 标签查找
                                const labels = Array.from(document.querySelectorAll('label'));
                                for (const label of labels) {
                                    const rawLabel = label.textContent.trim().replace(/\*/g, '').trim();
                                    if (rawLabel.includes(labelText) || labelText.includes(rawLabel)) {
                                        const id = label.htmlFor;
                                        if (id) {
                                            const el = document.getElementById(id);
                                            if (el) return el;
                                        }
                                        const input = label.querySelector('select, input, textarea');
                                        if (input) return input;
                                    }
                                }
                                return null;
                            };

                            // 解析选择器，提取可能的标签文本或 name 值
                            let targetLabel = '';
                            let targetName = '';
                            // 1. 如果选择器是纯文本（不含 CSS 特殊字符），视为标签文本
                            if (/^[a-zA-Z\u4e00-\u9fa5\s]+$/.test(sel)) {
                                targetLabel = sel.trim();
                            } else {
                                // 2. 尝试提取 name 属性值
                                const nameMatch = sel.match(/name=['"]([^'"]+)['"]/);
                                if (nameMatch) {
                                    targetName = nameMatch[1];
                                } else {
                                    // 3. 去除 CSS 符号，保留中英文作为标签候选
                                    const plain = sel.replace(/[^a-zA-Z\u4e00-\u9fa5]/g, '');
                                    if (plain) targetLabel = plain;
                                }
                            }

                            let elements = [];

                            // 1. 直接使用原始选择器查找
                            try {
                                elements = Array.from(document.querySelectorAll(sel));
                            } catch(e) {}

                            // 2. 如果未找到且选择器看起来像 name 属性，直接按 name 查找
                            if (elements.length === 0 && targetName) {
                                const byName = document.querySelector(`[name="${targetName}"]`);
                                if (byName) elements = [byName];
                            }

                            // 3. 如果仍未找到，尝试通过标签文本查找
                            if (elements.length === 0 && targetLabel) {
                                const found = findElementByLabel(targetLabel);
                                if (found) elements = [found];
                            }

                            // 4. 兜底：如果是通用选择器，返回所有可见表单元素
                            if (elements.length === 0 && (sel === 'form input, form select, form textarea' || sel === 'input, select, textarea')) {
                                elements = Array.from(document.querySelectorAll('input:not([type="hidden"]), select, textarea'));
                            }

                            // 5. 最后尝试通过属性选择器模糊匹配
                            if (elements.length === 0 && targetLabel) {
                                const attrSelectors = [
                                    `[placeholder*="${targetLabel}"]`,
                                    `[aria-label*="${targetLabel}"]`,
                                    `[title*="${targetLabel}"]`
                                ];
                                for (const attrSel of attrSelectors) {
                                    const attrEls = Array.from(document.querySelectorAll(attrSel));
                                    if (attrEls.length) {
                                        elements = attrEls;
                                        break;
                                    }
                                }
                            }

                            // 转换为详细格式
                            return elements.map(el => {
                                const base = {
                                    tagName: el.tagName.toLowerCase(),
                                    id: el.id,
                                    name: el.name,
                                    type: el.type,
                                    placeholder: el.placeholder,
                                    value: el.value,
                                    required: el.required,
                                    label: (() => {
                                        if (el.id) {
                                            const label = document.querySelector(`label[for="${el.id}"]`);
                                            if (label) return label.textContent.trim();
                                        }
                                        const parent = el.closest('.field-row');
                                        if (parent) {
                                            const labelDiv = parent.querySelector('.field-label');
                                            if (labelDiv) return labelDiv.textContent.trim();
                                        }
                                        return el.getAttribute('aria-label') || '';
                                    })(),
                                    xpath: (() => {
                                        try {
                                            let path = [];
                                            let node = el;
                                            while (node && node.nodeType === Node.ELEMENT_NODE) {
                                                let index = 0;
                                                let sibling = node.previousSibling;
                                                while (sibling) {
                                                    if (sibling.nodeType === Node.ELEMENT_NODE && sibling.nodeName === node.nodeName) {
                                                        index++;
                                                    }
                                                    sibling = sibling.previousSibling;
                                                }
                                                const tag = node.nodeName.toLowerCase();
                                                const nth = index > 0 ? `[${index + 1}]` : '';
                                                path.unshift(tag + nth);
                                                node = node.parentNode;
                                            }
                                            return '/' + path.join('/');
                                        } catch(e) { return ''; }
                                    })()
                                };
                                if (el.tagName.toLowerCase() === 'select') {
                                    base.options = Array.from(el.options).map(opt => ({
                                        value: opt.value,
                                        text: opt.textContent.trim(),
                                        selected: opt.selected
                                    }));
                                } else if (el.type === 'radio' || el.type === 'checkbox') {
                                    base.options = [{
                                        value: el.value,
                                        text: el.getAttribute('aria-label') || (el.nextSibling && el.nextSibling.textContent) || '',
                                        checked: el.checked
                                    }];
                                }
                                return base;
                            });
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
        // 复用相同的查找逻辑（与注入脚本中的函数类似）
        const findElementByLabel = (labelText) => {
            const rows = Array.from(document.querySelectorAll('.field-row'));
            for (const row of rows) {
                const labelDiv = row.querySelector('.field-label');
                if (labelDiv) {
                    const rawLabel = labelDiv.textContent.trim().replace(/\*/g, '').trim();
                    if (rawLabel.includes(labelText) || labelText.includes(rawLabel)) {
                        const select = row.querySelector('select');
                        if (select) return select;
                        const input = row.querySelector('input:not([type="hidden"])');
                        if (input) return input;
                        const textarea = row.querySelector('textarea');
                        if (textarea) return textarea;
                    }
                }
            }
            const labels = Array.from(document.querySelectorAll('label'));
            for (const label of labels) {
                const rawLabel = label.textContent.trim().replace(/\*/g, '').trim();
                if (rawLabel.includes(labelText) || labelText.includes(rawLabel)) {
                    const id = label.htmlFor;
                    if (id) {
                        const el = document.getElementById(id);
                        if (el) return el;
                    }
                    const input = label.querySelector('select, input, textarea');
                    if (input) return input;
                }
            }
            return null;
        };

        let targetLabel = '';
        let targetName = '';
        if (/^[a-zA-Z\u4e00-\u9fa5\s]+$/.test(selector)) {
            targetLabel = selector.trim();
        } else {
            const nameMatch = selector.match(/name=['"]([^'"]+)['"]/);
            if (nameMatch) targetName = nameMatch[1];
            else {
                const plain = selector.replace(/[^a-zA-Z\u4e00-\u9fa5]/g, '');
                if (plain) targetLabel = plain;
            }
        }

        let elements = [];
        try {
            elements = Array.from(document.querySelectorAll(selector));
        } catch(e) {}

        if (elements.length === 0 && targetName) {
            const byName = document.querySelector(`[name="${targetName}"]`);
            if (byName) elements = [byName];
        }

        if (elements.length === 0 && targetLabel) {
            const found = findElementByLabel(targetLabel);
            if (found) elements = [found];
        }

        if (elements.length === 0 && (selector === 'form input, form select, form textarea' || selector === 'input, select, textarea')) {
            elements = Array.from(document.querySelectorAll('input:not([type="hidden"]), select, textarea'));
        }

        if (elements.length === 0 && targetLabel) {
            const attrSelectors = [
                `[placeholder*="${targetLabel}"]`,
                `[aria-label*="${targetLabel}"]`,
                `[title*="${targetLabel}"]`
            ];
            for (const attrSel of attrSelectors) {
                const attrEls = Array.from(document.querySelectorAll(attrSel));
                if (attrEls.length) {
                    elements = attrEls;
                    break;
                }
            }
        }

        return elements.map(el => {
            const base = {
                tagName: el.tagName.toLowerCase(),
                id: el.id,
                name: el.name,
                type: el.type,
                placeholder: el.placeholder,
                value: el.value,
                required: el.required,
                label: (() => {
                    if (el.id) {
                        const label = document.querySelector(`label[for="${el.id}"]`);
                        if (label) return label.textContent.trim();
                    }
                    const parent = el.closest('.field-row');
                    if (parent) {
                        const labelDiv = parent.querySelector('.field-label');
                        if (labelDiv) return labelDiv.textContent.trim();
                    }
                    return el.getAttribute('aria-label') || '';
                })(),
                xpath: (() => {
                    try {
                        let path = [];
                        let node = el;
                        while (node && node.nodeType === Node.ELEMENT_NODE) {
                            let index = 0;
                            let sibling = node.previousSibling;
                            while (sibling) {
                                if (sibling.nodeType === Node.ELEMENT_NODE && sibling.nodeName === node.nodeName) {
                                    index++;
                                }
                                sibling = sibling.previousSibling;
                            }
                            const tag = node.nodeName.toLowerCase();
                            const nth = index > 0 ? `[${index + 1}]` : '';
                            path.unshift(tag + nth);
                            node = node.parentNode;
                        }
                        return '/' + path.join('/');
                    } catch(e) { return ''; }
                })()
            };
            if (el.tagName.toLowerCase() === 'select') {
                base.options = Array.from(el.options).map(opt => ({
                    value: opt.value,
                    text: opt.textContent.trim(),
                    selected: opt.selected
                }));
            } else if (el.type === 'radio' || el.type === 'checkbox') {
                base.options = [{
                    value: el.value,
                    text: el.getAttribute('aria-label') || (el.nextSibling && el.nextSibling.textContent) || '',
                    checked: el.checked
                }];
            }
            return base;
        });
    }
    
}

export { EnhancedToolExecutor };
