import { FIELD_ONTOLOGY } from './field_ontology.js';
import { FIELD_ALIASES } from './field_aliases.js';
import { CANDIDATE_SOURCE_MAP } from './candidate_sources.js';
import { flattenTextValue, normalizeSemanticText, splitList, coerceDateParts, validateValueByType } from './validators.js';

class DateResolver {
    buildDateView(rawValue, fallbackYear = '') {
        const parts = coerceDateParts(rawValue);
        if (!parts.year && fallbackYear) return { ...parts, year: String(fallbackYear).trim() };
        return parts;
    }
}

class FactNormalizer {
    constructor() { this.dateResolver = new DateResolver(); }
    createRecord(path, value, semanticType, source = 'paper', confidence = 0.9, completeness = 1) {
        return { path, value, semanticType, source, confidence, completeness };
    }
    normalizeLanguage(value, title = '') {
        const raw = normalizeSemanticText(value);
        if (['zh', 'chinese', '中文'].includes(raw)) return '中文';
        if (['en', 'english', '英文', '外文'].includes(raw)) return '英文';
        if (/[\u4e00-\u9fa5]/.test(String(title || ''))) return '中文';
        if (title) return '英文';
        return '';
    }
    inferDocumentType(paper) {
        const rawHints = [paper?.paperType, paper?.documentType, paper?.type, paper?.sourceType].map(item => normalizeSemanticText(item)).filter(Boolean).join(' ');
        const venue = normalizeSemanticText(paper?.venueRaw || paper?.venue || '');
        if (rawHints.includes(normalizeSemanticText('期刊论文')) || /(article|journal)/.test(rawHints)) return '期刊论文';
        if (rawHints.includes(normalizeSemanticText('会议论文')) || /(conference|proceedings|inproceedings|meeting|symposium|workshop)/.test(rawHints)) return '会议论文';
        if (rawHints.includes(normalizeSemanticText('学位论文')) || /thesis/.test(rawHints)) return '学位论文';
        if (rawHints.includes(normalizeSemanticText('专利')) || /patent/.test(rawHints)) return '专利';
        if (rawHints.includes(normalizeSemanticText('数据集')) || /dataset/.test(rawHints)) return '数据集';
        if (rawHints.includes(normalizeSemanticText('预印本')) || /(preprint|arxiv)/.test(rawHints)) return '预印本';
        if (/(journal|transactions|letters|review|management|science)/.test(venue)) return '期刊论文';
        if (/(conference|symposium|workshop|proceedings)/.test(venue)) return '会议论文';
        return '';
    }
    flattenFunding(value) {
        if (!value) return '';
        const items = Array.isArray(value) ? value : [value];
        return items.map(item => {
            if (!item) return '';
            if (typeof item === 'string') return item.trim();
            if (typeof item !== 'object') return String(item).trim();
            return [flattenTextValue(item.funder), flattenTextValue(item.agency), flattenTextValue(item.awardId), flattenTextValue(item.award_id), flattenTextValue(item.grantId), flattenTextValue(item.grant_id)].filter(Boolean).join(' / ');
        }).filter(Boolean).join('；');
    }
    normalize({ paper, filledContext = {}, discoveryCache = {} }) {
        const base = paper || {};
        const authorEntries = (Array.isArray(base.authorEntries) ? base.authorEntries : []).map((entry, index) => {
            const name = flattenTextValue(entry?.fullName || entry?.name);
            const affiliations = Array.isArray(entry?.affiliations)
                ? entry.affiliations.map(item => flattenTextValue(item)).filter(Boolean)
                : splitList(entry?.affiliationText || entry?.affiliation);
            return {
                name,
                affiliation: affiliations.join('；'),
                affiliations,
                seqNo: flattenTextValue(entry?.seqNo || index + 1),
                orcid: flattenTextValue(entry?.orcid),
                researcherId: flattenTextValue(entry?.researcherId),
                reprint: entry?.reprint === true
            };
        }).filter(entry => entry.name);
        const authors = authorEntries.length ? authorEntries.map(item => item.name) : splitList(base.authors);
        const authorAffiliations = authorEntries.length
            ? authorEntries.map(item => item.affiliation).filter(Boolean)
            : splitList(base.authorAffiliations);
        const organizers = splitList(base.organizers);
        const keywords = splitList(base.keywords);
        const publicationDate = this.dateResolver.buildDateView(base.publicationDate, base.year || '');
        const conferenceEventDate = this.dateResolver.buildDateView(base.conferenceEventDate, base.year || '');
        const conferenceStart = this.dateResolver.buildDateView(base.conferenceStartDate, base.year || '');
        const conferenceEnd = this.dateResolver.buildDateView(base.conferenceEndDate, base.year || '');
        const paperType = this.inferDocumentType(base);
        const isConferencePaper = paperType === '会议论文';
        const fundingText = flattenTextValue(base.fundingText) || this.flattenFunding(base.funding || base.grants);
        const indexing = splitList(base.indexing || base.indexings || base.indexedBy);
        const notesText = flattenTextValue(base.notes || base.note);
        const facts = {
            paper: {
                title: flattenTextValue(base.title), doi: flattenTextValue(base.doi), abstract: flattenTextValue(base.abstract), keywords,
                keywordsText: keywords.join('；'), citationCount: base.citationCount != null ? String(base.citationCount).trim() : '',
                url: flattenTextValue(base.url), language: this.normalizeLanguage(base.language, base.title), type: paperType,
                presentationType: flattenTextValue(base.presentationType), fundingText
            },
            publication: {
                venue: flattenTextValue(base.venueFormatted || base.venue), venueRaw: flattenTextValue(base.venueRaw || base.venue), venueShort: flattenTextValue(base.venueShort),
                date: publicationDate,
                pages: { first: flattenTextValue(base.firstPage), last: flattenTextValue(base.lastPage), range: flattenTextValue(base.pageRange) },
                volume: flattenTextValue(base.volume), issue: flattenTextValue(base.issue),
                volumeIssue: [flattenTextValue(base.volume), base.issue ? `(${flattenTextValue(base.issue)})` : ''].join('').trim(),
                articleNumber: flattenTextValue(base.articleNumber), indexing, indexingText: indexing.join('；')
            },
            conference: {
                name: isConferencePaper ? flattenTextValue(base.conferenceName || base.conferenceTitle) : '',
                shortName: isConferencePaper ? flattenTextValue(base.venueShort) : '',
                location: isConferencePaper ? flattenTextValue(base.conferenceLocation) : '',
                organizers, organizersText: isConferencePaper ? organizers.join('；') : '',
                eventDate: isConferencePaper ? conferenceEventDate : this.dateResolver.buildDateView('', ''),
                start: isConferencePaper ? conferenceStart : this.dateResolver.buildDateView('', ''),
                end: isConferencePaper ? conferenceEnd : this.dateResolver.buildDateView('', '')
            },
            authors: {
                names: authors,
                namesText: authors.join(', '),
                affiliations: authorAffiliations,
                affiliationsText: authorAffiliations.join('；'),
                entries: authorEntries.length ? authorEntries : authors.map((name, index) => ({ name, affiliation: authorAffiliations[index] || '' }))
            },
            narrative: { notesText },
            extraContext: Object.fromEntries(Object.entries(filledContext || {}).map(([key, value]) => [key, flattenTextValue(value?.answer || '')])),
            discoveryCache: discoveryCache || {}
        };
        const factIndex = [];
        const push = (path, value, semanticType, source = 'paper', confidence = 0.9, completeness = 1) => {
            if (value == null) return;
            if (Array.isArray(value)) { if (!value.length) return; factIndex.push(this.createRecord(path, value, semanticType, source, confidence, completeness)); return; }
            if (flattenTextValue(value) === '') return;
            factIndex.push(this.createRecord(path, value, semanticType, source, confidence, completeness));
        };
        push('paper.title', facts.paper.title, 'title_text');
        push('paper.doi', facts.paper.doi, 'identifier');
        push('paper.abstract', facts.paper.abstract, 'long_text');
        push('paper.keywords', facts.paper.keywords, 'keyword_list');
        push('paper.keywordsText', facts.paper.keywordsText, 'keyword_list');
        push('paper.citationCount', facts.paper.citationCount, 'number');
        push('paper.url', facts.paper.url, 'url');
        push('paper.language', facts.paper.language, 'language');
        push('paper.type', facts.paper.type, 'document_type');
        push('paper.presentationType', facts.paper.presentationType, 'presentation_type');
        push('paper.fundingText', facts.paper.fundingText, 'funding_text');
        push('publication.venue', facts.publication.venue, 'venue_name');
        push('publication.venueRaw', facts.publication.venueRaw, 'venue_name');
        push('publication.venueShort', facts.publication.venueShort, 'short_name');
        push('publication.date.raw', facts.publication.date.raw, 'date');
        push('publication.date.year', facts.publication.date.year, 'year');
        push('publication.date.month', facts.publication.date.month, 'month');
        push('publication.date.day', facts.publication.date.day, 'day');
        push('publication.pages.first', facts.publication.pages.first, 'page_info');
        push('publication.pages.last', facts.publication.pages.last, 'page_info');
        push('publication.pages.range', facts.publication.pages.range, 'page_info');
        push('publication.volume', facts.publication.volume, 'number_text');
        push('publication.issue', facts.publication.issue, 'number_text');
        push('publication.volumeIssue', facts.publication.volumeIssue, 'text');
        push('publication.articleNumber', facts.publication.articleNumber, 'identifier');
        push('publication.indexing', facts.publication.indexing, 'indexing_list');
        push('publication.indexingText', facts.publication.indexingText, 'indexing_list');
        push('conference.name', facts.conference.name, 'event_name');
        push('conference.shortName', facts.conference.shortName, 'short_name');
        push('conference.location', facts.conference.location, 'place');
        push('conference.organizers', facts.conference.organizers, 'organization_or_person');
        push('conference.organizersText', facts.conference.organizersText, 'organization_or_person');
        push('conference.eventDate.raw', facts.conference.eventDate.raw, 'date');
        push('conference.eventDate.year', facts.conference.eventDate.year, 'year');
        push('conference.eventDate.month', facts.conference.eventDate.month, 'month');
        push('conference.eventDate.day', facts.conference.eventDate.day, 'day');
        push('conference.start.raw', facts.conference.start.raw, 'date');
        push('conference.start.year', facts.conference.start.year, 'year');
        push('conference.start.month', facts.conference.start.month, 'month');
        push('conference.start.day', facts.conference.start.day, 'day');
        push('conference.end.raw', facts.conference.end.raw, 'date');
        push('conference.end.year', facts.conference.end.year, 'year');
        push('conference.end.month', facts.conference.end.month, 'month');
        push('conference.end.day', facts.conference.end.day, 'day');
        push('authors.names', facts.authors.names, 'person_list');
        push('authors.namesText', facts.authors.namesText, 'person_list');
        push('authors.affiliations', facts.authors.affiliations, 'organization_list');
        push('authors.affiliationsText', facts.authors.affiliationsText, 'organization_list');
        push('paper.notesText', facts.narrative.notesText, 'note_text');
        return { ...facts, factIndex, byPath: Object.fromEntries(factIndex.map(item => [item.path, item])) };
    }
}

class FieldSemanticClassifier {
    constructor() {
        this.aliases = FIELD_ALIASES;
        this.sourceWeights = { label: 1, name: 0.72, placeholder: 0.28, description: 0.08 };
    }
    buildSemanticTextMap(field) {
        return { label: normalizeSemanticText(field.label || ''), name: normalizeSemanticText(field.name || ''), placeholder: normalizeSemanticText(field.placeholder || ''), description: normalizeSemanticText(field.description || '') };
    }
    scoreAlias(aliasEntry, textMap) {
        const negatives = (aliasEntry.negatives || []).map(item => normalizeSemanticText(item)).filter(Boolean);
        for (const negative of negatives) if (Object.values(textMap).some(text => text.includes(negative))) return 0;
        let score = 0;
        for (const alias of aliasEntry.aliases || []) {
            const token = normalizeSemanticText(alias);
            if (!token) continue;
            for (const [source, text] of Object.entries(textMap)) if (text && text.includes(token)) score += token.length * (this.sourceWeights[source] || 0.1);
        }
        return score * (aliasEntry.weight || 1);
    }
    classifyBoundary(matchedAlias, textMap) {
        if (matchedAlias?.boundary) return matchedAlias.boundary;
        const allText = `${textMap.label} ${textMap.name} ${textMap.placeholder} ${textMap.description}`;
        if (allText.includes(normalizeSemanticText('开始')) || allText.includes(normalizeSemanticText('起始')) || allText.includes('start') || allText.includes('from')) return 'start';
        if (allText.includes(normalizeSemanticText('结束')) || allText.includes(normalizeSemanticText('终止')) || allText.includes('end') || allText.includes('until') || allText.includes('to')) return 'end';
        return 'single';
    }
    classifyComponent(field, matchedAlias, textMap) {
        if (matchedAlias?.component) return matchedAlias.component;
        const domain = matchedAlias?.domain || '';
        const role = matchedAlias?.role || '';
        const allText = `${textMap.label} ${textMap.name} ${textMap.placeholder} ${textMap.description}`;
        if (domain === 'publication' && role === 'pages') {
            if (allText.includes(normalizeSemanticText('起始页码')) || allText.includes(normalizeSemanticText('首页')) || allText.includes('firstpage') || allText.includes('startpage')) return 'first';
            if (allText.includes(normalizeSemanticText('终止页码')) || allText.includes(normalizeSemanticText('末页')) || allText.includes('lastpage') || allText.includes('endpage')) return 'last';
            return 'range';
        }
        if (role === 'year') return 'year';
        if (role !== 'date') return 'full';
        if (allText.includes(normalizeSemanticText('年份')) || allText.includes(normalizeSemanticText('出版年')) || allText.endsWith('year')) return 'year';
        if (allText.includes(normalizeSemanticText('月份')) || allText.endsWith('month')) return 'month';
        if (allText.includes(normalizeSemanticText('开始月')) || allText.includes(normalizeSemanticText('结束月'))) return 'month';
        if (allText.includes(normalizeSemanticText('开始日')) || allText.includes(normalizeSemanticText('结束日')) || allText.endsWith('day')) return 'day';
        return 'full';
    }
    classifyExpectedType(domain, role, component) {
        const ontologyType = FIELD_ONTOLOGY?.[domain]?.roles?.[role]?.expectedValueType || 'text';
        if (component === 'year') return 'year';
        if (component === 'month') return 'month';
        if (component === 'day') return 'day';
        return ontologyType;
    }
    buildConstraints(field, fieldType, hasOptions, textMap) {
        const joined = `${textMap.label} ${textMap.name} ${textMap.placeholder} ${textMap.description}`;
        return {
            allowOverwrite: false,
            mustMatchOption: hasOptions,
            fieldType,
            requiredFormat: fieldType === 'url' ? 'url' : '',
            forbiddenKinds: [
                (joined.includes(normalizeSemanticText('地点')) || joined.includes(normalizeSemanticText('地址'))) ? 'event_name' : '',
                (joined.includes(normalizeSemanticText('地点')) || joined.includes(normalizeSemanticText('地址'))) ? 'organization_or_person' : '',
                (joined.includes(normalizeSemanticText('组织者')) || joined.includes(normalizeSemanticText('主办')) || joined.includes(normalizeSemanticText('承办'))) ? 'place' : '',
                (joined.includes(normalizeSemanticText('组织者')) || joined.includes(normalizeSemanticText('主办')) || joined.includes(normalizeSemanticText('承办'))) ? 'event_name' : ''
            ].filter(Boolean)
        };
    }
    classify(field) {
        const textMap = this.buildSemanticTextMap(field);
        const matchedAlias = this.aliases.map(item => ({ item, score: this.scoreAlias(item, textMap) })).filter(item => item.score > 0).sort((a, b) => b.score - a.score)[0]?.item || null;
        const domain = matchedAlias?.domain || 'narrative';
        const role = matchedAlias?.role || 'description';
        const boundary = this.classifyBoundary(matchedAlias, textMap);
        const component = this.classifyComponent(field, matchedAlias, textMap);
        const type = String(field.type || 'text').toLowerCase();
        const hasOptions = Array.isArray(field.options) && field.options.length > 0;
        const expectedValueType = this.classifyExpectedType(domain, role, component);
        let semanticKey = `${domain}.${role}`;
        if (domain === 'conference' && role === 'date') semanticKey = boundary === 'single' ? `conference.date.${component}` : `conference.date.${boundary}.${component}`;
        else if (domain === 'publication' && role === 'date') semanticKey = `publication.date.${component}`;
        else if (domain === 'publication' && role === 'pages') semanticKey = `publication.pages.${component}`;
        return { field, fieldName: field.name, label: field.label || field.name, type, domain, role, component, boundary, expectedValueType, options: field.options || [], hasOptions, isTableField: Boolean(field.isTableField), repeatedGroupKey: field.repeatedGroupKey || '', rowIndex: typeof field.rowIndex === 'number' ? field.rowIndex : null, constraints: this.buildConstraints(field, type, hasOptions, textMap), semanticKey };
    }
}

class LLMRanker {
    constructor(llmClient = null) { this.llmClient = llmClient; }
    async rank(intent, candidates) {
        if (!this.llmClient || !Array.isArray(candidates) || candidates.length < 2) return candidates[0] || null;
        const prompt = `你是字段候选排序器，只能在已有候选里选择一个最合适的值。\n字段语义：${JSON.stringify({ label: intent.label, domain: intent.domain, role: intent.role, component: intent.component, boundary: intent.boundary, expectedValueType: intent.expectedValueType, fieldType: intent.type, options: intent.options }, null, 2)}\n\n候选列表：\n${JSON.stringify(candidates.map((item, index) => ({ index, path: item.path, value: item.value, semanticType: item.semanticType, score: item.score, source: item.source })), null, 2)}\n\n要求：\n1. 只能从候选列表里选。\n2. 不要编造任何新值。\n3. 只输出 JSON，例如 {"index":0,"confidence":0.91,"reason":"...","needsHuman":false}`;
        try {
            const raw = await this.llmClient.think([{ role: 'user', content: prompt }], 0);
            const parsed = JSON.parse(String(raw || '').trim().replace(/```json\n?|```/g, ''));
            const picked = candidates[Number(parsed?.index)];
            if (!picked) return candidates[0] || null;
            return { ...picked, score: Math.max(picked.score, Number(parsed?.confidence) || picked.score), reason: String(parsed?.reason || picked.reason || 'LLM 排序'), needsHuman: Boolean(parsed?.needsHuman) };
        } catch (error) {
            console.warn('LLMRanker 排序失败:', error);
            return candidates[0] || null;
        }
    }
}

class ConstraintPlanner {
    constructor(llmClient = null) {
        this.autoFillThreshold = 0.88;
        this.llmRanker = new LLMRanker(llmClient);
        this.choiceLexicon = {
            中文: ['中文', 'Chinese', 'zh'], 英文: ['英文', 'English', 'en', '外文'], 会议论文: ['会议论文', 'conference paper', 'inproceedings', 'proceedings'],
            期刊论文: ['期刊论文', 'journal article', 'article', 'journal'], 学位论文: ['学位论文', 'thesis'], 技术报告: ['技术报告', 'technical report', 'tech report'],
            数据集: ['数据集', 'dataset'], 专利: ['专利', 'patent'], 著作章节: ['著作章节', 'book chapter', 'chapter'], 预印本: ['预印本', 'preprint'],
            开放获取: ['开放获取', 'open access', 'oa'], 非开放获取: ['非开放获取', 'closed access']
        };
    }
    getCandidatePaths(intent) { return CANDIDATE_SOURCE_MAP[intent.semanticKey] || CANDIDATE_SOURCE_MAP[`${intent.domain}.${intent.role}`] || []; }
    expandFactRecord(record) {
        if (Array.isArray(record.value) && record.semanticType === 'indexing_list') return [{ ...record, value: record.value }];
        if (Array.isArray(record.value)) return record.value.map(value => ({ ...record, value }));
        return [{ ...record, value: record.value }];
    }
    passesSemanticFilter(intent, candidate) {
        if (!candidate || candidate.value == null) return false;
        if (intent.constraints.forbiddenKinds.includes(candidate.semanticType)) return false;
        if (intent.domain === 'conference') {
            if (!candidate.path.startsWith('conference.')) return false;
            if (intent.role === 'organizer' && candidate.semanticType !== 'organization_or_person') return false;
            if (intent.role === 'location' && candidate.semanticType !== 'place') return false;
            if (intent.role === 'name' && candidate.semanticType !== 'event_name') return false;
        }
        if (intent.domain === 'publication' && intent.role === 'venue' && candidate.path.startsWith('conference.')) return false;
        if (intent.domain === 'publication' && intent.role === 'indexing' && candidate.semanticType !== 'indexing_list') return false;
        if (intent.domain === 'paper' && intent.role === 'type' && candidate.semanticType !== 'document_type') return false;
        if (intent.domain === 'paper' && intent.role === 'presentationType' && candidate.semanticType !== 'presentation_type') return false;
        return validateValueByType(intent.expectedValueType, candidate.value, intent.component);
    }
    normalizeChoiceValue(value) {
        const raw = flattenTextValue(value);
        const normalized = normalizeSemanticText(raw);
        for (const [canonical, aliases] of Object.entries(this.choiceLexicon)) {
            const targets = [canonical, ...aliases].map(item => normalizeSemanticText(item));
            if (targets.includes(normalized)) return canonical;
        }
        return raw;
    }
    toChoiceList(value) {
        if (Array.isArray(value)) return value.map(item => this.normalizeChoiceValue(item)).filter(Boolean);
        return splitList(value).map(item => this.normalizeChoiceValue(item)).filter(Boolean);
    }
    scoreOption(option, candidate) {
        const optionText = normalizeSemanticText(option.text || option.value || '');
        const optionValue = normalizeSemanticText(option.value || '');
        const target = normalizeSemanticText(candidate);
        if (!target) return 0;
        if (optionText === target || optionValue === target) return 1;
        if (optionText && (optionText.includes(target) || target.includes(optionText))) return 0.82;
        if (optionValue && (optionValue.includes(target) || target.includes(optionValue))) return 0.75;
        return 0;
    }
    resolveOptionWriteValue(intent, option) {
        if (intent.type === 'checkbox' || intent.type === 'radio') return option.text || option.value || '';
        const rawValue = String(option.value || '').trim().toLowerCase();
        if (!rawValue || ['on', 'true', 'false'].includes(rawValue)) return option.text || option.value || '';
        return option.value || option.text || '';
    }
    matchOptions(intent, candidateValue) {
        const options = Array.isArray(intent.options) ? intent.options : [];
        if (!intent.hasOptions || !options.length) return null;
        const values = this.toChoiceList(candidateValue);
        if (!values.length) return null;
        if (intent.type === 'checkbox') {
            const matched = [];
            for (const value of values) {
                const best = options.map(option => ({ option, score: this.scoreOption(option, value) })).filter(item => item.score > 0).sort((a, b) => b.score - a.score)[0];
                if (!best) continue;
                const writeValue = this.resolveOptionWriteValue(intent, best.option);
                if (!writeValue) continue;
                if (!matched.find(item => item.writeValue === writeValue)) matched.push({ writeValue, text: best.option.text || best.option.value || writeValue, score: best.score });
            }
            if (!matched.length) return null;
            return { fillValue: matched.map(item => item.writeValue), proposedValue: matched.map(item => item.text).join('；'), optionScore: matched.reduce((sum, item) => sum + item.score, 0) / matched.length };
        }
        const best = values.map(value => options.map(option => ({ option, score: this.scoreOption(option, value) })).filter(item => item.score > 0).sort((a, b) => b.score - a.score)[0]).filter(Boolean).sort((a, b) => b.score - a.score)[0];
        if (!best) return null;
        return { fillValue: this.resolveOptionWriteValue(intent, best.option), proposedValue: best.option.text || best.option.value || '', optionScore: best.score };
    }
    scoreCandidate(intent, candidate) {
        let score = 0.48;
        if (candidate.semanticType === intent.expectedValueType) score += 0.22;
        if (intent.domain === 'conference' && candidate.path.startsWith('conference.')) score += 0.2;
        if (intent.domain === 'publication' && candidate.path.startsWith('publication.')) score += 0.2;
        if (intent.domain === 'paper' && candidate.path.startsWith('paper.')) score += 0.2;
        if (intent.domain === 'author' && candidate.path.startsWith('authors.')) score += 0.2;
        score += Math.min(0.05, (candidate.completeness || 0) * 0.05);
        score += Math.min(0.05, (candidate.confidence || 0) * 0.05);
        return Math.min(0.99, score);
    }
    collectCandidates(intent, facts) {
        const paths = this.getCandidatePaths(intent);
        const candidates = [];
        for (const path of paths) {
            const record = facts.byPath[path];
            if (!record) continue;
            for (const expanded of this.expandFactRecord(record)) {
                if (!this.passesSemanticFilter(intent, expanded)) continue;
                candidates.push({ ...expanded, score: this.scoreCandidate(intent, expanded), reason: `候选来自 ${path}` });
            }
        }
        return candidates.sort((a, b) => b.score - a.score);
    }
    buildDeferredPlan(intent, reason, needsHuman = false) {
        return { fieldName: intent.fieldName, fieldLabel: intent.label, proposedValue: '', fillValue: '', sourceFactKeys: [], confidence: 0, reason, needsApi: false, needsHuman, deferred: true, semantics: intent };
    }
    async planOne(intent, facts) {
        if (intent.isTableField) return this.buildDeferredPlan(intent, '表格字段保留给原有表格流程处理');
        if (intent.domain === 'conference' && facts.paper?.type !== '会议论文') return this.buildDeferredPlan(intent, '当前成果不是会议论文，会议字段不进入快速自动填写');
        if (intent.domain === 'paper' && intent.role === 'presentationType') return this.buildDeferredPlan(intent, '展示或报告类别需要基于页面选项人工确认', true);
        if (intent.domain === 'author' && intent.role === 'affiliations' && Array.isArray(facts.authors?.affiliations) && facts.authors.affiliations.length > 1) return this.buildDeferredPlan(intent, '作者单位是多值结构，保留给作者表格或逐字段流程处理', true);
        const candidates = this.collectCandidates(intent, facts);
        if (!candidates.length) return this.buildDeferredPlan(intent, '没有找到满足约束的候选事实', true);
        const topCandidates = candidates.slice(0, 3);
        const resolvedCandidate = topCandidates.length > 1 && Math.abs(topCandidates[0].score - topCandidates[1].score) < 0.08 ? await this.llmRanker.rank(intent, topCandidates) : topCandidates[0];
        if (!resolvedCandidate || resolvedCandidate.needsHuman) return this.buildDeferredPlan(intent, resolvedCandidate?.reason || '候选冲突，等待人工确认', true);
        let fillValue = resolvedCandidate.value;
        let proposedValue = Array.isArray(fillValue) ? fillValue.map(item => flattenTextValue(item)).filter(Boolean).join('；') : flattenTextValue(fillValue);
        let confidence = resolvedCandidate.score;
        if (intent.hasOptions) {
            const matched = this.matchOptions(intent, fillValue);
            if (!matched) return this.buildDeferredPlan(intent, '候选值未命中字段真实选项', true);
            fillValue = matched.fillValue;
            proposedValue = matched.proposedValue;
            confidence = Math.max(confidence, matched.optionScore);
        }
        return { fieldName: intent.fieldName, fieldLabel: intent.label, proposedValue, fillValue, sourceFactKeys: [resolvedCandidate.path], confidence, reason: resolvedCandidate.reason, needsApi: false, needsHuman: false, deferred: confidence < this.autoFillThreshold, semantics: intent };
    }
    async createPlan(intents, facts) {
        const plans = [];
        for (const intent of intents) plans.push(await this.planOne(intent, facts));
        return { facts, plans, autoFillThreshold: this.autoFillThreshold };
    }
}

class WholeFormPlanner {
    constructor(llmClient = null) { this.factNormalizer = new FactNormalizer(); this.fieldClassifier = new FieldSemanticClassifier(); this.constraintPlanner = new ConstraintPlanner(llmClient); }
    buildTypedFacts({ paper, filledContext = {}, discoveryCache = {} }) { return this.factNormalizer.normalize({ paper, filledContext, discoveryCache }); }
    classifyFields(fields = []) { return fields.map(field => this.fieldClassifier.classify(field)); }
    async createPlan({ paper = null, facts = null, filledContext = {}, discoveryCache = {}, fields = [] }) {
        const typedFacts = facts || this.buildTypedFacts({ paper, filledContext, discoveryCache });
        const intents = this.classifyFields(fields);
        return this.constraintPlanner.createPlan(intents, typedFacts);
    }
}

function buildTypedFacts(input) {
    const planner = new WholeFormPlanner(null);
    return planner.buildTypedFacts(input);
}

export { WholeFormPlanner, buildTypedFacts, FactNormalizer, FieldSemanticClassifier, ConstraintPlanner, DateResolver };
