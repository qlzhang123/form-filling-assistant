/**
 * 濉〃鍔╂墜鍐呭鑴氭湰
 * 鐢ㄤ簬涓庣洰鏍囩綉椤典氦浜掞紝鎵цDOM鎿嶄綔
 */

class FormFillingContentScript {
    constructor() {
        this.isConnected = false;
        this.initialize();
    }

    initialize() {
        console.log('濉〃鍔╂墜鍐呭鑴氭湰鍒濆鍖?..');
        
        // 鐩戝惉鏉ヨ嚜background script鐨勬秷鎭?
        if (typeof chrome !== 'undefined' && chrome.runtime) {
            chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
                this.handleMessage(request, sender, sendResponse);
                // 杩斿洖true琛ㄧず寮傛鍙戦€佸搷搴?
                return true;
            });
        }
        
        this.isConnected = true;
        console.log('濉〃鍔╂墜鍐呭鑴氭湰杩炴帴鎴愬姛');
    }

    handleMessage(request, sender, sendResponse) {
        /**
         * 澶勭悊鏀跺埌鐨勬秷鎭?
         */
        const { action, data } = request;
        
        console.log('鏀跺埌娑堟伅:', action, data);
        
        switch (action) {
            case 'fillFormField':
                this.fillFormField(data.fieldName, data.value, sendResponse, data.fieldSelector);
                break;
                
            case 'getPageElements':
                this.getPageElements(data.selector || 'form input, form select, form textarea', sendResponse);
                break;
                
            case 'getPageContent':
                // 鏂板锛氱洿鎺ヨ繑鍥為〉闈?HTML锛屼緵 Sidebar 涓殑 FormParser + LLM 浣跨敤
                sendResponse({
                    success: true,
                    content: document.documentElement.outerHTML,
                    url: window.location.href,
                    title: document.title
                });
                break;

            case 'clickElement':
                this.clickElement(data.selector, sendResponse);
                break;

            default:
                console.warn('鏈煡鐨勬秷鎭姩浣?', action);
                sendResponse({ success: false, message: `鏈煡鐨勫姩浣? ${action}` });
                break;
        }
    }

    getElementLabel(element) {
        /**
         * 鑾峰彇鍏冪礌鐨勬爣绛炬枃鏈?
         */
        // 1. 灏濊瘯浣跨敤 element.labels (鏍囧噯API)
        if (element.labels && element.labels.length > 0) {
            const labelText = Array.from(element.labels)
                                 .map(l => l.textContent.trim())
                                 .filter(t => t)
                                 .join(' ');
            if (labelText) return labelText;
        }

        // 2. 閫氳繃for灞炴€ф煡鎵緇abel
        if (element.id) {
            const label = document.querySelector(`label[for="${element.id}"]`);
            if (label) {
                const text = label.textContent.trim();
                if (text) return text;
            }
        }

        // 3. 鏌ユ壘鐖剁骇label
        let parent = element.parentElement;
        while (parent && parent.tagName.toLowerCase() !== 'form' && parent !== document.body) {
            if (parent.tagName.toLowerCase() === 'label') {
                const text = parent.textContent.trim();
                if (text) return text;
            }
            // 濡傛灉鐖跺厓绱犲唴鏈塴abel浣嗕笉鏄洿鎺ョ埗绾?
            const internalLabel = parent.querySelector('label');
            if (internalLabel && internalLabel.contains(element)) {
                const text = internalLabel.textContent.trim();
                if (text) return text;
            }
            parent = parent.parentElement;
        }

        // 4. 鏌ユ壘鍓嶄竴涓厔寮熷厓绱犱腑鐨刲abel
        let sibling = element.previousElementSibling;
        while (sibling) {
            if (sibling.tagName.toLowerCase() === 'label') {
                return sibling.textContent.trim();
            }
            // 鎴栬€呮槸鍖呭惈鏂囨湰鐨剆pan/div
            if (['SPAN', 'DIV', 'TD'].includes(sibling.tagName) && sibling.textContent.trim().length > 0) {
                return sibling.textContent.trim();
            }
            sibling = sibling.previousElementSibling;
        }

        // 5. 鏌ユ壘aria-label鎴杢itle鎴杙laceholder
        return element.getAttribute('aria-label') || 
               element.title || 
               element.placeholder || 
               '';
    }

    parseDateString(value) {
        /**
         * 瑙ｆ瀽鏃ユ湡瀛楃涓?
         * 鏀寔鏍煎紡锛歒YYY-MM-DD, YYYY/MM/DD, YYYY.MM.DD, YYYY骞碝M鏈圖D鏃?
         */
        if (!value) return null;
        const str = String(value).trim();
        
        // 灏濊瘯鍖归厤甯歌鏍煎紡
        // 1. YYYY-MM-DD 鎴?YYYY/MM/DD 鎴?YYYY.MM.DD
        let match = str.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
        if (match) {
            return {
                year: match[1],
                month: match[2].padStart(2, '0'),
                day: match[3].padStart(2, '0')
            };
        }
        
        // 2. YYYY年MM月DD日
        match = str.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日?$/);
        if (match) {
            return {
                year: match[1],
                month: match[2].padStart(2, '0'),
                day: match[3].padStart(2, '0')
            };
        }
        
        // 3. YYYYMMDD
        match = str.match(/^(\d{4})(\d{2})(\d{2})$/);
        if (match) {
            return {
                year: match[1],
                month: match[2],
                day: match[3]
            };
        }

        return null;
    }

    async fillFormField(fieldName, value, sendResponse, fieldSelector = '') {
        /**
         * 濉啓琛ㄥ崟瀛楁
         */
        try {
            const normalize = (s) => String(s || '')
                .replace(/[\*\uFF0A]/g, '')
                .replace(/[:\uFF1A]/g, '')
                .trim()
                .toLowerCase()
                .replace(/\s+/g, '');

            const mapEnZh = (v) => {
                const x = String(v || '').trim().toLowerCase();
                const m = {
                    'conference': '浼氳璁烘枃',
                    'conferencepaper': '浼氳璁烘枃',
                    'proceedings': '浼氳璁烘枃',
                    'oral': '鍒嗙粍鎶ュ憡',
                    'sessiontalk': '鍒嗙粍鎶ュ憡',
                    'talk': '鍒嗙粍鎶ュ憡',
                    'invitedtalk': '鐗归個鎶ュ憡',
                    'invited': '鐗归個鎶ュ憡',
                    'poster': '澧欐姤灞曠ず',
                    'journal': '鏈熷垔璁烘枃',
                    'journalarticle': '鏈熷垔璁烘枃',
                    'article': '鏈熷垔璁烘枃',
                    'thesis': '瀛︿綅璁烘枃',
                    'phdthesis': '瀛︿綅璁烘枃',
                    'mastersthesis': '瀛︿綅璁烘枃',
                    'technicalreport': '技术报告',
                    'techreport': '技术报告',
                    'dataset': '数据集',
                    'patent': '涓撳埄',
                    'bookchapter': '钁椾綔绔犺妭',
                    'chapter': '钁椾綔绔犺妭',
                    'preprint': '预印本',
                    'arxiv': '预印本',
                    'english': '澶栨枃',
                    'en': '澶栨枃',
                    'chinese': '涓枃',
                    'zh': '涓枃',
                    'openaccess': '开放获取',
                    'oa': '开放获取',
                    'closedaccess': '非开放获取',
                    'nonopenaccess': '非开放获取',
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

            const waitFor = (ms) => new Promise(resolve => setTimeout(resolve, ms));
            const hasNegativeSemantic = (raw) => /^(非|不|无|未|not\b|non\b|no\b|closed\b)/i.test(String(raw || '').trim().toLowerCase());
            const stripNegativeSemantic = (raw) => String(raw || '').trim().toLowerCase()
                .replace(/^(非|不|无|未)+/, '')
                .replace(/^(?:not|non|no|closed)\s*/i, '')
                .trim();
            const scoreSemanticMatch = (left, right) => {
                const leftNorm = normalize(left);
                const rightNorm = normalize(right);
                if (!leftNorm || !rightNorm) return 0;
                if (leftNorm === rightNorm) return 1;

                const leftNegative = hasNegativeSemantic(left);
                const rightNegative = hasNegativeSemantic(right);
                const leftCore = normalize(stripNegativeSemantic(left));
                const rightCore = normalize(stripNegativeSemantic(right));

                if (leftCore && rightCore && leftCore === rightCore && leftNegative !== rightNegative) {
                    return 0;
                }

                if (leftCore && rightCore && leftNegative === rightNegative) {
                    if (leftCore === rightCore) return 0.96;
                    if (leftCore.includes(rightCore) || rightCore.includes(leftCore)) return 0.84;
                }

                if (leftNegative !== rightNegative) return 0;
                if (leftNorm.includes(rightNorm) || rightNorm.includes(leftNorm)) return 0.72;
                return 0;
            };

            const parseFieldHints = (name) => {
                const raw = String(name || '');
                const idxMatch = raw.match(/\[(\d+)\]\s*$/);
                const indexHint = idxMatch ? parseInt(idxMatch[1], 10) : null;

                let groupKey = raw;
                let subKey = '';

                // 鏀寔锛氬瓧娈?- 瀛愬瓧娈?
                const dashParts = raw.split(/\s*[-–—]\s*/);
                if (dashParts.length >= 2) {
                    groupKey = dashParts[0];
                    subKey = dashParts.slice(1).join('-');
                }

                // 鏀寔锛氬瓧娈?(瀛愬瓧娈? / 瀛楁锛堝瓙瀛楁锛?
                const parenMatch = raw.match(/[锛?]\s*([^锛?]+)\s*[锛?]/);
                if (parenMatch) {
                    groupKey = raw.replace(parenMatch[0], '').trim();
                    subKey = parenMatch[1].trim();
                }

                // 鍘绘帀搴忓彿鍚庣紑瀵?groupKey 鐨勫奖鍝?
                groupKey = groupKey.replace(/\[\d+\]\s*$/, '').trim();

                return {
                    raw,
                    indexHint,
                    groupKey,
                    subKey
                };
            };

            const chooseBestElement = (elements, name) => {
                if (!elements || elements.length === 0) return null;
                const hints = parseFieldHints(name);
                const targetFull = normalize(name);
                const targetGroup = normalize(hints.groupKey);
                const targetSub = normalize(hints.subKey);

                const visible = elements.filter(el => this.isElementVisible(el));
                if (visible.length === 0) return null;

                const getMetaText = (el) => {
                    return [
                        el.getAttribute('aria-label'),
                        el.getAttribute('placeholder'),
                        el.getAttribute('title'),
                        el.name,
                        el.id,
                        this.getElementLabel(el),
                        el.closest('label')?.textContent
                    ].filter(Boolean).join(' ');
                };

                const indexInRow = (el) => {
                    const row = el.closest('.field-row');
                    if (!row) return null;
                    const controls = Array.from(row.querySelectorAll('select, input, textarea'))
                        .filter(x => x.type !== 'hidden' && x.type !== 'button' && x.type !== 'submit')
                        .filter(x => this.isElementVisible(x));
                    const idx = controls.indexOf(el);
                    return idx >= 0 ? idx + 1 : null;
                };

                let best = visible[0];
                let bestScore = -1;

                for (const el of visible) {
                    let score = 0;
                    const n = normalize(el.name);
                    const i = normalize(el.id);

                    if (n && n === targetFull) score += 200;
                    if (i && i === targetFull) score += 200;
                    if (n && (n.includes(targetFull) || targetFull.includes(n))) score += 80;
                    if (i && (i.includes(targetFull) || targetFull.includes(i))) score += 80;

                    const meta = normalize(getMetaText(el).replace(/[*:：]/g, ''));
                    if (meta && (meta.includes(targetFull) || targetFull.includes(meta))) score += 60;

                    if (targetSub) {
                        if (meta.includes(targetSub)) score += 150;
                        // 鐗规畩鍏抽敭璇嶅寮猴紙璧峰/缁堟/寮€濮?缁撴潫锛?
                        if ((targetSub.includes(normalize('起始')) || targetSub.includes(normalize('开始'))) && meta.includes(normalize('起始'))) score += 30;
                        if ((targetSub.includes(normalize('终止')) || targetSub.includes(normalize('结束'))) && (meta.includes(normalize('终止')) || meta.includes(normalize('结束')))) score += 30;
                    }

                    if (targetGroup) {
                        const rowLabel = el.closest('.field-row')?.querySelector('.field-label')?.textContent || '';
                        if (normalize(rowLabel).includes(targetGroup)) score += 30;
                    }

                    if (hints.indexHint != null) {
                        const pos = indexInRow(el);
                        if (pos === hints.indexHint) score += 120;
                    }

                    // 杞诲井鍊惧悜锛氬悓绫诲厓绱犳洿浼橈紙渚嬪鍖呭惈 鈥滈〉鈥?鐨勮緭鍏ヤ紭鍏?input锛?
                    if (el.tagName === 'INPUT') score += 5;
                    if (el.tagName === 'SELECT') score += 5;

                    if (score > bestScore) {
                        bestScore = score;
                        best = el;
                    }
                }

                return best;
            };

            const findFieldRowElements = (key) => {
                const rows = Array.from(document.querySelectorAll('.field-row'));
                const target = normalize(key);
                for (const row of rows) {
                    const labelDiv = row.querySelector('.field-label');
                    if (!labelDiv) continue;
                    const labelText = normalize(labelDiv.textContent);
                    if (labelText && (labelText.includes(target) || target.includes(labelText))) {
                        const candidates = Array.from(row.querySelectorAll('select, input, textarea'))
                            .filter(el => el.type !== 'hidden' && el.type !== 'button' && el.type !== 'submit')
                            .filter(el => this.isElementVisible(el));
                        if (candidates.length) return candidates;
                    }
                }
                return [];
            };

            const selectNative = (selectEl, rawValue) => {
                const candidates = [String(rawValue), mapEnZh(rawValue)];
                const options = Array.from(selectEl.querySelectorAll('option'));

                const byValue = (v) => options.find(o => String(o.value) === String(v));
                const byText = (v) => options.find(o => scoreSemanticMatch(o.textContent, v) >= 0.8);

                let chosen = null;
                for (const c of candidates) {
                    chosen = byValue(c);
                    if (chosen) break;
                }
                if (!chosen) {
                    for (const c of candidates) {
                        chosen = byText(c);
                        if (chosen) break;
                    }
                }

                if (!chosen) return { ok: false, reason: 'no_match' };

                selectEl.focus?.();
                try { selectEl.click?.(); } catch (_) {}
                selectEl.value = chosen.value;
                chosen.selected = true;
                selectEl.dispatchEvent(new Event('input', { bubbles: true }));
                selectEl.dispatchEvent(new Event('change', { bubbles: true }));
                return { ok: true, chosenText: (chosen.textContent || '').trim(), chosenValue: chosen.value };
            };

            const selectCustom = async (triggerEl, rawValue) => {
                const candidates = [String(rawValue), mapEnZh(rawValue)];
                triggerEl.focus?.();
                try { triggerEl.click?.(); } catch (_) {}
                await waitFor(50);

                const optionSelectors = [
                    '[role="option"]',
                    '[role="listbox"] [data-value]',
                    '.ant-select-item-option',
                    '.ant-select-item-option-content',
                    '.el-select-dropdown__item',
                    '.select2-results__option',
                    'li',
                    'div'
                ];

                const isVisible = (el) => {
                    if (!el) return false;
                    const style = window.getComputedStyle(el);
                    return el.offsetParent !== null && style.visibility !== 'hidden' && style.display !== 'none';
                };

                const collect = () => {
                    const els = [];
                    for (const sel of optionSelectors) {
                        try {
                            els.push(...Array.from(document.querySelectorAll(sel)));
                        } catch (_) {}
                    }
                    const uniq = [...new Set(els)].filter(isVisible);
                    return uniq
                        .map(el => ({ el, text: (el.textContent || '').trim(), value: el.getAttribute('data-value') || el.getAttribute('value') || '' }))
                        .filter(x => x.text.length > 0);
                };

                let opts = collect();
                for (let i = 0; i < 12 && opts.length < 2; i++) {
                    await waitFor(50);
                    opts = collect();
                }

                const match = (opt, c) => {
                    return Math.max(
                        scoreSemanticMatch(opt.text, c),
                        scoreSemanticMatch(opt.value, c)
                    ) >= 0.8;
                };

                let chosen = null;
                for (const c of candidates) {
                    chosen = opts.find(o => match(o, c));
                    if (chosen) break;
                }
                if (!chosen) return { ok: false, reason: 'no_match' };

                try { chosen.el.click?.(); } catch (_) {}
                chosen.el.dispatchEvent?.(new Event('click', { bubbles: true }));
                chosen.el.dispatchEvent?.(new Event('change', { bubbles: true }));
                return { ok: true, chosenText: chosen.text, chosenValue: chosen.value };
            };

            let allMatchedElements = [];
            let hasScopedSelectorMatches = false;

            if (fieldSelector) {
                try {
                    const directMatches = Array.from(document.querySelectorAll(fieldSelector));
                    directMatches.forEach(el => {
                        if (el.matches && el.matches('input, select, textarea')) {
                            allMatchedElements.push(el);
                        } else {
                            allMatchedElements.push(...Array.from(el.querySelectorAll('input, select, textarea')));
                        }
                    });
                    hasScopedSelectorMatches = allMatchedElements.length > 0;
                } catch (e) {}
            }

            if (!hasScopedSelectorMatches) {
                // 鏌ユ壘鎵€鏈夊彲鑳界殑鍖归厤鍏冪礌
                const selectors = [
                    `[name="${fieldName}"]`,
                    `#${fieldName}`,
                    `input[name="${fieldName}"]`,
                    `select[name="${fieldName}"]`,
                    `textarea[name="${fieldName}"]`,
                    `[aria-label="${fieldName}"]`,
                    `[placeholder="${fieldName}"]`
                ];

                selectors.forEach(selector => {
                    try {
                        const found = Array.from(document.querySelectorAll(selector));
                        allMatchedElements = allMatchedElements.concat(found);
                    } catch (e) {}
                });
            }

            // 鍘婚噸骞跺彧淇濈暀鍙鍏冪礌
            let uniqueElements = [...new Set(allMatchedElements)].filter(el => this.isElementVisible(el));

            if (uniqueElements.length === 0 && !hasScopedSelectorMatches) {
                const byRow = findFieldRowElements(fieldName);
                if (byRow.length) {
                    uniqueElements = byRow;
                }
            }

            if (uniqueElements.length === 0 && !hasScopedSelectorMatches) {
                // 濡傛灉娌℃湁鎵惧埌绮剧‘鍖归厤锛屽皾璇曢€氳繃鏍囩鏂囨湰妯＄硦鏌ユ壘
                const allInputs = Array.from(document.querySelectorAll('input, select, textarea'));
                for (const input of allInputs) {
                    if (!this.isElementVisible(input)) continue;
                    
                    const label = this.getElementLabel(input).toLowerCase();
                    const name = (input.name || '').toLowerCase();
                    const id = (input.id || '').toLowerCase();
                    const fieldKey = fieldName.toLowerCase();

                    if (label.includes(fieldKey) || name.includes(fieldKey) || id.includes(fieldKey)) {
                        uniqueElements.push(input);
                    }
                }
            }

            if (uniqueElements.length === 0 && !hasScopedSelectorMatches) {
                const target = normalize(fieldName);
                const candidates = Array.from(document.querySelectorAll('select, input:not([type="hidden"]), textarea'))
                    .filter(el => this.isElementVisible(el));
                for (const el of candidates) {
                    const scopeText = normalize(el.closest('.field-row, .form-group, tr, td, div')?.textContent || '');
                    if (scopeText.includes(target)) {
                        uniqueElements.push(el);
                    }
                }
            }

            if (uniqueElements.length === 0) {
                sendResponse({ success: false, message: `鏈壘鍒板瓧娈?"${fieldName}"` });
                return;
            }

            // 閫夋嫨鏈€鍚堥€傜殑鍏冪礌锛堟敮鎸佽捣濮?缁堟绛夊瓙瀛楁銆佷互鍙?[1]/[2] 搴忓彿锛?
            let targetField = chooseBestElement(uniqueElements, fieldName) || uniqueElements[0];

            // 鏍规嵁瀛楁绫诲瀷濉啓
            const tagName = targetField.tagName.toLowerCase();
            const type = targetField.type;

            if (tagName === 'select') {
                const r = selectNative(targetField, value);
                if (r.ok) {
                    sendResponse({ success: true, message: `涓嬫媺妗?"${fieldName}" 閫夋嫨鎴愬姛: ${r.chosenText || value}` });
                    return;
                }
                const r2 = await selectCustom(targetField, value);
                if (r2.ok) {
                    sendResponse({ success: true, message: `涓嬫媺妗?"${fieldName}" 閫夋嫨鎴愬姛: ${r2.chosenText || value}` });
                } else {
                    sendResponse({ success: false, message: `涓嬫媺妗?"${fieldName}" 鏈壘鍒板尮閰嶉€夐」: ${value}` });
                }
            } else if (type === 'checkbox' || type === 'radio') {
                let matched = false;
                const requestedValues = Array.isArray(value)
                    ? value
                    : String(value || '').split(/[;；,\n]+/).map(item => item.trim()).filter(Boolean);

                const getCandidates = (values) => {
                    const arr = [];
                    const alias = {
                        'english': ['英文', 'English', '外文'],
                        'en': ['英文', 'English', '外文'],
                        'chinese': ['中文', 'Chinese'],
                        'zh': ['中文', 'Chinese'],
                        'yes': ['是', 'Yes'],
                        'no': ['否', 'No'],
                        'openaccess': ['开放获取', '开放获取(OA)论文出版物', 'OA'],
                        'oa': ['开放获取', '开放获取(OA)论文出版物', 'OA'],
                        'closedaccess': ['非开放获取', '非开放获取论文出版物'],
                        'nonopenaccess': ['非开放获取', '非开放获取论文出版物'],
                        'scie': ['SCIE'],
                        'ssci': ['SSCI'],
                        'ei': ['EI'],
                        'cssci': ['CSSCI'],
                        'istp': ['ISTP']
                    };
                    values.forEach(item => {
                        const raw = String(item || '').trim();
                        if (!raw) return;
                        arr.push(raw);
                        const normalized = raw.toLowerCase();
                        if (alias[normalized]) arr.push(...alias[normalized]);
                    });
                    return [...new Set(arr)];
                };

                const matchLabel = (labelText, candidates) => {
                    for (const c of candidates) {
                        if (scoreSemanticMatch(labelText, c) >= 0.8) return true;
                    }
                    return false;
                };

                const target = normalize(fieldName);
                let groupRow = null;
                const rows = Array.from(document.querySelectorAll('.field-row'));
                for (const row of rows) {
                    const lab = row.querySelector('.field-label');
                    if (lab && normalize(lab.textContent).includes(target)) {
                        groupRow = row;
                        break;
                    }
                }

                let groupFields = uniqueElements.filter(el => el.type === type);
                if (!groupFields.length && groupRow) {
                    groupFields = Array.from(groupRow.querySelectorAll(`input[type="${type}"]`)).filter(el => this.isElementVisible(el));
                }
                if (!groupFields.length) {
                    const groupName = targetField.name;
                    if (groupName) {
                        groupFields = Array.from(document.querySelectorAll(`input[name="${groupName}"]`)).filter(el => this.isElementVisible(el));
                    }
                }
                if (!groupFields.length) {
                    groupFields = uniqueElements.filter(el => el.type === type);
                }

                const candidates = getCandidates(requestedValues);
                const getTextFor = (el) => {
                    let t = this.getElementLabel(el);
                    if (!t) {
                        const ns = el.nextSibling;
                        if (ns && ns.nodeType === Node.TEXT_NODE) {
                            t = ns.textContent.trim();
                        }
                    }
                    return t || el.value || '';
                };

                if (type === 'radio') {
                    for (const gf of groupFields) {
                        const t = getTextFor(gf);
                        if (matchLabel(t, candidates) || matchLabel(gf.value, candidates)) {
                            groupFields.forEach(f => f.checked = false);
                            try { gf.click(); } catch (_) {}
                            gf.checked = true;
                            gf.dispatchEvent(new Event('change', { bubbles: true }));
                            matched = true;
                            break;
                        }
                    }
                } else {
                    groupFields.forEach(f => { f.checked = false; });
                    let matchCount = 0;
                    for (const gf of groupFields) {
                        const t = getTextFor(gf);
                        if (matchLabel(t, candidates) || matchLabel(gf.value, candidates)) {
                            try { gf.click(); } catch (_) {}
                            gf.checked = true;
                            gf.dispatchEvent(new Event('change', { bubbles: true }));
                            matchCount++;
                        }
                    }
                    matched = matchCount > 0;
                }

                if (matched) {
                    sendResponse({ success: true, message: `选择框 "${fieldName}" 设置成功: ${Array.isArray(value) ? value.join('；') : value}` });
                } else {
                    sendResponse({ success: false, message: `选择框 "${fieldName}" 未找到匹配项: ${Array.isArray(value) ? value.join('；') : value}` });
                }
            } else {
                // 鏅€氳緭鍏ユ
                
                // 灏濊瘯鏅鸿兘鏃ユ湡鎷嗗垎閫昏緫
                // 鐢ㄦ埛闇€姹傦細濡傛灉瀛楁鎵€鍦ㄨ鏈?涓緭鍏ユ锛屽皾璇曟寜 骞?鏈?鏃?鎷嗗垎濉啓
                const dateParts = this.parseDateString(value);
                if (dateParts) {
                    const row = targetField.closest('.field-row') || targetField.parentElement;
                    if (row) {
                        // 鏌ユ壘琛屽唴鎵€鏈夊彲瑙佽緭鍏ユ
                        const visibleInputs = Array.from(row.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"])'))
                            .filter(el => this.isElementVisible(el));
                        
                        // 瑙勫垯锛氬鏋滆鍐呮濂芥湁3涓緭鍏ユ锛屼笖褰撳墠鐩爣瀛楁鍦ㄥ叾涓?
                        // 鎴戜滑鍋囪杩欎笁涓鍒嗗埆鏄?骞淬€佹湀銆佹棩
                        if (visibleInputs.length === 3 && visibleInputs.includes(targetField)) {
                             console.log('妫€娴嬪埌鏃ユ湡鍒嗘爮锛?涓緭鍏ユ锛夛紝灏濊瘯鏅鸿兘鎷嗗垎濉啓...');
                             const [yInput, mInput, dInput] = visibleInputs;
                             
                             // 濉啓骞翠唤
                             yInput.value = dateParts.year;
                             yInput.dispatchEvent(new Event('input', { bubbles: true }));
                             yInput.dispatchEvent(new Event('change', { bubbles: true }));

                             // 濉啓鏈堜唤
                             // 妫€鏌ユ湀浠借緭鍏ユ鏄惁鏈?min/max 闄愬埗锛屾垨鑰?placeholder 鏄惁鏆楃ず鏍煎紡
                             mInput.value = dateParts.month;
                             mInput.dispatchEvent(new Event('input', { bubbles: true }));
                             mInput.dispatchEvent(new Event('change', { bubbles: true }));

                             // 濉啓鏃ユ湡
                             dInput.value = dateParts.day;
                             dInput.dispatchEvent(new Event('input', { bubbles: true }));
                             dInput.dispatchEvent(new Event('change', { bubbles: true }));
                             
                             sendResponse({ success: true, message: `鏃ユ湡瀛楁 "${fieldName}" 鏅鸿兘鎷嗗垎濉啓鎴愬姛: ${value} -> ${dateParts.year}-${dateParts.month}-${dateParts.day}` });
                             return;
                        }
                    }
                }

                targetField.value = value;
                targetField.dispatchEvent(new Event('input', { bubbles: true }));
                targetField.dispatchEvent(new Event('change', { bubbles: true }));
                targetField.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
                targetField.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
                
                sendResponse({ success: true, message: `瀛楁 "${fieldName}" 濉啓鎴愬姛: ${value}` });
            }
        } catch (error) {
            sendResponse({ success: false, message: `濉啓瀛楁澶辫触: ${error.message}` });
        }
    }

    getPageElements(selector, sendResponse) {
        /**
         * 鑾峰彇椤甸潰鍏冪礌淇℃伅
         */
        try {
            const elements = Array.from(document.querySelectorAll(selector));
            const elementInfo = elements.map(el => ({
                tagName: el.tagName.toLowerCase(),
                id: el.id,
                name: el.name,
                type: el.type,
                placeholder: el.placeholder,
                value: el.value,
                required: el.hasAttribute('required'),
                readonly: el.hasAttribute('readonly'),
                disabled: el.hasAttribute('disabled'),
                label: this.getElementLabel(el),
                xpath: this.getElementXPath(el),
                rect: el.getBoundingClientRect(),
                isVisible: this.isElementVisible(el)
            }));
            
            sendResponse({
                success: true,
                count: elementInfo.length,
                elements: elementInfo
            });
        } catch (error) {
            sendResponse({
                success: false,
                message: `鑾峰彇椤甸潰鍏冪礌澶辫触: ${error.message}`
            });
        }
    }

    getElementXPath(element) {
        /**
         * 鑾峰彇鍏冪礌鐨刋Path
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

    isElementVisible(element) {
        /**
         * 妫€鏌ュ厓绱犳槸鍚﹀彲瑙?
         */
        const style = window.getComputedStyle(element);
        return element.offsetParent !== null && 
               style.visibility !== 'hidden' && 
               style.display !== 'none' &&
               !element.disabled;
    }

    /**
     * 鐐瑰嚮鎸囧畾閫夋嫨鍣ㄧ殑鍏冪礌
     * @param {string} selector - CSS 閫夋嫨鍣?
     * @param {function} sendResponse - 鍥炶皟鍑芥暟
     */
    // 鍦?clickElement 鏂规硶涓鍔?XPath 鏀寔
    clickElement(selector, sendResponse) {
        try {
            let element;
            if (selector.startsWith('//')) {
                // XPath
                const result = document.evaluate(selector, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                element = result.singleNodeValue;
            } else {
                element = document.querySelector(selector);
            }
            if (!element) {
                sendResponse({ success: false, message: `鏈壘鍒板厓绱? ${selector}` });
                return;
            }
            element.click();
            sendResponse({ success: true, message: '已点击元素' });
        } catch (error) {
            sendResponse({ success: false, message: `鐐瑰嚮鍏冪礌澶辫触: ${error.message}` });
        }
    }
}

// 鍒濆鍖栧唴瀹硅剼鏈?
(function() {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            window.formFillingScriptLoaded = true;
            new FormFillingContentScript();
        });
    } else {
        window.formFillingScriptLoaded = true;
        new FormFillingContentScript();
    }
})();

