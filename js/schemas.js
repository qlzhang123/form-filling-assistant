// schemas.js
// 完整的 API 参数定义，基于官方文档

// ==================== Semantic Scholar Graph API ====================
// 文档: https://api.semanticscholar.org/api-docs/graph

export const SEMANTIC_SCHOLAR_PAPER_SCHEMA = {
    type: 'function',
    description: '获取论文的完整元数据，支持按 DOI、arXiv ID、Semantic Scholar ID、MAG ID、PubMed ID、PMC ID、ACL ID、Corpus ID 或自由文本搜索。',
    parameters: {
        type: 'object',
        properties: {
            // 标识符 (至少提供一个)
            paperId: { type: 'string', description: 'Semantic Scholar 论文 ID' },
            doi: { type: 'string', description: 'DOI 标识符，如 "10.1145/3745021"' },
            arxivId: { type: 'string', description: 'arXiv ID，如 "2301.12345"' },
            magId: { type: 'string', description: 'Microsoft Academic Graph ID' },
            pubmedId: { type: 'string', description: 'PubMed ID (PMID)' },
            pmcid: { type: 'string', description: 'PubMed Central ID' },
            aclId: { type: 'string', description: 'ACL Anthology ID' },
            corpusId: { type: 'integer', description: 'Semantic Scholar Corpus ID' },
            query: { type: 'string', description: '自由文本搜索关键词（用于 Search API）' },
            // 搜索选项 (仅 Search API 有效)
            limit: { type: 'integer', description: '返回结果数量，默认 5，最大 100', default: 5 },
            offset: { type: 'integer', description: '分页偏移量', default: 0 },
            fields: {
                type: 'array',
                items: {
                    type: 'string',
                    enum: [
                        'paperId', 'externalIds', 'url', 'title', 'abstract', 'venue', 'publicationVenue',
                        'year', 'publicationDate', 'authors', 'fieldsOfStudy', 's2FieldsOfStudy', 'citationCount',
                        'influentialCitationCount', 'referenceCount', 'isOpenAccess', 'openAccessPdf', 'journal',
                        'citationStyles', 'tldr', 'embedding', 'publicationTypes', 'references', 'citations',
                        'corpusId', 'corpusDate'
                    ]
                },
                description: '返回字段列表。**强烈建议只请求你需要的字段**，以节省带宽和避免 API 限流。例如：["title","authors","year"]',
                default: ['title', 'authors', 'year', 'venue', 'citationCount']
            },
            sort: { type: 'string', description: '排序方式，如 "citationCount:desc", "publicationDate:desc"', enum: ['relevance', 'citationCount:desc', 'citationCount:asc', 'publicationDate:desc', 'publicationDate:asc'] },
            year: { type: 'string', description: '按年份过滤，格式 "2024" 或 "2020-2024"' },
            venue: { type: 'string', description: '按期刊/会议名称过滤' },
            fieldsOfStudy: { type: 'string', description: '按研究领域过滤' },
            publicationTypes: { type: 'string', description: '按出版物类型过滤，如 "JournalArticle"' },
            openAccessPdf: { type: 'boolean', description: '是否仅开放获取' }
        },
        oneOf: [
            { required: ['paperId'] }, { required: ['doi'] }, { required: ['arxivId'] },
            { required: ['magId'] }, { required: ['pubmedId'] }, { required: ['pmcid'] },
            { required: ['aclId'] }, { required: ['corpusId'] }, { required: ['query'] }
        ]
    }
};

export const SEMANTIC_SCHOLAR_AUTHOR_SCHEMA = {
    type: 'function',
    description: '获取作者详细信息，包括姓名、别名、所属机构、主页、h-index、论文数等。',
    parameters: {
        type: 'object',
        properties: {
            authorId: { type: 'string', description: 'Semantic Scholar 作者 ID' },
            name: { type: 'string', description: '作者姓名' },
            query: { type: 'string', description: '搜索关键词' },
            limit: { type: 'integer', description: '返回结果数量，默认 5，最大 100', default: 5 },
            fields: {
                type: 'array',
                items: { type: 'string' },
                description: '返回字段列表，可选值：authorId, externalIds, url, name, aliases, affiliations, homepage, paperCount, citationCount, hIndex, papers',
                default: ['name', 'affiliations', 'hIndex', 'paperCount']
            }
        },
        oneOf: [
            { required: ['authorId'] },
            { required: ['name'] },
            { required: ['query'] }
        ]
    }
};

// ==================== Crossref REST API ====================
// 文档: https://api.crossref.org/swagger/ui/index#/Works

export const CROSSREF_WORK_SCHEMA = {
    type: 'function',
    description: '获取 CrossRef 作品元数据，包含标题、作者、期刊、出版日期、会议信息、页码、基金、参考文献等。',
    parameters: {
        type: 'object',
        properties: {
            doi: { type: 'string', description: 'DOI 标识符' },
            query: { type: 'string', description: '搜索关键词' },
            rows: { type: 'integer', description: '返回结果数量，默认 10，最大 1000', default: 10 },
            offset: { type: 'integer', description: '分页偏移量', default: 0 },
            sort: { type: 'string', enum: ['relevance', 'published', 'issued', 'deposited', 'indexed', 'updated'], description: '排序方式', default: 'relevance' },
            order: { type: 'string', enum: ['asc', 'desc'], description: '排序顺序', default: 'desc' },
            filter: {
                type: 'object',
                description: '过滤条件，支持以下所有官方键',
                properties: {
                    'from-pub-date': { type: 'string', description: '出版日期起始，格式 YYYY-MM-DD' },
                    'until-pub-date': { type: 'string', description: '出版日期结束' },
                    'type': { type: 'string', description: '作品类型，如 "journal-article", "proceedings-article", "book-chapter"' },
                    'has-abstract': { type: 'boolean' },
                    'has-full-text': { type: 'boolean' },
                    'has-license': { type: 'boolean' },
                    'has-references': { type: 'boolean' },
                    'has-funder': { type: 'boolean' },
                    'has-orcid': { type: 'boolean' },
                    'has-archive': { type: 'boolean' },
                    'has-article-number': { type: 'boolean' },
                    'is-peer-reviewed': { type: 'boolean' },
                    'is-update': { type: 'boolean' },
                    'directory': { type: 'string' },
                    'from-index-date': { type: 'string' },
                    'until-index-date': { type: 'string' },
                    'from-created-date': { type: 'string' },
                    'until-created-date': { type: 'string' },
                    'from-deposit-date': { type: 'string' },
                    'until-deposit-date': { type: 'string' },
                    'from-update-date': { type: 'string' },
                    'until-update-date': { type: 'string' },
                    'member': { type: 'string', description: '会员 ID' },
                    'prefix': { type: 'string', description: 'DOI 前缀' },
                    'publisher': { type: 'string' },
                    'issn': { type: 'string' },
                    'isbn': { type: 'string' },
                    'type-name': { type: 'string' },
                    'language': { type: 'string' },
                    'category-name': { type: 'string' },
                    'award-number': { type: 'string' },
                    'award-funder': { type: 'string' },
                    'orcid': { type: 'string' },
                    'funder-name': { type: 'string' },
                    'license-url': { type: 'string' },
                    'license-version': { type: 'string' },
                    'has-relation': { type: 'boolean' },
                    'has-relation-type': { type: 'boolean' },
                    'has-funder-relation': { type: 'boolean' },
                    'has-award-number': { type: 'boolean' }
                }
            },
            select: {
                type: 'array',
                items: {
                    type: 'string',
                    enum: [
                        'DOI', 'title', 'author', 'container-title', 'publisher', 'issued', 'published-print',
                        'published-online', 'volume', 'issue', 'page', 'article-number', 'abstract', 'subject',
                        'language', 'reference', 'reference-count', 'is-referenced-by-count', 'license', 'funder',
                        'event', 'type', 'relation', 'update-to', 'update-policy', 'editor', 'translator', 'chair',
                        'organizer', 'sponsor', 'standard-body', 'archive', 'assertion', 'link', 'URL'
                    ]
                },
                description: '指定返回字段，**强烈建议只请求你需要的字段**，以节省带宽和避免 API 限流。例如：["DOI","title","author"]。完整字段列表见官方文档：https://api.crossref.org/swagger/ui/index#/Works',
                default: ['DOI', 'title', 'author', 'container-title', 'issued', 'page']
            },
            sample: { type: 'integer', description: '随机抽样数量，与 query 一起使用' }
        },
        oneOf: [
            { required: ['doi'] },
            { required: ['query'] }
        ]
    }
};

// ==================== OpenAlex API ====================
// 文档: https://docs.openalex.org/api-entities/works

export const OPENALEX_WORK_SCHEMA = {
    type: 'function',
    description: '获取 OpenAlex 作品元数据，包含标题、作者、期刊/会议、出版日期、引用数、摘要、资助信息、概念等。',
    parameters: {
        type: 'object',
        properties: {
            doi: { type: 'string', description: 'DOI 标识符' },
            openalex_id: { type: 'string', description: 'OpenAlex 作品 ID，如 "W123456789"' },
            title: { type: 'string', description: '作品标题' },
            query: { type: 'string', description: '搜索关键词' },
            filter: {
                type: 'string',
                description: '过滤条件，支持任意字段，格式 "field:value" 或 "field:min,max"。常用字段：publication_year, type, is_oa, language, from_publication_date, to_publication_date, authorships.institutions.country_code, primary_location.source.id, concept.id, cited_by_count, open_access.oa_status, grants.award_id 等。示例："publication_year:2024,type:article,is_oa:true"'
            },
            'per-page': { type: 'integer', description: '每页数量，默认 25，最大 200', default: 25 },
            page: { type: 'integer', description: '页码', default: 1 },
            sort: { type: 'string', description: '排序字段，如 "cited_by_count:desc", "publication_date:desc"', default: 'relevance_score:desc' },
            select: {
                type: 'array',
                items: {
                    type: 'string',
                    enum: [
                        'id', 'doi', 'title', 'display_name', 'publication_year', 'publication_date', 'language',
                        'abstract_inverted_index', 'authorships', 'cited_by_count', 'biblio', 'primary_location',
                        'locations', 'best_oa_location', 'open_access', 'grants', 'concepts', 'mesh', 'keywords',
                        'countries_distinct_count', 'institutions_distinct_count', 'corresponding_author_ids',
                        'corresponding_institution_ids', 'apc_list', 'apc_paid', 'cited_by_api_url', 'counts_by_year',
                        'updated_date', 'created_date', 'type', 'type_crossref', 'ids', 'referenced_works', 'related_works',
                        'abstract'
                    ]
                },
                description: '指定返回字段，**强烈建议只请求你需要的字段**，以节省带宽和避免 API 限流。例如：["title","authorships","publication_year"]。完整字段列表见官方文档：https://docs.openalex.org/api-entities/works',
                default: ['title', 'authorships', 'publication_year', 'doi', 'id', 'primary_location']
            },
            group_by: { type: 'string', description: '分组统计，如 "publication_year"' },
            sample: { type: 'integer', description: '随机抽样数量' },
            cursor: { type: 'string', description: '深度分页游标' }
        },
        oneOf: [
            { required: ['doi'] },
            { required: ['openalex_id'] },
            { required: ['title'] },
            { required: ['query'] }
        ]
    }
};

// ==================== DBLP API ====================
// 文档: https://dblp.org/faq/1470145.html

export const DBLP_PAPER_SCHEMA = {
    type: 'function',
    description: '通过 DBLP API 获取论文详细信息，支持按标题、作者、年份、期刊/会议、key 搜索。',
    parameters: {
        type: 'object',
        properties: {
            title: { type: 'string', description: '论文标题' },
            key: { type: 'string', description: 'DBLP 论文 key，如 "journals/corr/abs-1901-02860"' },
            author: { type: 'string', description: '作者姓名' },
            venue: { type: 'string', description: '期刊或会议名称' },
            year: { type: 'string', description: '出版年份' },
            type: { type: 'string', description: '论文类型，如 "article", "inproceedings", "phdthesis"' },
            query: { type: 'string', description: '自由文本搜索' },
            format: { type: 'string', enum: ['json', 'xml'], description: '返回格式', default: 'json' },
            h: { type: 'integer', description: '返回结果数量', default: 10 },
            f: { type: 'integer', description: '分页偏移量', default: 0 }
        },
        oneOf: [
            { required: ['title'] },
            { required: ['key'] },
            { required: ['query'] }
        ]
    }
};

export const DBLP_AUTHOR_SCHEMA = {
    type: 'function',
    description: '通过 DBLP API 获取作者详情，包括姓名、PID、主页、所属机构、别名等。',
    parameters: {
        type: 'object',
        properties: {
            name: { type: 'string', description: '作者姓名' },
            pid: { type: 'string', description: 'DBLP 作者 PID' }
        },
        oneOf: [
            { required: ['name'] },
            { required: ['pid'] }
        ]
    }
};

