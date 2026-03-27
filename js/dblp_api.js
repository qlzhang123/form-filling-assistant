// dblp_api.js
const DBLP_SEARCH_PUBL = 'https://dblp.org/search/publ/api';
const DBLP_SEARCH_AUTHOR = 'https://dblp.org/search/author/api';
const DBLP_REC_BASE = 'https://dblp.org/rec/';
const DBLP_PID_BASE = 'https://dblp.org/pid/';
const SEMANTIC_SCHOLAR_SEARCH = 'https://api.semanticscholar.org/graph/v1/paper/search';

// 简单的延迟函数
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 全局请求时间戳，用于频率限制
let lastDBLPRequestTime = 0;
const MIN_DBLP_INTERVAL = 2000; // DBLP 请求最小间隔 (ms) - 严格遵守 DBLP 规则

async function fetchDBLP(url, retries = 3, initialDelay = 2000) {
    let lastError;
    
    for (let i = 0; i < retries; i++) {
        try {
            // 1. 全局频率限制：确保两次请求之间有最小间隔
            const now = Date.now();
            const timeSinceLast = now - lastDBLPRequestTime;
            if (timeSinceLast < MIN_DBLP_INTERVAL) {
                await delay(MIN_DBLP_INTERVAL - timeSinceLast);
            }
            
            // 2. 指数退避重试延迟
            if (i > 0) {
                // 基础延迟 * 2^i + 随机抖动 (0-1000ms)
                const backoffDelay = initialDelay * Math.pow(2, i - 1) + Math.random() * 1000;
                console.log(`DBLP API: 等待 ${Math.round(backoffDelay)}ms 后重试...`);
                await delay(backoffDelay);
            }
            
            // 更新最后请求时间 (在 await delay 之后更新，确保是发请求前的时刻)
            lastDBLPRequestTime = Date.now();
            
            const response = await fetch(url);
            
            // 检查HTTP状态码
            if (!response.ok) {
                // 如果是 429 (Too Many Requests) 或 503 (Service Unavailable)，抛出错误以触发重试
                if (response.status === 429 || response.status === 503) {
                    throw new Error(`HTTP ${response.status}: 服务暂时不可用或请求过多`);
                }
                // 其他错误直接抛出，不重试（除非是网络错误）
                throw new Error(`HTTP ${response.status}: 请求失败`);
            }
            
            const text = await response.text();
            const trimmed = text.trim();
            
            // 检查是否为有效的 JSON (或 XML)
            // DBLP API 有时会返回 XML 或 HTML 错误页面
            if (!trimmed.startsWith('{') && !trimmed.startsWith('[') && !trimmed.startsWith('<')) {
                 throw new Error('返回数据格式错误 (非 JSON/XML)');
            }
            
            // 如果是 HTML 错误页面
            if (trimmed.toLowerCase().startsWith('<!doctype') || trimmed.toLowerCase().startsWith('<html')) {
                throw new Error('返回了 HTML 页面而非数据，可能是服务器错误或拦截');
            }
            
            try {
                // 尝试解析为 JSON
                if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                    return JSON.parse(trimmed);
                } else if (trimmed.startsWith('callback')) {
                     // 处理 JSONP
                     const jsonText = trimmed.replace(/^\w+\(/, '').replace(/\)$/, '');
                     return JSON.parse(jsonText);
                } else {
                    // 如果是 XML，直接返回文本，由调用者处理 (getAuthorPublications 会处理 XML)
                    return trimmed; 
                }
            } catch (e) {
                // 如果 JSON 解析失败但看起来像 JSONP
                if (trimmed.startsWith('callback')) {
                    const jsonText = trimmed.replace(/^\w+\(/, '').replace(/\)$/, '');
                    return JSON.parse(jsonText);
                }
                throw e;
            }
            
        } catch (e) {
            console.warn(`DBLP API 请求失败 (尝试 ${i + 1}/${retries}):`, e.message);
            lastError = e;
            // 继续下一次重试
        }
    }
    
    throw lastError || new Error('DBLP API 请求失败');
}

// 降级方案：使用 Semantic Scholar 搜索
async function searchPublicationsSemanticScholar(query, offset = 0, limit = 10) {
    // Semantic Scholar API 需要 query, offset, limit
    // fields 参数用于指定返回字段
    const fields = 'title,authors,year,venue,externalIds,url,abstract';
    const url = `${SEMANTIC_SCHOLAR_SEARCH}?query=${encodeURIComponent(query)}&offset=${offset}&limit=${limit}&fields=${fields}`;
    
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Semantic Scholar API Error: ${response.status}`);
        }
        
        const data = await response.json();
        const items = data.data || [];
        const total = data.total || items.length; // S2 API total 有时不可靠
        
        return {
            total: total,
            source: 'Semantic Scholar',
            items: items.map(item => ({
                title: item.title,
                authors: item.authors ? item.authors.map(a => a.name) : [],
                venue: item.venue || '',
                year: item.year ? String(item.year) : '',
                type: 'Publication', // S2 不区分类型
                key: item.paperId,
                doi: item.externalIds?.DOI || '',
                url: item.url,
                ee: item.url,
                abstract: item.abstract
            }))
        };
        
    } catch (e) {
        console.error('Semantic Scholar Search Error:', e);
        return { total: 0, items: [], error: '所有数据源均不可用: ' + e.message };
    }
}

// 搜索作者（返回简化列表）
export async function searchAuthors(query) {
    const url = `${DBLP_SEARCH_AUTHOR}?q=${encodeURIComponent(query)}&format=json`;
    try {
        const data = await fetchDBLP(url);
        const hits = data.result?.hits?.hit || [];
        return {
            total: parseInt(data.result?.hits?.['@total'] || 0),
            items: hits.map(hit => {
                const info = hit.info;
                // 提取 PID
                // dblp 作者 URL 通常格式: https://dblp.org/pid/xx/xxxx.html 或 https://dblp.org/pid/12/3456.html
                let pid = info.url?.match(/\/pid\/(.+?)\.html$/)?.[1] || info.key;
                
                return {
                    name: info.author,
                    pid: pid,
                    url: info.url,
                    aliases: info.aliases?.alias ? (Array.isArray(info.aliases.alias) ? info.aliases.alias : [info.aliases.alias]) : []
                };
            })
        };
    } catch (e) {
        console.error('DBLP Author Search Error:', e);
        return { total: 0, items: [], error: e.message };
    }
}

// 根据作者 PID 获取其出版物列表
// 使用 /pid/{PID}.xml 接口获取所有出版物，并进行客户端分页
export async function getAuthorPublications(authorName, pid, offset = 0, limit = 10) {
    if (!pid) {
        // 如果没有 PID，回退到按名字搜索
        const query = `author:"${authorName}"`;
        return await searchPublications(query, offset, limit);
    }

    const url = `${DBLP_PID_BASE}${pid}.xml`;
    try {
        // 获取 XML 数据
        const response = await fetch(url);
        if (!response.ok) {
             // 如果 PID 接口不可用 (503/429)，尝试降级到 Semantic Scholar
             if (response.status === 503 || response.status === 429) {
                 console.log('🔄 DBLP PID 接口不可用，切换到 Semantic Scholar...');
                 return await searchPublicationsSemanticScholar(authorName, offset, limit);
             }
             throw new Error(`HTTP ${response.status}: 请求失败`);
        }
        
        const xmlText = await response.text();
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlText, "text/xml");
        
        // 检查解析错误
        const parseError = xmlDoc.querySelector('parsererror');
        if (parseError) {
            throw new Error('XML 解析错误');
        }

        // 提取出版物列表 (r 标签)
        const records = Array.from(xmlDoc.querySelectorAll('dblpperson > r'));
        const total = records.length;
        
        // 客户端分页
        const pagedRecords = records.slice(offset, offset + limit);
        
        const items = pagedRecords.map(record => {
            // record 下通常只有一个子元素 (article, inproceedings, etc.)
            const pub = record.firstElementChild;
            if (!pub) return null;
            
            const title = pub.querySelector('title')?.textContent || '';
            const year = pub.querySelector('year')?.textContent || '';
            const venue = pub.querySelector('journal')?.textContent || pub.querySelector('booktitle')?.textContent || '';
            const url = pub.querySelector('ee')?.textContent || pub.querySelector('url')?.textContent || '';
            const doi = pub.querySelector('ee')?.textContent?.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i)?.[0] || '';
            
            const authors = Array.from(pub.querySelectorAll('author')).map(el => el.textContent);
            
            return {
                title: title,
                authors: authors,
                venue: venue,
                year: year,
                type: pub.tagName, // article, inproceedings, etc.
                key: pub.getAttribute('key'),
                doi: doi,
                url: url,
                ee: url
            };
        }).filter(Boolean);

        return {
            total: total,
            source: 'DBLP (PID)',
            items: items
        };

    } catch (e) {
        console.error('DBLP PID Fetch Error:', e);
        // 出错时回退到 Semantic Scholar
        return await searchPublicationsSemanticScholar(authorName, offset, limit);
    }
}

// 根据论文key获取详细信息
export async function getPublicationByKey(key) {
    const url = `${DBLP_REC_BASE}${key}.json`;
    const data = await fetchDBLP(url);
    const pub = data.result?.hits?.hit?.[0]?.info || {};
    return {
        title: pub.title,
        authors: pub.authors?.author ? (Array.isArray(pub.authors.author) ? pub.authors.author.map(a => a.text) : [pub.authors.author.text]) : [],
        venue: pub.venue,
        year: pub.year,
        type: pub.type,
        key: pub.key,
        doi: pub.doi,
        ee: pub.ee,
        abstract: pub.abstract,
        pages: pub.pages,
        volume: pub.volume,
        number: pub.number,
        publisher: pub.publisher,
        isbn: pub.isbn
    };
}

// 根据作者pid获取详细信息
export async function getAuthorByPid(pid) {
    const url = `${DBLP_PID_BASE}${pid}.json`;
    const data = await fetchDBLP(url);
    const author = data.result?.author?.[0] || {};
    return {
        name: author.text,
        pid: pid,
        url: `https://dblp.org/pid/${pid}.html`,
        homepages: author.homepages?.homepage ? (Array.isArray(author.homepages.homepage) ? author.homepages.homepage : [author.homepages.homepage]) : [],
        affiliations: author.affiliations?.affiliation ? (Array.isArray(author.affiliations.affiliation) ? author.affiliations.affiliation : [author.affiliations.affiliation]) : [],
        notes: author.notes?.note ? (Array.isArray(author.notes.note) ? author.notes.note : [author.notes.note]) : []
    };
}
