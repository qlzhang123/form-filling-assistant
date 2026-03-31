class WholeFormPlanner {
    constructor(llmClient = null) {
        this.llmClient = llmClient;
        this.autoFillThreshold = 0.85;
        this.slotRules = [
            { slot: 'title', patterns: ['论文标题', '成果标题', '题目', 'title'] },
            { slot: 'doi', patterns: ['doi'] },
            { slot: 'authors', patterns: ['作者', 'author'] },
            { slot: 'authorAffiliations', patterns: ['作者机构', '工作单位', 'affiliation', '单位', '机构'] },
            { slot: 'year', patterns: ['年份', '年度', 'year'] },
            { slot: 'venue', patterns: ['期刊', '刊物', '会议', 'venue', 'journal', 'conference', '发表刊物', '成果来源'] },
            { slot: 'venueShort', patterns: ['会议简称', '刊物简称', '简称', 'acronym'] },
            { slot: 'abstract', patterns: ['摘要', 'abstract'] },
            { slot: 'summary', patterns: ['简介', '摘要精简', '内容概述', '成果简介', 'summary', 'description'] },
            { slot: 'keywords', patterns: ['关键词', '关键字', 'keyword'] },
            { slot: 'citationCount', patterns: ['引用', 'citation'] },
            { slot: 'language', patterns: ['语言', 'language'] },
            { slot: 'paperType', patterns: ['成果类型', '论文类别', '成果类别', '标签', 'type', 'category'] },
            { slot: 'url', patterns: ['链接', '网址', 'url', 'link'] },
            { slot: 'firstPage', patterns: ['起始页', '首页', 'first page', 'start page'] },
            { slot: 'lastPage', patterns: ['终止页', '末页', 'last page', 'end page'] },
            { slot: 'pageRange', patterns: ['页码范围', '页码', 'pages', 'page range'] },
            { slot: 'publicationDate', patterns: ['发表日期', '出版日期', 'publication date', 'publish date'] },
            { slot: 'publicationMonth', patterns: ['发表月份', '出版月份', 'publication month'] },
            { slot: 'publicationDay', patterns: ['发表日', '出版日', 'publication day'] },
            { slot: 'conferenceName', patterns: ['会议名称', 'conference name'] },
            { slot: 'conferenceLocation', patterns: ['会议地点', 'location', '地址'] },
            { slot: 'conferenceStartDate', patterns: ['会议开始日期', '开始日期', 'start date'] },
            { slot: 'conferenceEndDate', patterns: ['会议结束日期', '结束日期', 'end date'] },
            { slot: 'volume', patterns: ['卷号', 'volume'] },
            { slot: 'issue', patterns: ['期号', 'issue'] },
            { slot: 'volumeIssue', patterns: ['卷/期', '卷期'] },
            { slot: 'articleNumber', patterns: ['文章号', '文章编号', 'article number'] }
        ];
        this.valueLexicon = {
            '会议论文': ['conference', 'conferencepaper', 'proceedings', 'inproceedings'],
            '期刊论文': ['journal', 'journalarticle', 'article'],
            '特邀报告': ['invited', 'invitedtalk'],
            '分组报告': ['oral', 'talk', 'sessiontalk'],
            '墙报展示': ['poster'],
            '学位论文': ['thesis', 'phdthesis', 'mastersthesis'],
            '技术报告': ['technicalreport', 'techreport'],
            '数据集': ['dataset'],
            '专利': ['patent'],
            '著作章节': ['bookchapter', 'chapter'],
            '预印本': ['preprint', 'arxiv'],
            '中文': ['zh', 'chinese'],
            '英文': ['en', 'english', '外文'],
            '开放获取': ['openaccess', 'oa'],
            '非开放获取': ['closedaccess', 'nonopenaccess'],
            '是': ['yes', 'true'],
            '否': ['no', 'false']
        };
    }

    normalizeText(value) {
        return String(value || '')
            .toLowerCase()
            .replace(/[（）()\[\]{}:：,，;；"'“”‘’`~!@#$%^&*+=<>?/\\|_-]/g, ' ')
            .replace(/\s+/g, '')
            .trim();
    }

    canonicalizeValue(value) {
        const normalized = this.normalizeText(value);
        if (!normalized) return '';
        for (const [canonical, aliases] of Object.entries(this.valueLexicon)) {
            const normalizedAliases = [canonical, ...aliases].map(v => this.normalizeText(v));
            if (normalizedAliases.includes(normalized)) return canonical;
        }
        return String(value || '').trim();
    }

    buildFacts(paper, filledContext = {}) {
        const authors = Array.isArray(paper.authors) ? paper.authors : [];
        const authorAffiliations = Array.isArray(paper.authorAffiliations) ? paper.authorAffiliations : [];
        const keywords = Array.isArray(paper.keywords) ? paper.keywords : (paper.keywords ? String(paper.keywords).split(/[;,，；]/).map(s => s.trim()).filter(Boolean) : []);
        const type = this.inferPaperType(paper);
        const language = this.inferLanguage(paper);
        const openAccess = paper.openAccessPdf || paper.isOpenAccess ? '开放获取' : '';
        const volumeIssue = [paper.volume || '', paper.issue ? `(${paper.issue})` : ''].join('').trim();
        return {
            title: paper.title || '',
            doi: paper.doi || '',
            authors,
            authorsText: authors.join(', '),
            authorAffiliations,
            authorAffiliationsText: authorAffiliations.join('; '),
            year: paper.year || '',
            venue: paper.venueFormatted || paper.venue || '',
            venueRaw: paper.venueRaw || paper.venue || '',
            venueShort: paper.venueShort || '',
            abstract: paper.abstract || '',
            keywords,
            keywordsText: keywords.join('; '),
            citationCount: paper.citationCount != null ? String(paper.citationCount) : '',
            language,
            paperType: type,
            url: paper.url || '',
            firstPage: paper.firstPage || '',
            lastPage: paper.lastPage || '',
            pageRange: paper.pageRange || '',
            publicationDate: paper.publicationDate || '',
            publicationMonth: paper.publicationMonth || '',
            publicationDay: paper.publicationDay || '',
            conferenceName: paper.conferenceName || paper.conferenceTitle || '',
            conferenceLocation: paper.conferenceLocation || '',
            conferenceStartDate: paper.conferenceStartDate || '',
            conferenceEndDate: paper.conferenceEndDate || '',
            volume: paper.volume || '',
            issue: paper.issue || '',
            volumeIssue,
            articleNumber: paper.articleNumber || '',
            openAccess,
            source: paper.source || '',
            documentType: paper.documentType || '',
            extraContext: Object.fromEntries(Object.entries(filledContext || {}).map(([k, v]) => [k, v?.answer || '']))
        };
    }

    inferPaperType(paper) {
        const sourceType = this.normalizeText(paper.documentType || paper.type || '');
        const venue = this.normalizeText(paper.venueRaw || paper.venue || paper.conferenceName || '');
        const matchFromLexicon = (canonical) => {
            const aliases = this.valueLexicon[canonical] || [];
            return [canonical, ...aliases].some(item => {
                const key = this.normalizeText(item);
                return sourceType.includes(key) || venue.includes(key);
            });
        };
        if (matchFromLexicon('期刊论文')) return '期刊论文';
        if (matchFromLexicon('会议论文')) return '会议论文';
        if (matchFromLexicon('学位论文')) return '学位论文';
        if (matchFromLexicon('技术报告')) return '技术报告';
        if (matchFromLexicon('数据集')) return '数据集';
        if (matchFromLexicon('专利')) return '专利';
        if (matchFromLexicon('著作章节')) return '著作章节';
        if (matchFromLexicon('预印本')) return '预印本';
        return '';
    }

    inferLanguage(paper) {
        const code = this.normalizeText(paper.language || '');
        if (['zh', 'chinese', '中文'].includes(code)) return '中文';
        if (['en', 'english', '英文', '外文'].includes(code)) return '英文';
        const title = String(paper.title || '').trim();
        if (/[\u4e00-\u9fa5]/.test(title)) return '中文';
        if (title) return '英文';
        return '';
    }

    normalizeFieldIntent(field) {
        const rawText = [field.label, field.name, field.placeholder, field.description].filter(Boolean).join(' ');
        const normalized = this.normalizeText(rawText);
        let slot = 'unknown';
        let bestScore = -1;
        for (const rule of this.slotRules) {
            const score = rule.patterns.reduce((sum, pattern) => {
                const token = this.normalizeText(pattern);
                return sum + (normalized.includes(token) ? token.length : 0);
            }, 0);
            if (score > bestScore) {
                bestScore = score;
                slot = rule.slot;
            }
        }
        return {
            field,
            slot: bestScore > 0 ? slot : 'unknown',
            text: rawText,
            normalizedText: normalized,
            hasOptions: Array.isArray(field.options) && field.options.length > 0,
            isChoice: ['select', 'radio', 'checkbox'].includes(String(field.type || '').toLowerCase()),
            isLongText: ['textarea'].includes(String(field.type || '').toLowerCase()) || normalized.includes(this.normalizeText('简介')) || normalized.includes(this.normalizeText('摘要')),
            isTableField: Boolean(field.isTableField)
        };
    }

    makeDirectValue(intent, facts) {
        const bySlot = {
            title: { value: facts.title, keys: ['title'], confidence: 0.99 },
            doi: { value: facts.doi, keys: ['doi'], confidence: 0.99 },
            authors: { value: facts.authorsText, keys: ['authors'], confidence: 0.96 },
            authorAffiliations: { value: facts.authorAffiliationsText, keys: ['authorAffiliations'], confidence: 0.9 },
            year: { value: facts.year, keys: ['year'], confidence: 0.99 },
            venue: { value: facts.venue, keys: ['venue'], confidence: 0.95 },
            venueShort: { value: facts.venueShort, keys: ['venueShort'], confidence: 0.95 },
            abstract: { value: facts.abstract, keys: ['abstract'], confidence: 0.96 },
            keywords: { value: facts.keywordsText, keys: ['keywords'], confidence: 0.94 },
            citationCount: { value: facts.citationCount, keys: ['citationCount'], confidence: 0.95 },
            language: { value: facts.language, keys: ['language'], confidence: 0.92 },
            paperType: { value: facts.paperType, keys: ['paperType', 'documentType', 'venueRaw'], confidence: facts.paperType ? 0.9 : 0 },
            url: { value: facts.url, keys: ['url'], confidence: 0.98 },
            firstPage: { value: facts.firstPage, keys: ['firstPage'], confidence: 0.95 },
            lastPage: { value: facts.lastPage, keys: ['lastPage'], confidence: 0.95 },
            pageRange: { value: facts.pageRange, keys: ['pageRange'], confidence: 0.95 },
            publicationDate: { value: facts.publicationDate, keys: ['publicationDate'], confidence: 0.95 },
            publicationMonth: { value: facts.publicationMonth, keys: ['publicationMonth'], confidence: 0.95 },
            publicationDay: { value: facts.publicationDay, keys: ['publicationDay'], confidence: 0.95 },
            conferenceName: { value: facts.conferenceName || facts.venueRaw, keys: ['conferenceName', 'venueRaw'], confidence: facts.conferenceName ? 0.94 : 0.75 },
            conferenceLocation: { value: facts.conferenceLocation, keys: ['conferenceLocation'], confidence: 0.9 },
            conferenceStartDate: { value: facts.conferenceStartDate, keys: ['conferenceStartDate'], confidence: 0.92 },
            conferenceEndDate: { value: facts.conferenceEndDate, keys: ['conferenceEndDate'], confidence: 0.92 },
            volume: { value: facts.volume, keys: ['volume'], confidence: 0.93 },
            issue: { value: facts.issue, keys: ['issue'], confidence: 0.93 },
            volumeIssue: { value: facts.volumeIssue, keys: ['volume', 'issue'], confidence: 0.93 },
            articleNumber: { value: facts.articleNumber, keys: ['articleNumber'], confidence: 0.9 }
        };
        if (intent.slot === 'summary') {
            const summary = facts.abstract ? String(facts.abstract).replace(/\s+/g, ' ').trim().slice(0, 180) : '';
            return { value: summary, keys: ['abstract'], confidence: summary ? 0.72 : 0 };
        }
        return bySlot[intent.slot] || { value: '', keys: [], confidence: 0 };
    }

    matchOption(options, rawCandidate, fieldType = 'select') {
        if (!rawCandidate) return null;
        const optionList = Array.isArray(options) ? options : [];
        const candidates = Array.isArray(rawCandidate) ? rawCandidate : [rawCandidate];
        const normalizedCandidates = candidates
            .map(value => [String(value).trim(), this.canonicalizeValue(value)])
            .flat()
            .filter(Boolean);

        const scoreOption = (option, candidate) => {
            const optionText = this.normalizeText(option.text || option.value || '');
            const optionValue = this.normalizeText(option.value || '');
            const target = this.normalizeText(candidate);
            if (!target) return 0;
            if (optionText === target || optionValue === target) return 200;
            if (optionText.includes(target) || target.includes(optionText)) return 120;
            if (optionValue && (optionValue.includes(target) || target.includes(optionValue))) return 110;
            return 0;
        };

        if (String(fieldType).toLowerCase() === 'checkbox') {
            const matched = [];
            for (const candidate of normalizedCandidates) {
                const best = optionList
                    .map(option => ({ option, score: scoreOption(option, candidate) }))
                    .filter(item => item.score > 0)
                    .sort((a, b) => b.score - a.score)[0];
                if (best && !matched.find(item => item.value === (best.option.value || best.option.text))) {
                    matched.push({
                        value: best.option.value || best.option.text,
                        text: best.option.text || best.option.value
                    });
                }
            }
            if (!matched.length) return null;
            return {
                fillValue: matched.map(item => item.value),
                answerText: matched.map(item => item.text).join('；'),
                confidence: matched.length === normalizedCandidates.length ? 0.9 : 0.72
            };
        }

        let bestMatch = null;
        for (const candidate of normalizedCandidates) {
            const current = optionList
                .map(option => ({ option, score: scoreOption(option, candidate) }))
                .filter(item => item.score > 0)
                .sort((a, b) => b.score - a.score)[0];
            if (current && (!bestMatch || current.score > bestMatch.score)) {
                bestMatch = current;
            }
        }
        if (!bestMatch) return null;
        return {
            fillValue: bestMatch.option.value || bestMatch.option.text,
            answerText: bestMatch.option.text || bestMatch.option.value,
            confidence: bestMatch.score >= 200 ? 0.96 : 0.82
        };
    }

    buildRulePlanItem(intent, facts) {
        const field = intent.field;
        if (intent.isTableField) {
            return {
                fieldName: field.name,
                fieldLabel: field.label || field.name,
                proposedValue: '',
                fillValue: '',
                sourceFactKeys: [],
                confidence: 0,
                reason: '表格字段留给原有表格流程处理',
                needsApi: false,
                needsHuman: false,
                deferred: true
            };
        }

        const direct = this.makeDirectValue(intent, facts);
        if (!direct.value) {
            return {
                fieldName: field.name,
                fieldLabel: field.label || field.name,
                proposedValue: '',
                fillValue: '',
                sourceFactKeys: [],
                confidence: 0,
                reason: '规则层未找到直接可用事实',
                needsApi: intent.slot !== 'unknown',
                needsHuman: false,
                deferred: true
            };
        }

        if (intent.isChoice && intent.hasOptions) {
            const matched = this.matchOption(field.options, direct.value, field.type);
            if (!matched) {
                return {
                    fieldName: field.name,
                    fieldLabel: field.label || field.name,
                    proposedValue: '',
                    fillValue: '',
                    sourceFactKeys: direct.keys,
                    confidence: 0,
                    reason: '规则层找到了事实，但没有命中真实选项',
                    needsApi: false,
                    needsHuman: true,
                    deferred: true
                };
            }
            return {
                fieldName: field.name,
                fieldLabel: field.label || field.name,
                proposedValue: matched.answerText,
                fillValue: matched.fillValue,
                sourceFactKeys: direct.keys,
                confidence: Math.min(0.98, Math.max(direct.confidence, matched.confidence)),
                reason: '规则层直接命中真实选项',
                needsApi: false,
                needsHuman: false,
                deferred: false
            };
        }

        return {
            fieldName: field.name,
            fieldLabel: field.label || field.name,
            proposedValue: direct.value,
            fillValue: direct.value,
            sourceFactKeys: direct.keys,
            confidence: direct.confidence,
            reason: '规则层直接映射',
            needsApi: false,
            needsHuman: false,
            deferred: false
        };
    }

    shouldAskLLM(intent, planItem) {
        if (!this.llmClient) return false;
        if (intent.isTableField) return false;
        if (!planItem.deferred) return false;
        if (intent.isChoice && !intent.hasOptions) return false;
        return intent.slot !== 'unknown' || intent.isLongText || intent.hasOptions;
    }

    async resolveWithLLM(facts, intents, existingPlan) {
        if (!this.llmClient || !intents.length) return [];
        const fields = intents.map(intent => ({
            fieldName: intent.field.name,
            fieldLabel: intent.field.label || intent.field.name,
            fieldType: intent.field.type || 'text',
            slotGuess: intent.slot,
            options: Array.isArray(intent.field.options) ? intent.field.options.map(opt => ({
                text: opt.text || opt.value || '',
                value: opt.value || opt.text || ''
            })) : []
        }));
        const factKeys = Object.keys(facts).filter(key => key !== 'extraContext');
        const prompt = `你是一个整表映射规划器。你的任务不是直接操作表单，而是根据给定论文事实，为下列表单字段生成候选值计划。

可用事实键：
${JSON.stringify(factKeys, null, 2)}

论文事实：
${JSON.stringify(facts, null, 2)}

待决策字段：
${JSON.stringify(fields, null, 2)}

要求：
1. 只能使用上面提供的事实，禁止编造新事实。
2. 如果字段是 select/radio/checkbox，proposedValue 必须来自该字段真实 options。
3. 每条决策都必须给出 sourceFactKeys。
4. confidence 取 0 到 1 之间的小数。
5. 如果无法可靠判断，needsHuman 设为 true，proposedValue 设为空字符串。
6. 只输出 JSON 数组，不要输出额外说明。

输出格式：
[
  {
    "fieldName": "xxx",
    "proposedValue": "xxx",
    "sourceFactKeys": ["title"],
    "confidence": 0.9,
    "reason": "xxx",
    "needsApi": false,
    "needsHuman": false
  }
]`;
        try {
            const raw = await this.llmClient.think([{ role: 'user', content: prompt }], 0);
            const parsed = JSON.parse(String(raw || '').trim().replace(/```json\n?|```/g, ''));
            if (!Array.isArray(parsed)) return [];
            return parsed.map(item => {
                const field = intents.find(intent => intent.field.name === item.fieldName)?.field;
                if (!field) return null;
                const base = {
                    fieldName: field.name,
                    fieldLabel: field.label || field.name,
                    proposedValue: String(item.proposedValue || '').trim(),
                    fillValue: String(item.proposedValue || '').trim(),
                    sourceFactKeys: Array.isArray(item.sourceFactKeys) ? item.sourceFactKeys : [],
                    confidence: Number(item.confidence) || 0,
                    reason: String(item.reason || 'LLM 规划'),
                    needsApi: Boolean(item.needsApi),
                    needsHuman: Boolean(item.needsHuman),
                    deferred: Boolean(item.needsHuman) || !String(item.proposedValue || '').trim()
                };
                if (['select', 'radio', 'checkbox'].includes(String(field.type || '').toLowerCase()) && Array.isArray(field.options) && field.options.length) {
                    const matched = this.matchOption(field.options, base.proposedValue, field.type);
                    if (!matched) {
                        return { ...base, proposedValue: '', fillValue: '', confidence: 0, needsHuman: true, deferred: true, reason: 'LLM 提议未命中真实选项' };
                    }
                    return { ...base, proposedValue: matched.answerText, fillValue: matched.fillValue, confidence: Math.max(base.confidence, matched.confidence), deferred: false };
                }
                return base;
            }).filter(Boolean);
        } catch (error) {
            console.warn('WholeFormPlanner LLM 规划失败:', error);
            return [];
        }
    }

    mergePlans(rulePlans, llmPlans) {
        const merged = new Map(rulePlans.map(item => [item.fieldName, item]));
        for (const item of llmPlans) {
            const current = merged.get(item.fieldName);
            if (!current || (current.deferred && item.confidence > current.confidence)) {
                merged.set(item.fieldName, item);
            }
        }
        return Array.from(merged.values());
    }

    async createPlan({ paper, filledContext = {}, fields = [] }) {
        const facts = this.buildFacts(paper, filledContext);
        const intents = fields.map(field => this.normalizeFieldIntent(field));
        const rulePlans = intents.map(intent => this.buildRulePlanItem(intent, facts));
        const unresolvedIntents = intents.filter(intent => {
            const plan = rulePlans.find(item => item.fieldName === intent.field.name);
            return this.shouldAskLLM(intent, plan);
        });
        const llmPlans = await this.resolveWithLLM(facts, unresolvedIntents, rulePlans);
        const merged = this.mergePlans(rulePlans, llmPlans);
        return {
            facts,
            plans: merged,
            autoFillThreshold: this.autoFillThreshold
        };
    }
}

export { WholeFormPlanner };
