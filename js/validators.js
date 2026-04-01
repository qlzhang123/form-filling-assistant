function isPrimitiveTextCandidate(value) {
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function flattenTextValueInternal(value, seen, depth) {
    if (value == null || depth > 5) return '';

    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);

    if (Array.isArray(value)) {
        const pieces = value
            .map(item => flattenTextValueInternal(item, seen, depth + 1))
            .filter(Boolean);
        return Array.from(new Set(pieces)).join('；');
    }

    if (typeof value === 'object') {
        if (seen.has(value)) return '';
        seen.add(value);

        const directKeys = [
            'content',
            'text',
            'label',
            'title',
            'name',
            'display_name',
            'full_name',
            'fullName'
        ];

        for (const key of directKeys) {
            if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
            const direct = value[key];
            if (isPrimitiveTextCandidate(direct)) {
                const text = String(direct).trim();
                if (text) return text;
            }
        }

        if (Object.prototype.hasOwnProperty.call(value, 'value')) {
            const nested = flattenTextValueInternal(value.value, seen, depth + 1);
            if (nested) return nested;
        }

        const pieces = Object.values(value)
            .map(item => flattenTextValueInternal(item, seen, depth + 1))
            .filter(Boolean);
        return Array.from(new Set(pieces)).join('；');
    }

    return String(value).trim();
}

export function flattenTextValue(value) {
    return flattenTextValueInternal(value, new WeakSet(), 0);
}

export function normalizeSemanticText(value) {
    return flattenTextValue(value)
        .toLowerCase()
        .replace(/[（）()\[\]{}:：;；,.，。'"“”‘’`~!@#$%^&*+=<>?/\\|_-]/g, ' ')
        .replace(/\s+/g, '')
        .trim();
}

export function splitList(value) {
    if (Array.isArray(value)) {
        return value
            .map(item => flattenTextValue(item))
            .flatMap(item => item.split(/[;,，；\n\t]+/))
            .map(item => item.trim())
            .filter(Boolean);
    }

    return flattenTextValue(value)
        .split(/[;,，；\n\t]+/)
        .map(item => item.trim())
        .filter(Boolean);
}

export function isYearValue(value) {
    return /^\d{4}$/.test(String(value || '').trim());
}

export function isMonthValue(value) {
    const raw = String(value || '').trim();
    if (!/^\d{1,2}$/.test(raw)) return false;
    const num = Number(raw);
    return num >= 1 && num <= 12;
}

export function isDayValue(value) {
    const raw = String(value || '').trim();
    if (!/^\d{1,2}$/.test(raw)) return false;
    const num = Number(raw);
    return num >= 1 && num <= 31;
}

export function isUrlValue(value) {
    try {
        const url = new URL(String(value || '').trim());
        return /^https?:$/i.test(url.protocol);
    } catch {
        return false;
    }
}

function hasYearToken(text) {
    return /\b(19|20)\d{2}\b/.test(text) || /\d{4}/.test(text);
}

function looksLikeEnglishPlace(text) {
    if (!text) return false;
    if (hasYearToken(text)) return false;
    if (/\b(city|province|country|district|street|road|avenue|campus|park|hall|hotel|center|centre)\b/i.test(text)) {
        return true;
    }
    if (/,/.test(text)) return true;
    return /^[A-Z][A-Za-z.' -]{2,}(?:\s+[A-Z][A-Za-z.' -]{2,})*$/.test(text);
}

export function looksLikePlace(value) {
    const text = flattenTextValue(value);
    if (!text || hasYearToken(text)) return false;
    if (/[省市区县路街道国镇乡村湾港州馆楼园厅]/.test(text)) return true;
    return looksLikeEnglishPlace(text);
}

export function looksLikePersonName(value) {
    const text = flattenTextValue(value);
    if (!text || hasYearToken(text)) return false;
    if (/^[\u4e00-\u9fa5]{2,6}$/.test(text)) return true;
    return /^[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3}$/.test(text);
}

export function looksLikeOrganization(value) {
    const text = flattenTextValue(value);
    if (!text || hasYearToken(text)) return false;
    const normalized = normalizeSemanticText(text);
    return [
        'university',
        'institute',
        'association',
        'society',
        'committee',
        'college',
        'laboratory',
        'lab',
        'center',
        'centre',
        'academy',
        'press',
        '大学',
        '学院',
        '研究所',
        '实验室',
        '委员会',
        '学会',
        '协会',
        '中心',
        '研究院',
        '出版社'
    ].some(token => normalized.includes(normalizeSemanticText(token)));
}

export function looksLikeOrganizationOrPerson(value) {
    const text = flattenTextValue(value);
    if (!text || hasYearToken(text)) return false;
    if (/[;；]/.test(text)) {
        return text
            .split(/[;；]/)
            .map(item => item.trim())
            .filter(Boolean)
            .every(item => looksLikeOrganization(item) || looksLikePersonName(item));
    }
    return looksLikeOrganization(text) || looksLikePersonName(text);
}

export function coerceDateParts(rawValue) {
    const raw = flattenTextValue(rawValue);
    if (!raw) {
        return { raw: '', year: '', month: '', day: '' };
    }

    const normalized = raw
        .replace(/年/g, '-')
        .replace(/月/g, '-')
        .replace(/[日号]/g, '')
        .replace(/[./]/g, '-')
        .replace(/\s+/g, ' ')
        .trim();

    const fullMatch = normalized.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (fullMatch) {
        return {
            raw,
            year: fullMatch[1],
            month: fullMatch[2].padStart(2, '0'),
            day: fullMatch[3].padStart(2, '0')
        };
    }

    const parts = normalized.split('-').map(item => item.trim()).filter(Boolean);
    if (parts.length >= 3 && /^\d{4}$/.test(parts[0])) {
        return {
            raw,
            year: parts[0],
            month: String(parts[1]).padStart(2, '0'),
            day: String(parts[2]).padStart(2, '0')
        };
    }

    if (/^\d{4}$/.test(normalized)) {
        return { raw, year: normalized, month: '', day: '' };
    }

    return { raw, year: '', month: '', day: '' };
}

export function validateValueByType(expectedValueType, candidateValue, component = 'full') {
    const value = Array.isArray(candidateValue)
        ? candidateValue.map(item => flattenTextValue(item)).filter(Boolean).join('；')
        : flattenTextValue(candidateValue);

    if (!value) return false;

    switch (expectedValueType) {
        case 'year':
            return isYearValue(value);
        case 'month':
            return isMonthValue(value);
        case 'day':
            return isDayValue(value);
        case 'url':
            return isUrlValue(value);
        case 'place':
            return looksLikePlace(value);
        case 'organization_or_person':
            return looksLikeOrganizationOrPerson(value);
        case 'language':
            return ['中文', '英文'].includes(value);
        case 'document_type':
            return ['会议论文', '期刊论文', '学位论文', '技术报告', '数据集', '专利', '著作章节', '预印本'].includes(value);
        case 'presentation_type':
            return ['特邀报告', '分组报告', '墙报展示'].includes(value) || value.length > 0;
        case 'identifier':
            return value.length > 0;
        case 'number':
            return /^-?\d+(?:\.\d+)?$/.test(value);
        case 'page_info':
            if (component === 'first' || component === 'last') {
                return /^[A-Za-z]?\d+$/.test(value);
            }
            return /^[A-Za-z]?\d+(?:[-–—~][A-Za-z]?\d+)?$/.test(value);
        case 'date':
            if (component === 'full') {
                const parts = coerceDateParts(value);
                return Boolean(parts.raw && (parts.year || value));
            }
            return true;
        default:
            return value.length > 0;
    }
}
