// api_client.js
// 统一的学术 API 客户端，管理多数据源 (DBLP, Semantic Scholar, Crossref, OpenAlex)

// API 基础配置
export const APIS = {
    DBLP: {
        SEARCH_PUBL: 'https://dblp.org/search/publ/api',
        SEARCH_AUTHOR: 'https://dblp.org/search/author/api',
        PID_BASE: 'https://dblp.org/pid/',
        MIN_INTERVAL: 2000, // 2秒间隔
        PRIORITY: 1
    },
    SEMANTIC_SCHOLAR: {
        SEARCH: 'https://api.semanticscholar.org/graph/v1/paper/search',
        AUTHOR_SEARCH: 'https://api.semanticscholar.org/graph/v1/author/search',
        MIN_INTERVAL: 2000, // 更保守，降低 429 概率（尤其带 key 时通常 1 RPS）
        PRIORITY: 2
    },
    CROSSREF: {
        WORKS: 'https://api.crossref.org/works',
        MIN_INTERVAL: 1000,
        PRIORITY: 3
    },
    OPENALEX: {
        WORKS: 'https://api.openalex.org/works',
        AUTHORS: 'https://api.openalex.org/authors',
        MIN_INTERVAL: 100, // OpenAlex 很宽松
        PRIORITY: 4
    },
    WIKIDATA: {
        SPARQL: 'https://query.wikidata.org/sparql',
        MIN_INTERVAL: 1000,
        PRIORITY: 5
    }
};

// 简单的延迟函数
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const clampInt = (n, min, max, fallback) => {
    const x = parseInt(n, 10);
    if (!Number.isFinite(x)) return fallback;
    return Math.min(max, Math.max(min, x));
};

const responseCache = new Map(); // url -> { ts, data }
const CACHE_TTL_MS = 5 * 60 * 1000;

const sourceBackoffUntil = {
    DBLP: 0,
    SEMANTIC_SCHOLAR: 0,
    CROSSREF: 0,
    OPENALEX: 0,
    WIKIDATA: 0
};

const isInBackoff = (source) => Date.now() < (sourceBackoffUntil[source] || 0);

const setBackoff = (source, ms) => {
    const until = Date.now() + ms;
    if (!sourceBackoffUntil[source] || until > sourceBackoffUntil[source]) {
        sourceBackoffUntil[source] = until;
    }
};

export const normalizeDoi = (doi) => {
    if (!doi) return '';
    const d = String(doi).trim();
    return d.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim();
};

const openAlexInvertedIndexToText = (idx) => {
    if (!idx || typeof idx !== 'object') return '';
    const positions = [];
    for (const [token, arr] of Object.entries(idx)) {
        if (!Array.isArray(arr)) continue;
        for (const pos of arr) positions.push([pos, token]);
    }
    positions.sort((a, b) => a[0] - b[0]);
    return positions.map(([, t]) => t).join(' ').replace(/\s+/g, ' ').trim();
};

const normalizeKeywords = (value) => {
    if (!value) return [];
    const arr = Array.isArray(value) ? value : [value];
    const out = [];
    for (const v of arr) {
        if (v == null) continue;
        if (typeof v === 'string') {
            const parts = v.split(/[;,，；\n\t]+/).map(s => s.trim()).filter(Boolean);
            out.push(...parts);
        } else if (typeof v === 'object') {
            const name = v.name || v.category || v.display_name || v.value;
            if (name) out.push(String(name).trim());
        } else {
            out.push(String(v).trim());
        }
    }
    return Array.from(new Set(out)).filter(Boolean);
};

const extractSemanticScholarKeywords = (item) => {
    const kws = [];
    if (!item || typeof item !== 'object') return [];
    if (item.keywords) kws.push(...normalizeKeywords(item.keywords));
    if (item.fieldsOfStudy) kws.push(...normalizeKeywords(item.fieldsOfStudy));
    if (item.s2FieldsOfStudy) kws.push(...normalizeKeywords(item.s2FieldsOfStudy));
    if (item.topics) kws.push(...normalizeKeywords(item.topics));
    return Array.from(new Set(kws)).filter(Boolean);
};

const normalizeConferenceNameAndYear = (conferenceName, year) => {
    const raw = String(conferenceName || '').trim();
    const yearStr = year != null && String(year).trim() ? String(year).trim() : '';
    const yearFromArg = /^(19|20)\d{2}$/.test(yearStr) ? yearStr : '';
    const m = raw.match(/\b(19|20)\d{2}\b/);
    const yearFromName = m ? m[0] : '';
    const y = yearFromArg || yearFromName;
    let name = raw.replace(/\b(19|20)\d{2}\b/g, ' ');
    name = name.replace(/[()（）\[\]【】{}.,:;'"“”‘’`~!@#$%^&*+=<>?/\\|_-]+/g, ' ');
    name = name.replace(/\s+/g, ' ').trim();
    return { name, year: y ? parseInt(y, 10) : null, raw };
};

const normalizeConferenceCacheKey = (name, year) => {
    const n = String(name || '').toLowerCase().replace(/[()（）\[\]【】{}.,:;'"“”‘’`~!@#$%^&*+=<>?/\\|_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    const y = year != null ? String(year).trim() : '';
    return `${n}__${y}`;
};

const normalizePersonName = (p) => {
    if (!p) return '';
    if (typeof p === 'string') return p.trim();
    const given = p.given ? String(p.given).trim() : '';
    const family = p.family ? String(p.family).trim() : '';
    const name = `${given} ${family}`.trim();
    return name || '';
};

const extractCrossrefArticleNumber = (item) => {
    if (!item || typeof item !== 'object') return '';
    let v = item['article-number'] || item.article_number || '';
    if (!v && item.page) {
        const p = String(item.page || '').trim();
        if (p && !p.includes('-') && p.length <= 32) v = p;
    }
    return v ? String(v).trim() : '';
};

const extractOpenAlexArticleNumber = (item) => {
    if (!item || typeof item !== 'object') return '';
    const b = item.biblio || {};
    const a = b.article_number ? String(b.article_number).trim() : '';
    if (a) return a;
    const fp = b.first_page ? String(b.first_page).trim() : '';
    const lp = b.last_page ? String(b.last_page).trim() : '';
    if (fp && !lp && !fp.includes('-') && fp.length <= 32) return fp;
    return '';
};

const parsePageRange = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return { firstPage: '', lastPage: '', pageRange: '' };
    const cleaned = raw.replace(/\s+/g, '');
    const m = cleaned.match(/^([A-Za-z]?\d+)(?:[-–—]([A-Za-z]?\d+))?$/);
    if (!m) return { firstPage: '', lastPage: '', pageRange: raw };
    const firstPage = m[1] || '';
    const lastPage = m[2] || '';
    const pageRange = lastPage ? `${firstPage}-${lastPage}` : firstPage;
    return { firstPage, lastPage, pageRange };
};

const extractCrossrefPages = (item) => {
    const p = item && typeof item === 'object' ? item.page : '';
    return parsePageRange(p);
};

const extractOpenAlexPages = (item) => {
    const b = item && typeof item === 'object' ? (item.biblio || {}) : {};
    const fp = b.first_page ? String(b.first_page).trim() : '';
    const lp = b.last_page ? String(b.last_page).trim() : '';
    if (!fp && !lp) return { firstPage: '', lastPage: '', pageRange: '' };
    if (fp && lp) return { firstPage: fp, lastPage: lp, pageRange: `${fp}-${lp}` };
    return parsePageRange(fp || lp);
};

const parseIsoDateParts = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return { publicationDate: '', publicationYear: '', publicationMonth: '', publicationDay: '' };
    const m = raw.match(/^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?/);
    if (!m) return { publicationDate: raw, publicationYear: '', publicationMonth: '', publicationDay: '' };
    const y = m[1] || '';
    const mm = m[2] ? String(m[2]).padStart(2, '0') : '';
    const dd = m[3] ? String(m[3]).padStart(2, '0') : '';
    const publicationDate = [y, mm, dd].filter(Boolean).join('-');
    return { publicationDate, publicationYear: y, publicationMonth: mm, publicationDay: dd };
};

const parseCrossrefDateParts = (parts) => {
    if (!Array.isArray(parts) || parts.length < 1) return { publicationDate: '', publicationYear: '', publicationMonth: '', publicationDay: '' };
    const y = parts[0] != null ? String(parts[0]).trim() : '';
    const mm = parts[1] != null ? String(parts[1]).trim().padStart(2, '0') : '';
    const dd = parts[2] != null ? String(parts[2]).trim().padStart(2, '0') : '';
    const publicationDate = [y, mm, dd].filter(Boolean).join('-');
    return { publicationDate, publicationYear: y, publicationMonth: mm, publicationDay: dd };
};

const extractCrossrefPublicationParts = (item) => {
    if (!item || typeof item !== 'object') return { publicationDate: '', publicationYear: '', publicationMonth: '', publicationDay: '' };
    const candidates = [
        item['published-online']?.['date-parts']?.[0],
        item['published-print']?.['date-parts']?.[0],
        item.issued?.['date-parts']?.[0],
        item.created?.['date-parts']?.[0]
    ].filter(Boolean);
    for (const p of candidates) {
        const out = parseCrossrefDateParts(p);
        if (out.publicationYear) return out;
    }
    return { publicationDate: '', publicationYear: '', publicationMonth: '', publicationDay: '' };
};

const extractOpenAlexPublicationParts = (item) => {
    if (!item || typeof item !== 'object') return { publicationDate: '', publicationYear: '', publicationMonth: '', publicationDay: '' };
    const pub = item.publication_date ? String(item.publication_date).trim() : '';
    if (pub) return parseIsoDateParts(pub);
    const y = item.publication_year != null ? String(item.publication_year).trim() : '';
    if (y) return { publicationDate: y, publicationYear: y, publicationMonth: '', publicationDay: '' };
    return { publicationDate: '', publicationYear: '', publicationMonth: '', publicationDay: '' };
};

const normalizeLanguageCode = (value) => {
    if (!value) return '';
    const v = String(value).trim().toLowerCase();
    if (!v) return '';
    if (v.length === 2) return v;
    if (v.includes('-')) return v.split('-')[0];
    return v;
};

const extractCrossrefEventDateParts = (event) => {
    if (!event || typeof event !== 'object') {
        return {
            conferenceStartDate: '',
            conferenceStartYear: '',
            conferenceStartMonth: '',
            conferenceStartDay: '',
            conferenceEndDate: '',
            conferenceEndYear: '',
            conferenceEndMonth: '',
            conferenceEndDay: '',
            conferenceEventDate: ''
        };
    }

    const toParts = (v) => {
        if (!v) return { publicationDate: '', publicationYear: '', publicationMonth: '', publicationDay: '' };
        if (typeof v === 'string') return parseIsoDateParts(v);
        const parts = v?.['date-parts']?.[0] || v?.date_parts?.[0] || v?.['dateParts']?.[0] || null;
        if (Array.isArray(parts)) return parseCrossrefDateParts(parts);
        if (Array.isArray(v) && v.length) return parseCrossrefDateParts(v);
        return { publicationDate: '', publicationYear: '', publicationMonth: '', publicationDay: '' };
    };

    const start = toParts(event.start);
    const end = toParts(event.end);

    const conferenceEventDate = (() => {
        if (start.publicationDate && end.publicationDate) {
            if (start.publicationDate === end.publicationDate) return start.publicationDate;
            return `${start.publicationDate}~${end.publicationDate}`;
        }
        return start.publicationDate || end.publicationDate || '';
    })();

    return {
        conferenceStartDate: start.publicationDate || '',
        conferenceStartYear: start.publicationYear || '',
        conferenceStartMonth: start.publicationMonth || '',
        conferenceStartDay: start.publicationDay || '',
        conferenceEndDate: end.publicationDate || '',
        conferenceEndYear: end.publicationYear || '',
        conferenceEndMonth: end.publicationMonth || '',
        conferenceEndDay: end.publicationDay || '',
        conferenceEventDate
    };
};

const filterOrganizerNames = (arr) => {
    const out = [];
    const badWord = /(conference|proceedings|ccf|symposium|workshop|journal)/i;
    for (const raw of (arr || [])) {
        const s = String(raw || '').trim();
        if (!s) continue;
        if (/\b(19|20)\d{2}\b/.test(s)) continue;
        if (badWord.test(s)) continue;
        // 要么是包含空格的西文姓名，要么是中文名（2-6个汉字）
        const looksLikeCn = /^[\u4e00-\u9fa5]{2,6}$/.test(s);
        const looksLikeEn = /[A-Za-z]+ [A-Za-z]+/.test(s);
        if (!(looksLikeCn || looksLikeEn)) continue;
        out.push(s);
    }
    return Array.from(new Set(out));
};

// 全局请求时间戳记录
const requestTimestamps = {
    DBLP: 0,
    SEMANTIC_SCHOLAR: 0,
    CROSSREF: 0,
    OPENALEX: 0,
    WIKIDATA: 0
};

// 通用 Fetch 包装器（带频率限制和重试）
export async function fetchWithRetry(url, source, retries = 3, initialDelay = 1000) {
    let lastError;
    const config = APIS[source];
    
    for (let i = 0; i < retries; i++) {
        try {
            const cached = responseCache.get(url);
            if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
                return cached.data;
            }

            const backoffUntil = sourceBackoffUntil[source] || 0;
            if (backoffUntil && Date.now() < backoffUntil) {
                await delay(backoffUntil - Date.now());
            }

            // 1. 频率限制
            const now = Date.now();
            const timeSinceLast = now - requestTimestamps[source];
            if (timeSinceLast < config.MIN_INTERVAL) {
                await delay(config.MIN_INTERVAL - timeSinceLast);
            }
            
            // 2. 指数退避
            if (i > 0) {
                const backoffDelay = initialDelay * Math.pow(2, i - 1) + Math.random() * 500;
                await delay(backoffDelay);
            }
            
            requestTimestamps[source] = Date.now();
            
            const headers = {};
            if (source === 'SEMANTIC_SCHOLAR') {
                const s2Key = (typeof localStorage !== 'undefined' && localStorage.getItem) ? (localStorage.getItem('semanticscholar_api_key') || '') : '';
                if (s2Key) headers['x-api-key'] = s2Key;
            }
            const response = await fetch(url, { headers });
            
            if (!response.ok) {
                const status = response.status;
                if (status === 429 || status === 503) {
                    const retryAfterRaw = response.headers.get('Retry-After');
                    const retryAfterSec = retryAfterRaw ? parseInt(retryAfterRaw, 10) : NaN;
                    const retryAfterMs = Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : 0;
                    const backoffMs = Math.max(
                        retryAfterMs,
                        initialDelay * Math.pow(2, i) + Math.floor(Math.random() * 500),
                        source === 'SEMANTIC_SCHOLAR' ? 5000 : 2000
                    );
                    setBackoff(source, backoffMs);
                    const hint = source === 'SEMANTIC_SCHOLAR'
                        ? '请求过于频繁(429/503)。已自动退避重试；若仍频繁出现，建议降低调用频率或配置 Semantic Scholar API Key。'
                        : '请求过于频繁(429/503)。已自动退避重试。';
                    throw new Error(`HTTP ${status}: ${hint}`);
                }
                throw new Error(`HTTP ${status}: ${response.statusText}`);
            }
            
            const text = await response.text();
            
            // DBLP 特殊处理：检查 XML/HTML
            if (source === 'DBLP') {
                const trimmed = text.trim();
                if (trimmed.toLowerCase().startsWith('<!doctype') || trimmed.toLowerCase().startsWith('<html')) {
                    throw new Error('返回了 HTML 错误页面');
                }
                if (trimmed.startsWith('callback')) {
                    const jsonText = trimmed.replace(/^\w+\(/, '').replace(/\)$/, '');
                    return JSON.parse(jsonText);
                }
                if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                    const parsed = JSON.parse(trimmed);
                    responseCache.set(url, { ts: Date.now(), data: parsed });
                    return parsed;
                }
                responseCache.set(url, { ts: Date.now(), data: trimmed });
                return trimmed; // XML content
            }
            
            try {
                const parsed = JSON.parse(text);
                responseCache.set(url, { ts: Date.now(), data: parsed });
                return parsed;
            } catch (e) {
                const snippet = text ? text.slice(0, 200) : '';
                throw new Error(`JSON 解析失败: ${snippet}`);
            }
            
        } catch (e) {
            console.warn(`${source} API 失败 (尝试 ${i + 1}/${retries}):`, e.message);
            lastError = e;
        }
    }
    throw lastError;
}

// ====== DBLP 实现 ======

async function searchDBLPAuthor(query) {
    const url = `${APIS.DBLP.SEARCH_AUTHOR}?q=${encodeURIComponent(query)}&format=json`;
    const data = await fetchWithRetry(url, 'DBLP');
    
    // 如果 DBLP 返回了 XML 字符串（非 JSON），尝试解析 XML
    if (typeof data === 'string') {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(data, "text/xml");
        
        if (xmlDoc.querySelector('parsererror')) {
            console.error('DBLP XML 解析失败');
            return { total: 0, items: [] };
        }
        
        // 提取 hits 数量
        const total = parseInt(xmlDoc.querySelector('hits')?.getAttribute('total') || 0);
        
        // 提取 hit 元素
        const hits = Array.from(xmlDoc.querySelectorAll('hit')).map(hit => {
            const authorEl = hit.querySelector('author');
            const urlEl = hit.querySelector('url');
            
            if (!authorEl) return null;
            
            const name = authorEl.textContent;
            const url = urlEl?.textContent || '';
            const pid = url.match(/\/pid\/(.+?)\.html$/)?.[1] || '';
            
            return {
                name: name,
                id: pid,
                source: 'DBLP',
                url: url,
                aliases: [] // XML 不一定包含别名，或者结构复杂，这里简化
            };
        }).filter(Boolean);
        
        return { total, items: hits };
    }
    
    // JSON 路径处理
    let hits = data.result?.hits?.hit;
    if (!hits) hits = [];
    if (!Array.isArray(hits)) hits = [hits];
    
    return {
        total: parseInt(data.result?.hits?.['@total'] || hits.length),
        items: hits.map(hit => {
            const info = hit.info;
            let pid = info.url?.match(/\/pid\/(.+?)\.html$/)?.[1] || info.key;
            return {
                name: info.author,
                id: pid,
                source: 'DBLP',
                url: info.url,
                aliases: info.aliases?.alias ? (Array.isArray(info.aliases.alias) ? info.aliases.alias : [info.aliases.alias]) : []
            };
        })
    };
}

async function getDBLPAuthorPublications(pid, offset, limit) {
    const url = `${APIS.DBLP.PID_BASE}${pid}.xml`;
    const xmlText = await fetchWithRetry(url, 'DBLP');
    
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, "text/xml");
    
    if (xmlDoc.querySelector('parsererror')) throw new Error('XML 解析错误');

    const records = Array.from(xmlDoc.querySelectorAll('dblpperson > r'));
    const total = records.length;
    const pagedRecords = records.slice(offset, offset + limit);
    
    const items = pagedRecords.map(record => {
        const pub = record.firstElementChild;
        if (!pub) return null;
        
        const title = pub.querySelector('title')?.textContent || '';
        const year = pub.querySelector('year')?.textContent || '';
        const venue = pub.querySelector('journal')?.textContent || pub.querySelector('booktitle')?.textContent || '';
        const url = pub.querySelector('ee')?.textContent || pub.querySelector('url')?.textContent || '';
        const doi = pub.querySelector('ee')?.textContent?.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i)?.[0] || '';
        const authors = Array.from(pub.querySelectorAll('author')).map(el => el.textContent);
        
        return {
            title, authors, venue, year, doi, url,
            type: pub.tagName,
            key: pub.getAttribute('key'),
            source: 'DBLP',
            keywords: []
        };
    }).filter(Boolean);

    return { total, items, source: 'DBLP' };
}

// ====== Semantic Scholar 实现 ======

async function searchSemanticScholarAuthor(query) {
    const url = `${APIS.SEMANTIC_SCHOLAR.AUTHOR_SEARCH}?query=${encodeURIComponent(query)}&limit=10&fields=name,paperCount,citationCount,url,affiliations`;
    const data = await fetchWithRetry(url, 'SEMANTIC_SCHOLAR');
    
    return {
        total: data.total || data.data?.length || 0,
        items: (data.data || []).map(item => ({
            name: item.name,
            id: item.authorId,
            source: 'Semantic Scholar',
            url: item.url,
            meta: `论文数: ${item.paperCount}, 引用: ${item.citationCount}`,
            affiliation: Array.isArray(item.affiliations) ? item.affiliations.join(', ') : (item.affiliations || '')
        }))
    };
}

async function getSemanticScholarPublications(authorId, offset, limit) {
    // S2 不直接支持 get papers by author ID with pagination in strict sense for public API easily without graph traversal
    // 但可以用 search 接口 filter by authorId? 不行，search 接口是 keyword search
    // 正确做法是 /graph/v1/author/{authorId}/papers
    const fields = 'title,authors,year,venue,externalIds,url,abstract,citationCount,publicationDate,isOpenAccess,openAccessPdf,fieldsOfStudy,s2FieldsOfStudy';
    const safeLimit = clampInt(limit, 1, 1000, 100);
    const safeOffset = clampInt(offset, 0, 1000000, 0);
    const url = `https://api.semanticscholar.org/graph/v1/author/${authorId}/papers?offset=${safeOffset}&limit=${safeLimit}&fields=${fields}`;
    
    const data = await fetchWithRetry(url, 'SEMANTIC_SCHOLAR');
    
    return {
        total: data.total || 999, // S2 author papers endpoint might not return total easily
        source: 'Semantic Scholar',
        items: (data.data || []).map(item => ({
            title: item.title,
            authors: item.authors ? item.authors.map(a => a.name) : [],
            authorAffiliations: item.authors ? item.authors.map(a => 
                (a.affiliations || []).join('; ')
            ) : [],
            venue: item.venue || '',
            year: item.year ? String(item.year) : '',
            doi: item.externalIds?.DOI || '',
            url: item.url,
            source: 'Semantic Scholar',
            abstract: item.abstract,
            keywords: extractSemanticScholarKeywords(item),
            citationCount: item.citationCount,
            publicationDate: item.publicationDate,
            isOpenAccess: item.isOpenAccess,
            openAccessPdf: item.openAccessPdf?.url || ''
        }))
    };
}

async function searchSemanticScholarPapers(query, offset, limit, fields = null) {
    const defaultFields = 'title,authors,year,venue,externalIds,url';
    const fieldParam = fields ? fields : defaultFields;
    const safeLimit = clampInt(limit, 1, 100, 10);
    const safeOffset = clampInt(offset, 0, 1000000, 0);
    const url = `${APIS.SEMANTIC_SCHOLAR.SEARCH}?query=${encodeURIComponent(query)}&offset=${safeOffset}&limit=${safeLimit}&fields=${fieldParam}`;
    const data = await fetchWithRetry(url, 'SEMANTIC_SCHOLAR');
    
    return {
        total: data.total || 0,
        source: 'Semantic Scholar',
        items: (data.data || []).map(item => ({
            title: item.title,
            authors: item.authors ? item.authors.map(a => a.name) : [],
            venue: item.venue || '',
            year: item.year ? String(item.year) : '',
            doi: item.externalIds?.DOI || '',
            url: item.url,
            source: 'Semantic Scholar',
            abstract: item.abstract,
            keywords: extractSemanticScholarKeywords(item),
            citationCount: item.citationCount,
            publicationDate: item.publicationDate,
            isOpenAccess: item.isOpenAccess,
            openAccessPdf: item.openAccessPdf?.url || ''
        }))
    };
}

// ====== Crossref 实现 ======

async function searchCrossrefPapers(query, offset, limit, filters = {}) {
    // Crossref 支持 query.affiliation, query.container-title, filter=from-pub-date
    const safeRows = clampInt(limit, 1, 1000, 10);
    const safeOffset = clampInt(offset, 0, 1000000, 0);
    const defaultSelect = 'title,author,container-title,DOI,URL,published-print,published-online,issued,page';
    const selectParam = select ? select : defaultSelect;
    let url = `${APIS.CROSSREF.WORKS}?query=${encodeURIComponent(query)}&rows=${safeRows}&offset=${safeOffset}&sort=relevance&select=${selectParam}`;
    // 添加高级过滤参数
    if (filters.affiliation) {
        url += `&query.affiliation=${encodeURIComponent(filters.affiliation)}`;
    }
    if (filters.venue) {
        url += `&query.container-title=${encodeURIComponent(filters.venue)}`;
    }
    if (filters.yearStart || filters.yearEnd) {
        const start = filters.yearStart || '1900';
        const end = filters.yearEnd || new Date().getFullYear();
        url += `&filter=from-pub-date:${start}-01-01,until-pub-date:${end}-12-31`;
    }

    const data = await fetchWithRetry(url, 'CROSSREF');
    
    const items = data.message.items.map(item => ({
        ...extractCrossrefPublicationParts(item),
        ...extractCrossrefPages(item),
        title: item.title?.[0] || '',
        authors: item.author ? item.author.map(a => `${a.given} ${a.family}`) : [],
        venue: item['container-title']?.[0] || '',
        year: (item['published-print']?.['date-parts']?.[0]?.[0] || item['published-online']?.['date-parts']?.[0]?.[0] || '').toString(),
        doi: item.DOI,
        url: item.URL,
        language: normalizeLanguageCode(item.language),
        keywords: normalizeKeywords(item.subject),
        source: 'Crossref'
    }));
    
    return {
        total: data.message['total-results'],
        source: 'Crossref',
        items: items
    };
}

// ====== OpenAlex 实现 ======

async function searchOpenAlexPapers(query, offset, limit) {
    // OpenAlex 使用 page & per-page
    const safeLimit = clampInt(limit, 1, 200, 25);
    const safeOffset = clampInt(offset, 0, 1000000, 0);
    const page = Math.floor(safeOffset / safeLimit) + 1;
    const defaultSelect = 'title,authorships,primary_location,publication_year,doi,id';
    const selectParam = select ? select : defaultSelect;
    const url = `${APIS.OPENALEX.WORKS}?search=${encodeURIComponent(query)}&page=${page}&per-page=${safeLimit}&select=${selectParam}`;
    const data = await fetchWithRetry(url, 'OPENALEX');
    
    return {
        total: data.meta.count,
        source: 'OpenAlex',
        items: data.results.map(item => ({
            ...extractOpenAlexPublicationParts(item),
            ...extractOpenAlexPages(item),
            title: item.title,
            authors: item.authorships.map(a => a.author.display_name),
            venue: item.primary_location?.source?.display_name || '',
            year: item.publication_year ? String(item.publication_year) : '',
            language: normalizeLanguageCode(item.language),
            doi: normalizeDoi(item.doi),
            url: item.doi || item.id,
            source: 'OpenAlex',
            citationCount: item.cited_by_count,
            abstract: openAlexInvertedIndexToText(item.abstract_inverted_index),
            grants: Array.isArray(item.grants) ? item.grants : [],
            articleNumber: extractOpenAlexArticleNumber(item),
            keywords: []
        }))
    };
}

async function searchOpenAlexAuthors(query) {
    const url = `${APIS.OPENALEX.AUTHORS}?search=${encodeURIComponent(query)}&per-page=10&select=id,orcid,display_name,works_count,cited_by_count,affiliations,last_known_institutions`;
    const data = await fetchWithRetry(url, 'OPENALEX');
    const items = (data.results || []).map(a => ({
        name: a.display_name,
        id: a.id,
        source: 'OpenAlex',
        url: a.id,
        meta: `论文数: ${a.works_count}, 引用: ${a.cited_by_count}`,
        affiliation: (Array.isArray(a.last_known_institutions) && a.last_known_institutions.length ? (a.last_known_institutions[0]?.display_name || '') : '') || '',
        orcid: a.orcid || ''
    }));
    return { total: items.length, items };
}

async function getOpenAlexAuthorPublications(authorId, offset, limit, filters = {}) {
    const safeLimit = clampInt(limit, 1, 200, 25);
    const safeOffset = clampInt(offset, 0, 1000000, 0);
    const page = Math.floor(safeOffset / safeLimit) + 1;
    const parts = [`authorships.author.id:${authorId}`];
    const yearStart = filters.yearStart ? parseInt(filters.yearStart, 10) : null;
    const yearEnd = filters.yearEnd ? parseInt(filters.yearEnd, 10) : null;
    if (Number.isFinite(yearStart)) parts.push(`from_publication_date:${yearStart}-01-01`);
    if (Number.isFinite(yearEnd)) parts.push(`to_publication_date:${yearEnd}-12-31`);
    const filter = parts.join(',');
    const url = `${APIS.OPENALEX.WORKS}?filter=${encodeURIComponent(filter)}&page=${page}&per-page=${safeLimit}&select=title,authorships,primary_location,publication_year,publication_date,language,doi,id,cited_by_count,abstract_inverted_index,grants,biblio`;
    const data = await fetchWithRetry(url, 'OPENALEX');
    return {
        total: data.meta?.count || 0,
        source: 'OpenAlex',
        items: (data.results || []).map(item => ({
            ...extractOpenAlexPublicationParts(item),
            ...extractOpenAlexPages(item),
            title: item.title,
            authors: (item.authorships || []).map(a => a.author?.display_name).filter(Boolean),
            authorAffiliations: (item.authorships || []).map(a => 
                a.institutions?.map(inst => inst.display_name).join('; ') || ''
            ),
            venue: item.primary_location?.source?.display_name || '',
            year: item.publication_year ? String(item.publication_year) : '',
            language: normalizeLanguageCode(item.language),
            doi: normalizeDoi(item.doi),
            url: item.doi || item.id,
            source: 'OpenAlex',
            citationCount: item.cited_by_count,
            abstract: openAlexInvertedIndexToText(item.abstract_inverted_index),
            grants: Array.isArray(item.grants) ? item.grants : [],
            articleNumber: extractOpenAlexArticleNumber(item),
            keywords: []
        }))
    };
}

async function getAllSemanticScholarPublications(authorId, pageSize = 1000) {
    let offset = 0;
    let all = [];
    let total = null;
    while (true) {
        const batch = await getSemanticScholarPublications(authorId, offset, pageSize);
        if (typeof total !== 'number') total = batch.total;
        all = all.concat(batch.items || []);
        if (!batch.items || batch.items.length < pageSize) break;
        offset += pageSize;
        if (typeof total === 'number' && offset >= total) break;
        if (all.length >= 20000) break;
    }
    return { total: total || all.length, source: 'Semantic Scholar', items: all };
}

async function getAllOpenAlexAuthorPublications(authorId, pageSize = 200) {
    let offset = 0;
    let all = [];
    let total = null;
    while (true) {
        const batch = await getOpenAlexAuthorPublications(authorId, offset, pageSize);
        if (typeof total !== 'number') total = batch.total;
        all = all.concat(batch.items || []);
        if (!batch.items || batch.items.length < pageSize) break;
        offset += pageSize;
        if (typeof total === 'number' && offset >= total) break;
        if (all.length >= 20000) break;
    }
    return { total: total || all.length, source: 'OpenAlex', items: all };
}

async function getSemanticScholarPaperByDoi(doi, fields = null) {
    const d = normalizeDoi(doi);
    if (!d) throw new Error('DOI 为空');
    // 默认基础字段（标题、作者、年份、期刊/会议、DOI、URL）
    const defaultFields = 'title,authors,year,venue,externalIds,url';
    const fieldParam = fields ? fields : defaultFields;
    const url = `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(d)}?fields=${fieldParam}`;
    const item = await fetchWithRetry(url, 'SEMANTIC_SCHOLAR');
    return {
        title: item.title,
        authors: item.authors ? item.authors.map(a => a.name) : [],
        venue: item.venue || '',
        year: item.year ? String(item.year) : '',
        doi: normalizeDoi(item.externalIds?.DOI || d),
        url: item.url,
        source: 'Semantic Scholar',
        // 以下字段可能因 fields 而缺失
        abstract: item.abstract,
        keywords: extractSemanticScholarKeywords(item),
        citationCount: item.citationCount,
        publicationDate: item.publicationDate,
        isOpenAccess: item.isOpenAccess,
        openAccessPdf: item.openAccessPdf?.url || ''
    };
}

async function getCrossrefPaperByDoi(doi, select = null) {
    const d = normalizeDoi(doi);
    if (!d) throw new Error('DOI 为空');
    let url = `${APIS.CROSSREF.WORKS}/${encodeURIComponent(d)}`;
    if (select) {
        url += `?select=${select}`;
    }
    const data = await fetchWithRetry(url, 'CROSSREF');
    const item = data.message;

    // 解析日期、页码等通用字段（这些函数不依赖 select，因为它们是基于 item 的计算）
    const pubParts = extractCrossrefPublicationParts(item);
    const pages = extractCrossrefPages(item);
    const confDates = extractCrossrefEventDateParts(item.event || null);
    const articleNumber = extractCrossrefArticleNumber(item);
    const organizers = Array.isArray(item.editor) ? item.editor.map(normalizePersonName).filter(Boolean) : [];

    // 构建返回对象，只包含我们需要的字段（如果 select 限制了字段，这些字段可能为空，但没关系）
    return {
        // 基础字段（总是返回，因为这些是默认需要的）
        title: item.title?.[0] || '',
        authors: item.author ? item.author.map(a => `${a.given} ${a.family}`.trim()) : [],
        venue: item['container-title']?.[0] || '',
        year: (item['published-print']?.['date-parts']?.[0]?.[0] || item['published-online']?.['date-parts']?.[0]?.[0] || '').toString(),
        doi: normalizeDoi(item.DOI || d),
        url: item.URL,
        source: 'Crossref',
        // 以下字段可能因 select 而缺失，但函数仍然会尝试填充（如果服务器返回了，就有值；否则为默认值）
        abstract: item.abstract || '',
        language: normalizeLanguageCode(item.language),
        keywords: normalizeKeywords(item.subject),
        publisher: item.publisher || '',
        articleNumber: articleNumber,
        conferenceName: item.event?.name || '',
        conferenceLocation: item.event?.location || '',
        conferenceEvent: item.event || null,
        organizers: organizers,
        ...pubParts,
        ...pages,
        ...confDates,
    };
}

export async function searchConferenceEventDate(conferenceName, year) {
    const name = String(conferenceName || '').trim();
    const y = year != null ? String(year).trim() : '';
    if (!name || !/^(19|20)\d{2}$/.test(y)) return { success: false, data: null };

    const cacheKey = `_conference_event_date_${normalizeConferenceCacheKey(name, y)}`;
    const cached = responseCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
        return { success: Boolean(cached.data && cached.data.conferenceEventDate), data: cached.data || null };
    }

    try {
        const rows = 50;
        let url = `${APIS.CROSSREF.WORKS}?rows=${rows}&offset=0&select=event,type,title,container-title,issued,published-print,published-online`;
        url += `&query.container-title=${encodeURIComponent(name)}`;
        url += `&filter=type:proceedings,from-pub-date:${y}-01-01,until-pub-date:${y}-12-31`;
        const data = await fetchWithRetry(url, 'CROSSREF');
        const items = data?.message?.items || [];
        for (const it of items) {
            const event = it?.event || null;
            const dates = extractCrossrefEventDateParts(event);
            if (dates.conferenceEventDate) {
                responseCache.set(cacheKey, { ts: Date.now(), data: dates });
                return { success: true, data: dates };
            }
        }
    } catch (e) {}

    responseCache.set(cacheKey, { ts: Date.now(), data: null });
    return { success: false, data: null };
}

export async function searchConferenceLocation(conferenceName, year) {
    const name = String(conferenceName || '').trim();
    const y = year ? String(year).trim() : '';
    if (!name || !/^(19|20)\d{2}$/.test(y)) return { success: false, location: '' };

    const cacheKey = `_conference_location_${name.toLowerCase().replace(/\s+/g, ' ').trim()}_${y}`;
    if (responseCache.has(cacheKey)) {
        const cached = responseCache.get(cacheKey);
        if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) return { success: true, location: cached.data || '' };
    }

    try {
        const rows = 50;
        let url = `${APIS.CROSSREF.WORKS}?rows=${rows}&offset=0&select=event,type,title,container-title,issued,published-print,published-online`;
        url += `&query.container-title=${encodeURIComponent(name)}`;
        url += `&filter=type:proceedings,from-pub-date:${y}-01-01,until-pub-date:${y}-12-31`;
        const data = await fetchWithRetry(url, 'CROSSREF');
        const items = data?.message?.items || [];
        for (const it of items) {
            const loc = it?.event?.location;
            if (loc && String(loc).trim()) {
                const location = String(loc).trim();
                responseCache.set(cacheKey, { ts: Date.now(), data: location });
                return { success: true, location };
            }
        }
    } catch (e) {}

    try {
        const filterParts = [
            `from_publication_date:${y}-01-01`,
            `to_publication_date:${y}-12-31`
        ];
        const url = `${APIS.OPENALEX.WORKS}?search=${encodeURIComponent(name)}&filter=${encodeURIComponent(filterParts.join(','))}&per-page=25&select=title,primary_location,publication_year`;
        const data = await fetchWithRetry(url, 'OPENALEX');
        const results = data?.results || [];
        for (const it of results) {
            const loc = it?.primary_location?.source?.host_organization_name || '';
            if (loc && String(loc).trim()) {
                const location = String(loc).trim();
                responseCache.set(cacheKey, { ts: Date.now(), data: location });
                return { success: true, location };
            }
        }
    } catch (e) {}

    responseCache.set(cacheKey, { ts: Date.now(), data: '' });
    return { success: false, location: '' };
}

async function searchConferenceOrganizersFromCrossref(conferenceName, year) {
    const { name, year: y } = normalizeConferenceNameAndYear(conferenceName, year);
    if (!name || !Number.isFinite(y)) return [];

    const rows = 50;
    let url = `${APIS.CROSSREF.WORKS}?rows=${rows}&offset=0&select=type,title,container-title,issued,published-print,published-online,event,editor`;
    url += `&query.container-title=${encodeURIComponent(name)}`;
    url += `&filter=type:proceedings,from-pub-date:${y}-01-01,until-pub-date:${y}-12-31`;
    const data = await fetchWithRetry(url, 'CROSSREF');
    const items = data?.message?.items || [];
    let out = [];
    for (const it of items) {
        const editors = Array.isArray(it?.editor) ? it.editor : [];
        for (const e of editors) {
            const nm = normalizePersonName(e);
            if (nm) out.push(nm);
        }
        if (out.length >= 20) break;
    }
    out = filterOrganizerNames(out);
    return out;
}

async function searchConferenceOrganizersFromWikidata(conferenceName, year) {
    const { name, year: y } = normalizeConferenceNameAndYear(conferenceName, year);
    if (!name || !Number.isFinite(y)) return [];

    const nameLc = name.toLowerCase().replace(/"/g, '\\"');
    const ystr = String(y);
    // 两阶段：1) 直接匹配某届会议的标签 + 年份；2) 通过系列匹配某届事件
    const queries = [
`SELECT DISTINCT ?personLabel WHERE {
  VALUES ?class { wd:Q2020153 wd:Q2761147 }  # conference / scientific conference
  ?edition wdt:P31/wdt:P279* ?class .
  ?edition rdfs:label ?label .
  FILTER(LANG(?label) IN ("en","zh","zh-cn","zh-hans","")).
  FILTER(CONTAINS(LCASE(STR(?label)), "${nameLc}")).
  OPTIONAL { ?edition wdt:P585 ?pTime . FILTER (YEAR(?pTime) = ${ystr}) }
  OPTIONAL { ?edition wdt:P580 ?sTime . FILTER (YEAR(?sTime) = ${ystr}) }
  FILTER(BOUND(?pTime) || BOUND(?sTime)).
  OPTIONAL { ?edition wdt:P664 ?org . ?org wdt:P31 wd:Q5 . }
  OPTIONAL { ?edition wdt:P488 ?chair . ?chair wdt:P31 wd:Q5 . }
  BIND(COALESCE(?org, ?chair) AS ?person)
  FILTER(BOUND(?person))
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,zh,zh-cn,zh-hans". }
} LIMIT 50`,
`SELECT DISTINCT ?personLabel WHERE {
  VALUES ?class { wd:Q2020153 wd:Q2761147 }
  ?series rdfs:label ?slabel .
  FILTER(LANG(?slabel) IN ("en","zh","zh-cn","zh-hans")).
  FILTER(CONTAINS(LCASE(STR(?slabel)), "${nameLc}")).
  ?edition wdt:P31/wdt:P279* ?class .
  ?edition wdt:P361 ?series .
  OPTIONAL { ?edition wdt:P585 ?pTime . FILTER (YEAR(?pTime) = ${ystr}) }
  OPTIONAL { ?edition wdt:P580 ?sTime . FILTER (YEAR(?sTime) = ${ystr}) }
  FILTER(BOUND(?pTime) || BOUND(?sTime)).
  OPTIONAL { ?edition wdt:P664 ?org . ?org wdt:P31 wd:Q5 . }
  OPTIONAL { ?edition wdt:P488 ?chair . ?chair wdt:P31 wd:Q5 . }
  BIND(COALESCE(?org, ?chair) AS ?person)
  FILTER(BOUND(?person))
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,zh,zh-cn,zh-hans". }
} LIMIT 50`
    ];

    let out = [];
    for (const q of queries) {
        try {
            const url = `${APIS.WIKIDATA.SPARQL}?format=json&query=${encodeURIComponent(q)}`;
            const data = await fetchWithRetry(url, 'WIKIDATA');
            const bindings = data?.results?.bindings || [];
            for (const b of bindings) {
                const v = b?.personLabel?.value;
                if (v && String(v).trim()) out.push(String(v).trim());
            }
            if (out.length) break;
        } catch (e) {}
    }
    out = filterOrganizerNames(out);
    return out;
}

export async function searchConferenceOrganizers(conferenceName, year) {
    const { name, year: y } = normalizeConferenceNameAndYear(conferenceName, year);
    if (!name || !Number.isFinite(y)) return { success: false, organizers: [] };

    const cacheKey = `_conference_organizers_${normalizeConferenceCacheKey(name, y)}`;
    const cached = responseCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
        const organizers = Array.isArray(cached.data) ? cached.data : [];
        return { success: organizers.length > 0, organizers };
    }

    try {
        const crossref = await searchConferenceOrganizersFromCrossref(name, y);
        if (crossref.length) {
            responseCache.set(cacheKey, { ts: Date.now(), data: crossref });
            return { success: true, organizers: crossref, source: 'Crossref' };
        }
    } catch (e) {}

    responseCache.set(cacheKey, { ts: Date.now(), data: [] });
    return { success: false, organizers: [] };
}

async function getOpenAlexPaperByDoi(doi, select = null) {
    const d = normalizeDoi(doi);
    if (!d) throw new Error('DOI 为空');
    const filter = `doi:https://doi.org/${d}`;
    let url = `${APIS.OPENALEX.WORKS}?filter=${encodeURIComponent(filter)}&per-page=1`;
    if (select) {
        url += `&select=${select}`;
    } else {
        // 默认基础字段
        url += '&select=title,authorships,primary_location,publication_year,doi,id';
    }
    const data = await fetchWithRetry(url, 'OPENALEX');
    const item = data.results?.[0];
    if (!item) throw new Error('OpenAlex 未找到该 DOI');
    return {
        // 基础字段（总是返回）
        title: item.title,
        authors: (item.authorships || []).map(a => a.author?.display_name).filter(Boolean),
        venue: item.primary_location?.source?.display_name || '',
        year: item.publication_year ? String(item.publication_year) : '',
        doi: normalizeDoi(item.doi || d),
        url: item.doi || item.id,
        source: 'OpenAlex',
        // 以下字段可能因 select 而缺失
        citationCount: item.cited_by_count,
        abstract: openAlexInvertedIndexToText(item.abstract_inverted_index),
        grants: Array.isArray(item.grants) ? item.grants : [],
        articleNumber: extractOpenAlexArticleNumber(item),
        language: normalizeLanguageCode(item.language),
        publicationDate: item.publication_date,
        publicationMonth: item.publication_date ? item.publication_date.split('-')[1] : '',
        publicationDay: item.publication_date ? item.publication_date.split('-')[2] : '',
        firstPage: item.biblio?.first_page || '',
        lastPage: item.biblio?.last_page || '',
        pageRange: item.biblio?.first_page && item.biblio?.last_page ? `${item.biblio.first_page}-${item.biblio.last_page}` : '',
        keywords: []
    };
}

export async function getPaperByDOI(doi) {
    const d = normalizeDoi(doi);
    if (!d) return { success: false, message: 'DOI 为空' };
    try {
        const paper = await getSemanticScholarPaperByDoi(d);
        return { success: true, source: paper.source, paper };
    } catch (e1) {}
    try {
        const paper = await getCrossrefPaperByDoi(d);
        return { success: true, source: paper.source, paper };
    } catch (e2) {}
    try {
        const paper = await getOpenAlexPaperByDoi(d);
        return { success: true, source: paper.source, paper };
    } catch (e3) {}
    return { success: false, message: '未找到该 DOI 的论文详情' };
}

export async function unifiedSearchPapers(query, offset = 0, limit = 20, filters = {}, requiredFields = []) {
    const q = String(query || '').trim();
    if (!q) return { total: 0, items: [], error: '空查询' };

    if (q.includes('/') && q.includes('.')) {
        const byDoi = await getPaperByDOI(q);
        if (byDoi.success) {
            return { total: 1, source: byDoi.source, items: [byDoi.paper] };
        }
    }

    const safeLimit = clampInt(limit, 1, 100, 20);
    const safeOffset = clampInt(offset, 0, 1000000, 0);

    try {
        const url = `${APIS.DBLP.SEARCH_PUBL}?q=${encodeURIComponent(q)}&h=${safeLimit}&f=${safeOffset}&format=json`;
        const data = await fetchWithRetry(url, 'DBLP');
        const hits = data.result?.hits?.hit || [];
        if (hits.length > 0) {
            return {
                total: parseInt(data.result?.hits?.['@total'] || 0),
                source: 'DBLP (Search)',
                items: hits.map(hit => ({
                    title: hit.info.title,
                    authors: hit.info.authors?.author ? (Array.isArray(hit.info.authors.author) ? hit.info.authors.author.map(a => a.text || a) : [hit.info.authors.author.text || hit.info.authors.author]) : [],
                    venue: hit.info.venue || '',
                    year: hit.info.year || '',
                    doi: hit.info.doi || '',
                    url: hit.info.url || '',
                    keywords: [],
                    source: 'DBLP'
                }))
            };
        }
    } catch (e) { console.warn('DBLP Search 失败'); }

    if (!filters.affiliation && !filters.venue) {
        try {
            if (!isInBackoff('SEMANTIC_SCHOLAR')) {
                return await searchSemanticScholarPapers(q, safeOffset, safeLimit);
            }
        } catch (e) { console.warn('Semantic Scholar Search 失败'); }
    }

    try {
        return await searchCrossrefPapers(q, safeOffset, safeLimit, filters);
    } catch (e) { console.warn('Crossref Search 失败'); }

    try {
        return await searchOpenAlexPapers(q, safeOffset, safeLimit);
    } catch (e) { console.warn('OpenAlex Search 失败'); }

    return { total: 0, items: [], error: '未找到相关论文' };
}

// ====== 统一对外接口 ======

export async function unifiedSearchAuthors(query) {
    const results = [];
    const tasks = [];
    tasks.push((async () => {
        const r = await searchDBLPAuthor(query);
        if (r.items && r.items.length) results.push(...r.items);
    })());
    tasks.push((async () => {
        if (isInBackoff('SEMANTIC_SCHOLAR')) return;
        const r = await searchSemanticScholarAuthor(query);
        if (r.items && r.items.length) results.push(...r.items);
    })());
    tasks.push((async () => {
        const r = await searchOpenAlexAuthors(query);
        if (r.items && r.items.length) results.push(...r.items);
    })());
    await Promise.allSettled(tasks);
    return { total: results.length, items: results };
}

export async function unifiedGetPublications(author, offset = 0, limit = 10, filters = {}, requiredFields = []) {
    // 策略：如果 author 有 source 和 id，使用对应源
    // 否则，按 fallback 链搜索论文：DBLP(name) -> Semantic Scholar(name) -> Crossref(name) -> OpenAlex(name)
    
    try {
        if (author.source === 'DBLP' && author.id) {
            return await getDBLPAuthorPublications(author.id, offset, limit);
        }
        if (author.source === 'Semantic Scholar' && author.id) {
            if (offset === 0 && limit >= 5000) {
                return await getAllSemanticScholarPublications(author.id);
            }
            return await getSemanticScholarPublications(author.id, offset, limit);
        }
        if (author.source === 'OpenAlex' && author.id) {
            if (offset === 0 && limit >= 5000) {
                return await getAllOpenAlexAuthorPublications(author.id);
            }
            return await getOpenAlexAuthorPublications(author.id, offset, limit, filters);
        }
    } catch (e) {
        console.warn(`源 ${author.source} 获取论文失败，尝试通用搜索:`, e);
    }
    
    // 通用搜索 Fallback Chain
    const name = author.name || author;
    
    // 1. DBLP Search (Name)
    if (!filters.affiliation && !filters.venue) { // DBLP API 简单搜索不支持复杂过滤
        try {
            const url = `${APIS.DBLP.SEARCH_PUBL}?q=author:"${encodeURIComponent(name)}"&h=${limit}&f=${offset}&format=json`;
            const data = await fetchWithRetry(url, 'DBLP');
            const hits = data.result?.hits?.hit || [];
            if (hits.length > 0) {
                return {
                    total: parseInt(data.result?.hits?.['@total'] || 0),
                    source: 'DBLP (Search)',
                    items: hits.map(hit => ({
                        title: hit.info.title,
                        authors: hit.info.authors?.author ? (Array.isArray(hit.info.authors.author) ? hit.info.authors.author.map(a => a.text||a) : [hit.info.authors.author.text||hit.info.authors.author]) : [],
                        venue: hit.info.venue,
                        year: hit.info.year,
                        doi: hit.info.doi,
                        url: hit.info.url || '',
                        keywords: [],
                        source: 'DBLP'
                    }))
                };
            }
        } catch (e) { console.warn('DBLP Search 失败'); }
    }

    // 2. Semantic Scholar
    if (!filters.affiliation && !filters.venue) {
        try {
            if (!isInBackoff('SEMANTIC_SCHOLAR')) {
                return await searchSemanticScholarPapers(name, offset, limit);
            }
        } catch (e) { console.warn('Semantic Scholar Search 失败'); }
    }

    // 3. Crossref (支持高级过滤)
    try {
        return await searchCrossrefPapers(name, offset, limit, filters);
    } catch (e) { console.warn('Crossref Search 失败'); }

    // 4. OpenAlex
    try {
        return await searchOpenAlexPapers(name, offset, limit);
    } catch (e) { console.warn('OpenAlex Search 失败'); }

    return { total: 0, items: [], error: '未找到相关论文' };
}

export { getSemanticScholarPaperByDoi, getCrossrefPaperByDoi, getOpenAlexPaperByDoi };
