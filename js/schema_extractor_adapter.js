import { extractSchema } from './schema_extractor.bundle.js';

const FALLBACK_FORM_SELECTORS = [
    'form',
    '[role="form"]',
    '.form',
    '.form-container',
    '.ant-form',
    '.el-form',
    'body'
];

const LABEL_SELECTORS = [
    '.field-label',
    '.form-label',
    '.control-label',
    '.ant-form-item-label',
    '.el-form-item__label',
    'legend',
    'label',
    'th'
];

const CONTROL_SELECTOR = [
    'input',
    'select',
    'textarea',
    '[role="combobox"]',
    '[role="listbox"]',
    '[role="radio"]',
    '[role="checkbox"]',
    '[role="textbox"]'
].join(', ');

const CUSTOM_OPTION_SELECTORS = [
    '[role="option"]',
    '.ant-select-item-option',
    '.el-select-dropdown__item',
    '.dropdown-item',
    'li'
];

const BLOCK_HINT_PATTERN = /(form|field|item|group|row|cell|wrap|control|content|section|panel|line|col|author|table)/i;
const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6, .title, .section-title, .panel-title, .card-title, .module-title';
const TABLE_ROW_SELECTOR = 'tbody tr, tr';
const ACTION_TEXT_PATTERN = /(删除|上移|下移|添加|保存|提交|重置|操作|说明|提示|请填写|请输入|点击)/;

const TOKEN_MAP = {
    start: '起始',
    begin: '起始',
    first: '起始',
    from: '起始',
    end: '终止',
    last: '终止',
    to: '终止',
    page: '页码',
    pages: '页码',
    date: '日期',
    time: '时间',
    year: '年份',
    month: '月份',
    day: '日期',
    publication: '发表',
    publish: '发表',
    conference: '会议',
    paper: '论文',
    author: '作者',
    affiliation: '单位',
    language: '语言',
    name: '姓名'
};

function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanLabelText(text) {
    const normalized = normalizeText(String(text || '').replace(/[*：:]+$/g, ''));
    if (!normalized) return '';
    if (ACTION_TEXT_PATTERN.test(normalized)) return '';
    return normalized;
}

function cssEscape(value) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
        return CSS.escape(value);
    }
    return String(value || '').replace(/([ #;?%&,.+*~\\':"!^$[\]()=>|/@])/g, '\\$1');
}

function buildCssPath(element) {
    if (!element || element.nodeType !== 1) return '';
    if (element.id) return `#${cssEscape(element.id)}`;

    const parts = [];
    let current = element;

    while (current && current.nodeType === 1 && current.tagName.toLowerCase() !== 'html') {
        let part = current.tagName.toLowerCase();
        const classes = Array.from(current.classList || []).filter(Boolean).slice(0, 2);
        if (classes.length) {
            part += `.${classes.map(cssEscape).join('.')}`;
        }

        const siblings = current.parentElement
            ? Array.from(current.parentElement.children).filter(el => el.tagName === current.tagName)
            : [];
        if (siblings.length > 1) {
            part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }

        parts.unshift(part);
        current = current.parentElement;
    }

    return parts.join(' > ');
}

function slugifyFieldName(value, fallbackValue = 'field') {
    const normalized = String(value || fallbackValue)
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/[^\w\-:.]/g, '_')
        .replace(/^_+|_+$/g, '');

    return normalized || fallbackValue;
}

function isMeaningfulFieldName(name) {
    const normalized = normalizeText(name || '').toLowerCase();
    if (!normalized) return false;
    return !/^(field|input|select|textarea|checkbox|radio|text|option|item)[_\-:]?\d*$/.test(normalized);
}

function getElementType(element) {
    const tag = element.tagName.toLowerCase();
    const role = (element.getAttribute('role') || '').toLowerCase();
    const inputType = (element.getAttribute('type') || '').toLowerCase();

    if (tag === 'textarea') return 'textarea';
    if (tag === 'select') return 'select';
    if (inputType === 'radio' || role === 'radio') return 'radio';
    if (inputType === 'checkbox' || role === 'checkbox') return 'checkbox';
    if (role === 'listbox' || role === 'combobox') return 'select';
    if (tag === 'input') return inputType || 'text';
    return 'text';
}

function shouldSkipElement(element) {
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute('type') || '').toLowerCase();

    if (element.disabled) return true;
    if (tag === 'button') return true;
    if (tag === 'input' && ['hidden', 'submit', 'reset', 'button', 'image'].includes(type)) return true;
    return false;
}

function isInsideTable(element) {
    return !!element.closest('table, [role="table"], .ant-table, .el-table');
}

function resolveRoots(doc, formSelectors) {
    const roots = [];
    const seen = new Set();

    const pushRoot = (element) => {
        if (!element || seen.has(element)) return;
        seen.add(element);
        roots.push(element);
    };

    (Array.isArray(formSelectors) ? formSelectors : []).forEach(selector => {
        try {
            doc.querySelectorAll(selector).forEach(pushRoot);
        } catch (_) {
            // ignore invalid selectors
        }
    });

    if (!roots.length) {
        FALLBACK_FORM_SELECTORS.forEach(selector => {
            doc.querySelectorAll(selector).forEach(pushRoot);
        });
    }

    return roots.length ? roots : [doc.body].filter(Boolean);
}

function getExplicitLabel(doc, control) {
    const id = control.getAttribute('id');
    if (!id) return '';
    return normalizeText(doc.querySelector(`label[for="${cssEscape(id)}"]`)?.textContent || '');
}

function getWrappedLabel(control) {
    return normalizeText(control.closest('label')?.textContent || '');
}

function getControlLabel(doc, control) {
    return cleanLabelText(
        getExplicitLabel(doc, control) ||
        getWrappedLabel(control) ||
        control.getAttribute('aria-label') ||
        control.getAttribute('placeholder') ||
        control.getAttribute('value') ||
        control.value ||
        ''
    );
}

function extractNativeSelectOptions(select) {
    return Array.from(select.options || [])
        .map(option => ({
            value: normalizeText(option.value || option.textContent || ''),
            text: cleanLabelText(option.textContent || option.label || option.value || '')
        }))
        .filter(option => option.text || option.value);
}

function extractCustomSelectOptions(host) {
    const seen = new Set();
    const options = [];

    CUSTOM_OPTION_SELECTORS.forEach(selector => {
        host.querySelectorAll(selector).forEach(option => {
            const text = cleanLabelText(option.textContent || '');
            const value = normalizeText(option.getAttribute('data-value') || option.getAttribute('value') || text);
            const key = `${value}__${text}`;
            if (!text || seen.has(key)) return;
            seen.add(key);
            options.push({ value: value || text, text });
        });
    });

    return options;
}

function tokenizeName(name) {
    return String(name || '')
        .toLowerCase()
        .split(/[_\-\s]+/)
        .filter(Boolean);
}

function buildNameHint(name) {
    const tokens = tokenizeName(name);
    const mapped = tokens.map(token => TOKEN_MAP[token] || '').filter(Boolean);
    return normalizeText(mapped.join(''));
}

function collectControls(root, { includeTables = false } = {}) {
    return Array.from(root.querySelectorAll(CONTROL_SELECTOR)).filter(control => {
        if (shouldSkipElement(control)) return false;
        if (!includeTables && isInsideTable(control)) return false;
        return true;
    });
}

function getDirectTextCandidates(block) {
    const candidates = [];

    Array.from(block.childNodes || []).forEach(node => {
        if (node.nodeType === Node.TEXT_NODE) {
            const text = cleanLabelText(node.textContent || '');
            if (text) candidates.push(text);
            return;
        }

        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const element = node;
        if (element.matches(CONTROL_SELECTOR)) return;
        if (element.querySelector(CONTROL_SELECTOR)) return;
        const text = cleanLabelText(element.textContent || '');
        if (text) candidates.push(text);
    });

    return candidates;
}

function getLeadingLabelCandidates(block) {
    const candidates = [];
    const children = Array.from(block.childNodes || []);

    for (const node of children) {
        if (node.nodeType === Node.TEXT_NODE) {
            const text = cleanLabelText(node.textContent || '');
            if (text) candidates.push(text);
            continue;
        }

        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const element = node;
        if (element.matches(CONTROL_SELECTOR) || element.querySelector(CONTROL_SELECTOR)) {
            break;
        }

        LABEL_SELECTORS.forEach(selector => {
            if (element.matches?.(selector)) {
                const text = cleanLabelText(element.textContent || '');
                if (text) candidates.push(text);
            }
            element.querySelectorAll?.(selector).forEach(labelNode => {
                if (labelNode.querySelector(CONTROL_SELECTOR) && !labelNode.matches('legend, th')) return;
                const text = cleanLabelText(labelNode.textContent || '');
                if (text) candidates.push(text);
            });
        });

        const text = cleanLabelText(element.textContent || '');
        if (text) candidates.push(text);
    }

    return candidates;
}

function pickBestLabel(candidates) {
    const uniq = Array.from(new Set(candidates.map(cleanLabelText).filter(Boolean)));
    if (!uniq.length) return '';

    uniq.sort((a, b) => {
        const aScore = (a.length <= 20 ? 3 : 0) + (a.length <= 8 ? 2 : 0) - (ACTION_TEXT_PATTERN.test(a) ? 10 : 0);
        const bScore = (b.length <= 20 ? 3 : 0) + (b.length <= 8 ? 2 : 0) - (ACTION_TEXT_PATTERN.test(b) ? 10 : 0);
        return bScore - aScore || a.length - b.length;
    });

    return uniq[0] || '';
}

function extractBlockLabel(block) {
    const leadingCandidates = getLeadingLabelCandidates(block);
    if (leadingCandidates.length) {
        return pickBestLabel(leadingCandidates);
    }

    const siblingCandidates = Array.from(block.children || [])
        .filter(child => !child.querySelector(CONTROL_SELECTOR) && !child.matches(CONTROL_SELECTOR))
        .map(child => cleanLabelText(child.textContent || ''))
        .filter(Boolean);
    if (siblingCandidates.length) {
        return pickBestLabel(siblingCandidates);
    }

    return pickBestLabel(getDirectTextCandidates(block));
}

function scoreBlockCandidate(candidate, root, depth) {
    const controls = collectControls(candidate, { includeTables: false });
    if (!controls.length || controls.length > 12) return -Infinity;

    const label = extractBlockLabel(candidate);
    const classHint = BLOCK_HINT_PATTERN.test(`${candidate.className || ''} ${candidate.id || ''}`);
    const directChildren = Array.from(candidate.children || []);
    const signalChildren = directChildren.filter(child =>
        child.matches(CONTROL_SELECTOR) ||
        child.querySelector(CONTROL_SELECTOR) ||
        cleanLabelText(child.textContent || '')
    ).length;

    let score = 0;
    score += Math.max(0, 10 - controls.length);
    score += label ? 10 : 0;
    score += classHint ? 4 : 0;
    score += Math.min(signalChildren, 4);
    score -= depth * 0.2;
    if (candidate === root) score -= 20;

    return score;
}

function scoreChoiceGroupCandidate(candidate, root, controlType, depth) {
    const controls = collectControls(candidate, { includeTables: false })
        .filter(control => getElementType(control) === controlType);
    if (controls.length < 2) return -Infinity;

    const allControls = collectControls(candidate, { includeTables: false });
    const label = extractBlockLabel(candidate);
    const classHint = BLOCK_HINT_PATTERN.test(`${candidate.className || ''} ${candidate.id || ''}`);

    let score = 0;
    score += Math.min(controls.length, 8) * 4;
    score += label ? 12 : 0;
    score += classHint ? 4 : 0;
    score -= Math.max(0, allControls.length - controls.length) * 2;
    score -= depth * 0.2;
    if (candidate === root) score -= 24;

    return score;
}

function selectChoiceGroupContainer(control, root, controlType) {
    let current = control.parentElement;
    let depth = 0;
    let best = null;
    let bestScore = -Infinity;

    while (current && current !== root.parentElement) {
        if (current.matches('table, tbody, thead, tr, td, th')) {
            current = current.parentElement;
            depth += 1;
            continue;
        }

        const score = scoreChoiceGroupCandidate(current, root, controlType, depth);
        if (score > bestScore) {
            best = current;
            bestScore = score;
        }

        if (current === root) break;
        current = current.parentElement;
        depth += 1;
    }

    return best;
}

function selectBestBlock(control, root) {
    let current = control.parentElement;
    let depth = 0;
    let best = null;
    let bestScore = -Infinity;

    while (current && current !== root.parentElement) {
        if (current.matches('table, tbody, thead, tr, td, th')) {
            current = current.parentElement;
            depth += 1;
            continue;
        }

        const score = scoreBlockCandidate(current, root, depth);
        if (score > bestScore) {
            best = current;
            bestScore = score;
        }

        if (current === root) break;
        current = current.parentElement;
        depth += 1;
    }

    return best || control.parentElement || root;
}

function buildScalarLabel(blockLabel, control, doc, fallbackIndex) {
    const placeholder = cleanLabelText(control.getAttribute('placeholder') || '');
    const ariaLabel = cleanLabelText(control.getAttribute('aria-label') || '');
    const explicitLabel = cleanLabelText(getExplicitLabel(doc, control));
    const nameHint = cleanLabelText(buildNameHint(control.getAttribute('name') || control.getAttribute('id') || ''));
    const controlLabel = cleanLabelText(getControlLabel(doc, control));

    const localHint = placeholder || ariaLabel || explicitLabel || nameHint || controlLabel;
    if (!blockLabel) {
        return localHint || `字段${fallbackIndex + 1}`;
    }
    if (!localHint || localHint === blockLabel) {
        return blockLabel;
    }
    if (blockLabel.includes(localHint) || localHint.includes(blockLabel)) {
        return blockLabel.length >= localHint.length ? blockLabel : localHint;
    }
    return `${blockLabel}-${localHint}`;
}

function buildChoiceField(doc, block, controls, fieldType, blockLabel, fallbackIndex) {
    const options = controls.map(control => {
        const text = cleanLabelText(getControlLabel(doc, control));
        const value = normalizeText(control.value || control.getAttribute('value') || text || 'on');
        return {
            value: value || text,
            text: text || value
        };
    }).filter(option => option.text || option.value);

    const sharedNames = Array.from(new Set(
        controls.map(control => normalizeText(control.getAttribute('name') || '')).filter(Boolean)
    ));

    const fieldName = blockLabel
        ? slugifyFieldName(blockLabel, sharedNames[0] || `${fieldType}_${fallbackIndex + 1}`)
        : (sharedNames.find(isMeaningfulFieldName) || slugifyFieldName(`${fieldType}_${fallbackIndex + 1}`, `${fieldType}_${fallbackIndex + 1}`));

    return {
        name: fieldName,
        label: blockLabel || fieldName,
        type: fieldType,
        tagName: controls[0]?.tagName?.toLowerCase() || 'input',
        required: controls.some(control => control.required || control.getAttribute('aria-required') === 'true'),
        placeholder: '',
        options,
        selector: buildCssPath(block),
        xpath: '',
        description: '',
        source: 'schema-extractor',
        multiple: fieldType === 'checkbox'
    };
}

function buildScalarField(doc, control, blockLabel, fallbackIndex) {
    const fieldType = getElementType(control);
    const controlName = normalizeText(control.getAttribute('name') || control.getAttribute('id') || '');
    const label = buildScalarLabel(blockLabel, control, doc, fallbackIndex);
    const name = controlName || slugifyFieldName(label, `${fieldType}_${fallbackIndex + 1}`);

    let options = [];
    if (control.tagName.toLowerCase() === 'select') {
        options = extractNativeSelectOptions(control);
    } else if (fieldType === 'select') {
        options = extractCustomSelectOptions(control.closest('.ant-select, .el-select, .dropdown, .select, [role="listbox"], [role="combobox"]') || control);
    }

    return {
        name,
        label,
        type: fieldType,
        tagName: control.tagName.toLowerCase(),
        required: control.required || control.getAttribute('aria-required') === 'true',
        placeholder: normalizeText(control.getAttribute('placeholder') || ''),
        options,
        selector: buildCssPath(control),
        xpath: '',
        description: '',
        source: 'schema-extractor',
        multiple: control.multiple === true
    };
}

function extractBlocks(root) {
    const blockMap = new Map();
    const controls = collectControls(root, { includeTables: false });

    controls.forEach(control => {
        const block = selectBestBlock(control, root);
        if (!blockMap.has(block)) {
            blockMap.set(block, []);
        }
        blockMap.get(block).push(control);
    });

    return Array.from(blockMap.entries())
        .map(([block, controlsInBlock]) => ({ block, controls: controlsInBlock }))
        .sort((a, b) => {
            const pos = a.block.compareDocumentPosition(b.block);
            if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
            if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
            return 0;
        });
}

function extractChoiceGroups(doc, root) {
    const groupedControls = new Set();
    const groups = [];
    const controls = collectControls(root, { includeTables: false })
        .filter(control => {
            const type = getElementType(control);
            return type === 'radio' || type === 'checkbox';
        });

    controls.forEach(control => {
        if (groupedControls.has(control)) return;

        const controlType = getElementType(control);
        const container = selectChoiceGroupContainer(control, root, controlType);
        if (!container) return;

        const groupControls = collectControls(container, { includeTables: false })
            .filter(item => getElementType(item) === controlType);
        if (groupControls.length < 2) return;

        groupControls.forEach(item => groupedControls.add(item));
        groups.push({
            field: buildChoiceField(doc, container, groupControls, controlType, extractBlockLabel(container), groups.length),
            controls: groupControls
        });
    });

    return {
        groups,
        groupedControls
    };
}

function buildFieldsFromBlock(doc, blockEntry, blockIndex) {
    const { block, controls } = blockEntry;
    const blockLabel = extractBlockLabel(block);
    const radios = controls.filter(control => getElementType(control) === 'radio');
    const checkboxes = controls.filter(control => getElementType(control) === 'checkbox');

    if (radios.length > 1 && radios.length === controls.length) {
        return [buildChoiceField(doc, block, radios, 'radio', blockLabel, blockIndex)];
    }

    if (checkboxes.length > 1 && checkboxes.length === controls.length) {
        return [buildChoiceField(doc, block, checkboxes, 'checkbox', blockLabel, blockIndex)];
    }

    return controls.map((control, controlIndex) =>
        buildScalarField(doc, control, blockLabel, (blockIndex * 10) + controlIndex)
    );
}

function findNearestSectionTitle(element) {
    const container = element.closest('section, .section, .panel, .card, .module, .box, .content, .container, div') || element.parentElement;
    if (!container) return '';

    const localHeading = Array.from(container.querySelectorAll(HEADING_SELECTOR))
        .find(node => node.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (localHeading) {
        return cleanLabelText(localHeading.textContent || '');
    }

    let current = container.previousElementSibling;
    while (current) {
        if (current.matches?.(HEADING_SELECTOR)) {
            return cleanLabelText(current.textContent || '');
        }
        const nestedHeading = current.querySelector?.(HEADING_SELECTOR);
        if (nestedHeading) {
            return cleanLabelText(nestedHeading.textContent || '');
        }
        current = current.previousElementSibling;
    }

    return '';
}

function extractTableHeaders(table) {
    const headerCells = Array.from(table.querySelectorAll('thead th, thead td'));
    if (headerCells.length) {
        return headerCells.map(cell => cleanLabelText(cell.textContent || ''));
    }

    const firstHeaderRow = Array.from(table.querySelectorAll('tr'))
        .find(row => Array.from(row.querySelectorAll('th')).length > 0);
    if (firstHeaderRow) {
        return Array.from(firstHeaderRow.children).map(cell => cleanLabelText(cell.textContent || ''));
    }

    return [];
}

function extractTableFields(doc, table, tableIndex) {
    const tableLabel = findNearestSectionTitle(table) || `表格${tableIndex + 1}`;
    const headers = extractTableHeaders(table);
    const rows = Array.from(table.querySelectorAll(TABLE_ROW_SELECTOR))
        .filter(row => collectControls(row, { includeTables: true }).length > 0);

    const tableSelector = buildCssPath(table);
    const fields = [];

    rows.forEach((row, rowIndex) => {
        const rowKey = `${tableSelector}::row:${rowIndex + 1}`;
        const cells = Array.from(row.children || []);

        cells.forEach((cell, cellIndex) => {
            const controls = collectControls(cell, { includeTables: true });
            if (!controls.length) return;

            const header = cleanLabelText(headers[cellIndex] || '');
            const cellLabel = header || extractBlockLabel(cell) || `列${cellIndex + 1}`;

            const radios = controls.filter(control => getElementType(control) === 'radio');
            const checkboxes = controls.filter(control => getElementType(control) === 'checkbox');

            if (radios.length > 1 && radios.length === controls.length) {
                const field = buildChoiceField(doc, cell, radios, 'radio', cellLabel, (rowIndex * 20) + cellIndex);
                fields.push({
                    ...field,
                    label: cellLabel,
                    name: field.name || slugifyFieldName(`${tableLabel}_${cellLabel}`, `table_${tableIndex + 1}_${cellIndex + 1}`),
                    selector: buildCssPath(cell),
                    isTableField: true,
                    tableLabel,
                    repeatedGroupKey: rowKey,
                    rowIndex,
                    columnIndex: cellIndex
                });
                return;
            }

            if (checkboxes.length > 1 && checkboxes.length === controls.length) {
                const field = buildChoiceField(doc, cell, checkboxes, 'checkbox', cellLabel, (rowIndex * 20) + cellIndex);
                fields.push({
                    ...field,
                    label: cellLabel,
                    name: field.name || slugifyFieldName(`${tableLabel}_${cellLabel}`, `table_${tableIndex + 1}_${cellIndex + 1}`),
                    selector: buildCssPath(cell),
                    isTableField: true,
                    tableLabel,
                    repeatedGroupKey: rowKey,
                    rowIndex,
                    columnIndex: cellIndex
                });
                return;
            }

            controls.forEach((control, controlIndex) => {
                const field = buildScalarField(doc, control, cellLabel, (rowIndex * 100) + (cellIndex * 10) + controlIndex);
                fields.push({
                    ...field,
                    label: field.label || cellLabel,
                    name: field.name || slugifyFieldName(`${tableLabel}_${cellLabel}_${rowIndex + 1}`, `table_${tableIndex + 1}_${cellIndex + 1}_${rowIndex + 1}`),
                    isTableField: true,
                    tableLabel,
                    repeatedGroupKey: rowKey,
                    rowIndex,
                    columnIndex: cellIndex
                });
            });
        });
    });

    return fields;
}

function dedupeFields(fields) {
    const seen = new Set();
    return fields.filter(field => {
        const key = `${field.type}::${field.name}::${field.selector}::${field.repeatedGroupKey || ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export async function extractFormFieldsFromHtml(html) {
    const safeHtml = String(html || '');
    const schema = await extractSchema(safeHtml);
    const doc = new DOMParser().parseFromString(safeHtml, 'text/html');
    const roots = resolveRoots(doc, schema?.forms || []);

    const fields = roots.flatMap(root => {
        const { groups: choiceGroups, groupedControls } = extractChoiceGroups(doc, root);
        const tableFields = Array.from(root.querySelectorAll('table')).flatMap((table, tableIndex) =>
            extractTableFields(doc, table, tableIndex)
        );

        const blockFields = extractBlocks(root)
            .map(blockEntry => ({
                ...blockEntry,
                controls: blockEntry.controls.filter(control => !groupedControls.has(control))
            }))
            .filter(blockEntry => blockEntry.controls.length > 0)
            .flatMap((blockEntry, blockIndex) => buildFieldsFromBlock(doc, blockEntry, blockIndex));

        return [...tableFields, ...choiceGroups.map(group => group.field), ...blockFields];
    });

    return {
        schema,
        fields: dedupeFields(fields)
    };
}
