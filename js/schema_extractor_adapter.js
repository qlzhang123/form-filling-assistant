import { extractSchema } from './schema_extractor.bundle.js';

const FALLBACK_FORM_SELECTORS = [
    'form',
    '[role="form"]',
    '.form',
    '.form-container',
    '.ant-form',
    '.el-form'
];

const ROW_SELECTORS = [
    '.field-row',
    '.form-group',
    '.ant-form-item',
    '.el-form-item',
    'fieldset'
];

const LABEL_SELECTORS = [
    '.field-label',
    '.ant-form-item-label',
    '.el-form-item__label',
    'legend',
    'th'
];

const VALUE_SELECTORS = [
    '.field-value',
    '.ant-form-item-control',
    '.el-form-item__content',
    '.radio-option-group',
    '.checkbox-group'
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

const TOKEN_MAP = {
    start: '开始',
    begin: '开始',
    first: '起始',
    from: '开始',
    end: '结束',
    last: '终止',
    to: '结束',
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
    language: '语言'
};

function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
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

function slugifyFieldName(value, fallbackValue = 'field') {
    const normalized = String(value || fallbackValue)
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/[^\w\-:.]/g, '_')
        .replace(/^_+|_+$/g, '');

    return normalized || fallbackValue;
}

function cleanLabelText(text) {
    return normalizeText(String(text || '').replace(/[*＊:：]+$/g, ''));
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
            // ignore invalid selectors from schema-extractor
        }
    });

    if (!roots.length) {
        FALLBACK_FORM_SELECTORS.forEach(selector => {
            doc.querySelectorAll(selector).forEach(pushRoot);
        });
    }

    if (!roots.length && doc.body) {
        pushRoot(doc.body);
    }

    return roots;
}

function findRowNodes(root) {
    const rows = [];
    const seen = new Set();

    ROW_SELECTORS.forEach(selector => {
        root.querySelectorAll(selector).forEach(row => {
            if (!seen.has(row) && row.querySelector(CONTROL_SELECTOR)) {
                seen.add(row);
                rows.push(row);
            }
        });
    });

    if (!rows.length) {
        Array.from(root.querySelectorAll(CONTROL_SELECTOR))
            .filter(control => !shouldSkipElement(control))
            .forEach(control => {
                const row = control.closest(ROW_SELECTORS.join(', ')) || control.parentElement;
                if (row && !seen.has(row)) {
                    seen.add(row);
                    rows.push(row);
                }
            });
    }

    return rows;
}

function getLabelNode(row) {
    for (const selector of LABEL_SELECTORS) {
        const node = row.querySelector(selector);
        if (node) return node;
    }
    return null;
}

function getRowLabel(row) {
    return cleanLabelText(getLabelNode(row)?.textContent || '');
}

function getValueContainer(row, labelNode) {
    for (const selector of VALUE_SELECTORS) {
        const node = row.querySelector(selector);
        if (node) return node;
    }

    const directChildren = Array.from(row.children || []).filter(child => child !== labelNode);
    const controlChild = directChildren.find(child => child.querySelector(CONTROL_SELECTOR) || child.matches(CONTROL_SELECTOR));
    return controlChild || row;
}

function getControls(container) {
    return Array.from(container.querySelectorAll(CONTROL_SELECTOR)).filter(control => !shouldSkipElement(control));
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
    return (
        getExplicitLabel(doc, control) ||
        getWrappedLabel(control) ||
        normalizeText(control.getAttribute('aria-label') || '') ||
        normalizeText(control.getAttribute('placeholder') || '') ||
        normalizeText(control.value || control.getAttribute('value') || '')
    );
}

function extractNativeSelectOptions(select) {
    return Array.from(select.options || [])
        .map(option => ({
            value: normalizeText(option.value || option.textContent || ''),
            text: normalizeText(option.textContent || option.label || option.value || '')
        }))
        .filter(option => option.text || option.value);
}

function extractCustomSelectOptions(host) {
    const seen = new Set();
    const options = [];

    CUSTOM_OPTION_SELECTORS.forEach(selector => {
        host.querySelectorAll(selector).forEach(option => {
            const text = normalizeText(option.textContent || '');
            const value = normalizeText(option.getAttribute('data-value') || option.getAttribute('value') || text);
            const key = `${value}__${text}`;
            if (!text || seen.has(key)) return;
            seen.add(key);
            options.push({ value, text });
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

function buildHintFromName(name) {
    const tokens = tokenizeName(name);
    const mapped = tokens.map(token => TOKEN_MAP[token] || '').filter(Boolean);
    return normalizeText(mapped.join(''));
}

function buildScalarLabel(rowLabel, control, doc) {
    const placeholder = cleanLabelText(control.getAttribute('placeholder') || '');
    const ariaLabel = cleanLabelText(control.getAttribute('aria-label') || '');
    const explicitLabel = cleanLabelText(getExplicitLabel(doc, control));
    const nameHint = cleanLabelText(buildHintFromName(control.getAttribute('name') || control.getAttribute('id') || ''));

    const hint = placeholder || ariaLabel || explicitLabel || nameHint;
    if (!hint) {
        return rowLabel;
    }

    if (!rowLabel) {
        return hint;
    }

    if (rowLabel.includes(hint) || hint.includes(rowLabel)) {
        return rowLabel.length >= hint.length ? rowLabel : hint;
    }

    return `${rowLabel}-${hint}`;
}

function buildChoiceField(doc, row, controls, fieldType, rowLabel, index) {
    const options = controls.map(control => {
        const text = cleanLabelText(getControlLabel(doc, control));
        const value = normalizeText(control.value || control.getAttribute('value') || text);
        return {
            value: value || text,
            text: text || value
        };
    }).filter(option => option.text || option.value);

    const sharedNames = Array.from(new Set(
        controls.map(control => normalizeText(control.getAttribute('name') || '')).filter(Boolean)
    ));

    const fieldName = sharedNames.length === 1
        ? sharedNames[0]
        : (rowLabel || `${fieldType}_${index + 1}`);

    return {
        name: fieldName,
        label: rowLabel || fieldName,
        type: fieldType,
        tagName: controls[0]?.tagName?.toLowerCase() || 'input',
        required: controls.some(control => control.required || control.getAttribute('aria-required') === 'true'),
        placeholder: '',
        options,
        selector: buildCssPath(row),
        xpath: '',
        description: '',
        source: 'schema-extractor',
        multiple: fieldType === 'checkbox'
    };
}

function buildScalarField(doc, row, control, rowLabel, index) {
    const fieldType = getElementType(control);
    const controlName = normalizeText(control.getAttribute('name') || control.getAttribute('id') || '');
    const label = buildScalarLabel(rowLabel, control, doc) || controlName || `${fieldType}_${index + 1}`;
    const name = controlName || slugifyFieldName(label, `${fieldType}_${index + 1}`);

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

function buildFieldsFromRow(doc, row, index) {
    const labelNode = getLabelNode(row);
    const rowLabel = getRowLabel(row);
    const valueContainer = getValueContainer(row, labelNode);
    const controls = getControls(valueContainer);

    if (!controls.length) {
        return [];
    }

    const radios = controls.filter(control => getElementType(control) === 'radio');
    const checkboxes = controls.filter(control => getElementType(control) === 'checkbox');

    if (radios.length > 1) {
        return [buildChoiceField(doc, row, radios, 'radio', rowLabel, index)];
    }

    if (checkboxes.length > 1) {
        return [buildChoiceField(doc, row, checkboxes, 'checkbox', rowLabel, index)];
    }

    return controls.map((control, controlIndex) => buildScalarField(doc, row, control, rowLabel, (index * 10) + controlIndex));
}

function dedupeFields(fields) {
    const seen = new Set();
    return fields.filter(field => {
        const key = `${field.type}::${field.name}::${field.selector}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export async function extractFormFieldsFromHtml(html) {
    const schema = await extractSchema(String(html || ''));
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    const roots = resolveRoots(doc, schema?.forms || []);

    const fields = roots.flatMap(root =>
        findRowNodes(root).flatMap((row, index) => buildFieldsFromRow(doc, row, index))
    );

    return {
        schema,
        fields: dedupeFields(fields)
    };
}
