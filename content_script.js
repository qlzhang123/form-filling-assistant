/**
 * 填表助手内容脚本
 * 用于与目标网页交互，执行DOM操作
 */

class FormFillingContentScript {
    constructor() {
        this.isConnected = false;
        this.initialize();
    }

    initialize() {
        console.log('填表助手内容脚本初始化...');
        
        // 注入字段标签映射到页面
        this.injectFieldLabelMap();
        
        // 监听来自侧边栏的消息
        this.setupMessageListener();
        
        // 监听来自background script的消息
        if (typeof chrome !== 'undefined' && chrome.runtime) {
            chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
                this.handleMessage(request, sender, sendResponse);
                // 返回true表示异步发送响应
                return true;
            });
        }
        
        this.isConnected = true;
        console.log('填表助手内容脚本连接成功');
    }

    injectFieldLabelMap() {
        /**
         * 注入字段标签映射到页面，供脚本使用
         */
        if (!window.fieldLabelMap) {
            window.fieldLabelMap = {
                'name': '姓名',
                'email': '邮箱',
                'phone': '电话',
                'tel': '电话',
                'mobile': '手机',
                'address': '地址',
                'title': '标题',
                'first-name': '名字',
                'last-name': '姓氏',
                'full-name': '全名',
                'organization': '机构',
                'institution': '机构',
                'department': '部门',
                'position': '职位',
                'job-title': '职务',
                'affiliation': '单位',
                'website': '网站',
                'url': '网址',
                'bio': '简介',
                'research': '研究',
                'interests': '兴趣',
                'specialization': '专业',
                'degree': '学位',
                'major': '专业',
                'school': '学校',
                'university': '大学',
                'college': '学院',
                'subject': '主题',
                'topic': '主题',
                'abstract': '摘要',
                'summary': '摘要',
                'comments': '备注',
                'notes': '备注',
                'message': '留言',
                'agree': '同意',
                'accept': '接受',
                'terms': '条款',
                'privacy': '隐私政策'
            };
        }
    }

    setupMessageListener() {
        /**
         * 设置消息监听器
         */
        // 监听来自侧边栏的消息（通过DOM事件）
        document.addEventListener('formFillingMessage', (event) => {
            const { action, data } = event.detail;
            this.handleMessage({ action, data }, null, (response) => {
                // 发送响应回侧边栏
                const responseEvent = new CustomEvent('formFillingResponse', { 
                    detail: { id: event.detail.id, response } 
                });
                document.dispatchEvent(responseEvent);
            });
        });
    }

    handleMessage(request, sender, sendResponse) {
        /**
         * 处理收到的消息
         */
        const { action, data } = request;
        
        console.log('收到消息:', action, data);
        
        switch (action) {
            case 'parseForm':
                this.parseForm(sendResponse);
                break;
                
            case 'fillFormField':
                this.fillFormField(data.fieldName, data.value, sendResponse);
                break;
                
            case 'extractPageContent':
                this.extractPageContent(sendResponse);
                break;
                
            case 'getPageElements':
                this.getPageElements(data.selector || 'form input, form select, form textarea', sendResponse);
                break;
                
            case 'executeCustomScript':
                this.executeCustomScript(data.script, data.args, sendResponse);
                break;
                
            case 'getPageContent':
                // 新增：直接返回页面 HTML，供 Sidebar 中的 FormParser + LLM 使用
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
                console.warn('未知的消息动作:', action);
                sendResponse({ success: false, message: `未知的动作: ${action}` });
                break;
        }
    }

    generateFieldName(element) {
        /**
         * 生成字段名称
         */
        if (element.id) return element.id;
        if (element.name) return element.name;
        
        // 根据标签或其他属性生成名称
        const label = this.getElementLabel(element);
        if (label) {
            return label.replace(/\s+/g, '-').toLowerCase();
        }
        
        // 生成唯一标识符
        return `field_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    getElementLabel(element) {
        /**
         * 获取元素的标签文本
         */
        // 1. 尝试使用 element.labels (标准API)
        if (element.labels && element.labels.length > 0) {
            const labelText = Array.from(element.labels)
                                 .map(l => l.textContent.trim())
                                 .filter(t => t)
                                 .join(' ');
            if (labelText) return labelText;
        }

        // 2. 通过for属性查找label
        if (element.id) {
            const label = document.querySelector(`label[for="${element.id}"]`);
            if (label) {
                const text = label.textContent.trim();
                if (text) return text;
            }
        }

        // 3. 查找父级label
        let parent = element.parentElement;
        while (parent && parent.tagName.toLowerCase() !== 'form' && parent !== document.body) {
            if (parent.tagName.toLowerCase() === 'label') {
                const text = parent.textContent.trim();
                if (text) return text;
            }
            // 如果父元素内有label但不是直接父级
            const internalLabel = parent.querySelector('label');
            if (internalLabel && internalLabel.contains(element)) {
                const text = internalLabel.textContent.trim();
                if (text) return text;
            }
            parent = parent.parentElement;
        }

        // 4. 查找前一个兄弟元素中的label
        let sibling = element.previousElementSibling;
        while (sibling) {
            if (sibling.tagName.toLowerCase() === 'label') {
                return sibling.textContent.trim();
            }
            // 或者是包含文本的span/div
            if (['SPAN', 'DIV', 'TD'].includes(sibling.tagName) && sibling.textContent.trim().length > 0) {
                return sibling.textContent.trim();
            }
            sibling = sibling.previousElementSibling;
        }

        // 5. 查找aria-label或title或placeholder
        return element.getAttribute('aria-label') || 
               element.title || 
               element.placeholder || 
               '';
    }

    getFieldOptions(input) {
        /**
         * 获取字段选项（主要用于select、radio、checkbox）
         */
        if (input.tagName.toLowerCase() === 'select') {
            return Array.from(input.querySelectorAll('option')).map(option => ({
                value: option.value,
                text: option.textContent.trim(),
                selected: option.selected
            }));
        } else if (input.type === 'radio' || input.type === 'checkbox') {
            // 对于同名的单选/复选框组
            const groupInputs = document.querySelectorAll(`input[name="${input.name}"]`);
            return Array.from(groupInputs).map(groupInput => ({
                value: groupInput.value,
                text: this.getElementLabel(groupInput),
                checked: groupInput.checked
            }));
        }
        return [];
    }

    getValidationRules(input) {
        /**
         * 获取验证规则
         */
        return {
            required: input.hasAttribute('required'),
            pattern: input.getAttribute('pattern') || null,
            minLength: input.getAttribute('minlength') || null,
            maxLength: input.getAttribute('maxlength') || null,
            min: input.getAttribute('min') || null,
            max: input.getAttribute('max') || null,
            step: input.getAttribute('step') || null,
            type: input.type
        };
    }

    parseDateString(value) {
        /**
         * 解析日期字符串
         * 支持格式：YYYY-MM-DD, YYYY/MM/DD, YYYY.MM.DD, YYYY年MM月DD日
         */
        if (!value) return null;
        const str = String(value).trim();
        
        // 尝试匹配常见格式
        // 1. YYYY-MM-DD 或 YYYY/MM/DD 或 YYYY.MM.DD
        let match = str.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
        if (match) {
            return {
                year: match[1],
                month: match[2].padStart(2, '0'),
                day: match[3].padStart(2, '0')
            };
        }
        
        // 2. YYYY年MM月DD日
        match = str.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
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

    async fillFormField(fieldName, value, sendResponse) {
        /**
         * 填写表单字段
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

            const parseFieldHints = (name) => {
                const raw = String(name || '');
                const idxMatch = raw.match(/\[(\d+)\]\s*$/);
                const indexHint = idxMatch ? parseInt(idxMatch[1], 10) : null;

                let groupKey = raw;
                let subKey = '';

                // 支持：字段 - 子字段
                const dashParts = raw.split(/\s*[-－—–]\s*/);
                if (dashParts.length >= 2) {
                    groupKey = dashParts[0];
                    subKey = dashParts.slice(1).join('-');
                }

                // 支持：字段 (子字段) / 字段（子字段）
                const parenMatch = raw.match(/[（(]\s*([^）)]+)\s*[）)]/);
                if (parenMatch) {
                    groupKey = raw.replace(parenMatch[0], '').trim();
                    subKey = parenMatch[1].trim();
                }

                // 去掉序号后缀对 groupKey 的影响
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
                        // 特殊关键词增强（起始/终止/开始/结束）
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

                    // 轻微倾向：同类元素更优（例如包含 “页” 的输入优先 input）
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
                const byText = (v) => options.find(o => normalize(o.textContent).includes(normalize(v)));

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
                    const t = normalize(opt.text);
                    const v = normalize(opt.value);
                    const x = normalize(c);
                    return (v && (v === x || v.includes(x) || x.includes(v))) || (t && (t === x || t.includes(x) || x.includes(t)));
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

            // 查找所有可能的匹配元素
            const selectors = [
                `[name="${fieldName}"]`,
                `#${fieldName}`,
                `input[name="${fieldName}"]`,
                `select[name="${fieldName}"]`,
                `textarea[name="${fieldName}"]`,
                `[aria-label="${fieldName}"]`,
                `[placeholder="${fieldName}"]`
            ];

            let allMatchedElements = [];
            selectors.forEach(selector => {
                try {
                    const found = Array.from(document.querySelectorAll(selector));
                    allMatchedElements = allMatchedElements.concat(found);
                } catch (e) {}
            });

            // 去重并只保留可见元素
            let uniqueElements = [...new Set(allMatchedElements)].filter(el => this.isElementVisible(el));

            if (uniqueElements.length === 0) {
                const byRow = findFieldRowElements(fieldName);
                if (byRow.length) {
                    uniqueElements = byRow;
                }
            }

            if (uniqueElements.length === 0) {
                // 如果没有找到精确匹配，尝试通过标签文本模糊查找
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

            if (uniqueElements.length === 0) {
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
                sendResponse({ success: false, message: `未找到字段 "${fieldName}"` });
                return;
            }

            // 选择最合适的元素（支持起始/终止等子字段、以及 [1]/[2] 序号）
            let targetField = chooseBestElement(uniqueElements, fieldName) || uniqueElements[0];

            // 根据字段类型填写
            const tagName = targetField.tagName.toLowerCase();
            const type = targetField.type;

            if (tagName === 'select') {
                const r = selectNative(targetField, value);
                if (r.ok) {
                    sendResponse({ success: true, message: `下拉框 "${fieldName}" 选择成功: ${r.chosenText || value}` });
                    return;
                }
                const r2 = await selectCustom(targetField, value);
                if (r2.ok) {
                    sendResponse({ success: true, message: `下拉框 "${fieldName}" 选择成功: ${r2.chosenText || value}` });
                } else {
                    sendResponse({ success: false, message: `下拉框 "${fieldName}" 未找到匹配选项: ${value}` });
                }
            } else if (type === 'checkbox' || type === 'radio') {
                // 单选/复选框逻辑（增强：优先按字段行聚合，再匹配中文/英文等同义）
                let matched = false;

                const getCandidates = (v) => {
                    const arr = [String(v)];
                    const n = String(v).trim().toLowerCase();
                    // 常见别名映射
                    const alias = {
                        'english': ['英文', 'English', '外文'],
                        'en': ['英文', 'English', '外文'],
                        'chinese': ['中文', 'Chinese'],
                        'zh': ['中文', 'Chinese'],
                        'yes': ['是', 'Yes'],
                        'no': ['否', 'No']
                    };
                    if (alias[n]) arr.push(...alias[n]);
                    return [...new Set(arr)];
                };

                const matchLabel = (labelText, candidates) => {
                    const lt = normalize(labelText);
                    for (const c of candidates) {
                        const ct = normalize(c);
                        if (!ct) continue;
                        if (lt === ct || lt.includes(ct) || ct.includes(lt)) return true;
                    }
                    return false;
                };

                // 尝试按字段行聚合
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

                let groupFields = [];
                if (groupRow) {
                    groupFields = Array.from(groupRow.querySelectorAll(`input[type="${type}"]`)).filter(el => this.isElementVisible(el));
                }
                // 如果没找到行，退回到按 name 分组
                if (!groupFields.length) {
                    const groupName = targetField.name;
                    if (groupName) {
                        groupFields = Array.from(document.querySelectorAll(`input[name="${groupName}"]`)).filter(el => this.isElementVisible(el));
                    } else {
                        groupFields = uniqueElements.filter(el => el.type === type);
                    }
                }

                const candidates = getCandidates(value);
                const getTextFor = (el) => {
                    let t = this.getElementLabel(el);
                    if (!t) {
                        // 尝试相邻文本节点
                        const ns = el.nextSibling;
                        if (ns && ns.nodeType === Node.TEXT_NODE) {
                            t = ns.textContent.trim();
                        }
                    }
                    return t || el.value || '';
                };

                for (const gf of groupFields) {
                    const t = getTextFor(gf);
                    if (matchLabel(t, candidates) || matchLabel(gf.value, candidates)) {
                        if (gf.type === 'radio') {
                            groupFields.forEach(f => f.checked = false);
                        }
                        try { gf.click(); } catch (_) {}
                        gf.checked = true;
                        gf.dispatchEvent(new Event('change', { bubbles: true }));
                        matched = true;
                        break;
                    }
                }
                
                if (matched) {
                    sendResponse({ success: true, message: `选择框 "${fieldName}" 设置成功: ${value}` });
                } else {
                    // 如果作为选择框匹配失败，且有同名的文本框，尝试作为文本框填写
                    const textFallback = uniqueElements.find(el => 
                        el.tagName === 'TEXTAREA' || 
                        (el.tagName === 'INPUT' && !['radio', 'checkbox'].includes(el.type))
                    );
                    if (textFallback) {
                        textFallback.value = value;
                        textFallback.dispatchEvent(new Event('input', { bubbles: true }));
                        textFallback.dispatchEvent(new Event('change', { bubbles: true }));
                        sendResponse({ success: true, message: `选择框匹配失败，已回退到文本框填写: ${value}` });
                    } else {
                        sendResponse({ success: false, message: `选择框 "${fieldName}" 未找到匹配项: ${value}` });
                    }
                }
            } else {
                // 普通输入框
                
                // 尝试智能日期拆分逻辑
                // 用户需求：如果字段所在行有3个输入框，尝试按 年-月-日 拆分填写
                const dateParts = this.parseDateString(value);
                if (dateParts) {
                    const row = targetField.closest('.field-row') || targetField.parentElement;
                    if (row) {
                        // 查找行内所有可见输入框
                        const visibleInputs = Array.from(row.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"])'))
                            .filter(el => this.isElementVisible(el));
                        
                        // 规则：如果行内正好有3个输入框，且当前目标字段在其中
                        // 我们假设这三个框分别是 年、月、日
                        if (visibleInputs.length === 3 && visibleInputs.includes(targetField)) {
                             console.log('检测到日期分栏（3个输入框），尝试智能拆分填写...');
                             const [yInput, mInput, dInput] = visibleInputs;
                             
                             // 填写年份
                             yInput.value = dateParts.year;
                             yInput.dispatchEvent(new Event('input', { bubbles: true }));
                             yInput.dispatchEvent(new Event('change', { bubbles: true }));

                             // 填写月份
                             // 检查月份输入框是否有 min/max 限制，或者 placeholder 是否暗示格式
                             mInput.value = dateParts.month;
                             mInput.dispatchEvent(new Event('input', { bubbles: true }));
                             mInput.dispatchEvent(new Event('change', { bubbles: true }));

                             // 填写日期
                             dInput.value = dateParts.day;
                             dInput.dispatchEvent(new Event('input', { bubbles: true }));
                             dInput.dispatchEvent(new Event('change', { bubbles: true }));
                             
                             sendResponse({ success: true, message: `日期字段 "${fieldName}" 智能拆分填写成功: ${value} -> ${dateParts.year}-${dateParts.month}-${dateParts.day}` });
                             return;
                        }
                    }
                }

                targetField.value = value;
                targetField.dispatchEvent(new Event('input', { bubbles: true }));
                targetField.dispatchEvent(new Event('change', { bubbles: true }));
                targetField.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
                targetField.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
                
                sendResponse({ success: true, message: `字段 "${fieldName}" 填写成功: ${value}` });
            }
        } catch (error) {
            sendResponse({ success: false, message: `填写字段失败: ${error.message}` });
        }
    }

    extractPageContent(sendResponse) {
        /**
         * 提取页面内容
         */
        try {
            const content = {
                title: document.title,
                url: window.location.href,
                headings: Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
                             .map(el => el.textContent.trim())
                             .filter(text => text.length > 0),
                paragraphs: Array.from(document.querySelectorAll('p'))
                               .map(el => el.textContent.trim())
                               .filter(text => text.length > 20)
                               .slice(0, 20), // 限制数量
                links: Array.from(document.querySelectorAll('a[href]'))
                          .map(a => ({ 
                              text: a.textContent.trim(), 
                              href: a.href,
                              title: a.title
                          }))
                          .filter(a => a.text && a.href)
                          .slice(0, 20),
                forms: Array.from(document.querySelectorAll('form'))
                         .map(form => ({
                             action: form.action,
                             method: form.method,
                             id: form.id,
                             inputs: Array.from(form.querySelectorAll('input, select, textarea'))
                                       .map(input => ({
                                           name: input.name || input.id,
                                           type: input.type,
                                           value: input.value,
                                           required: input.hasAttribute('required'),
                                           placeholder: input.placeholder
                                       }))
                         })),
                images: Array.from(document.querySelectorAll('img[src]'))
                            .map(img => ({ 
                                src: img.src, 
                                alt: img.alt,
                                title: img.title 
                            }))
                            .slice(0, 10),
                metadata: {
                    description: document.querySelector('meta[name="description"]')?.content || '',
                    keywords: document.querySelector('meta[name="keywords"]')?.content || '',
                    author: document.querySelector('meta[name="author"]')?.content || '',
                    viewport: document.querySelector('meta[name="viewport"]')?.content || ''
                },
                timestamp: new Date().toISOString()
            };
            
            sendResponse({
                success: true,
                content: content
            });
        } catch (error) {
            sendResponse({
                success: false,
                message: `提取页面内容失败: ${error.message}`
            });
        }
    }

    getPageElements(selector, sendResponse) {
        /**
         * 获取页面元素信息
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
                message: `获取页面元素失败: ${error.message}`
            });
        }
    }

    getElementXPath(element) {
        /**
         * 获取元素的XPath
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
         * 检查元素是否可见
         */
        const style = window.getComputedStyle(element);
        return element.offsetParent !== null && 
               style.visibility !== 'hidden' && 
               style.display !== 'none' &&
               !element.disabled;
    }

    executeCustomScript(script, args, sendResponse) {
        /**
         * 执行自定义脚本
         */
        try {
            // 注意：在内容脚本中不能直接eval，因为CSP策略通常禁止
            // 我们需要通过更安全的方式执行
            const result = this.safeExecuteScript(script, args);
            sendResponse({
                success: true,
                result: result
            });
        } catch (error) {
            sendResponse({
                success: false,
                message: `执行脚本失败: ${error.message}`
            });
        }
    }

    safeExecuteScript(script, args) {
        /**
         * 安全执行脚本的辅助方法
         * 这里只是示例，实际应用中需要更严格的安全措施
         */
        // 由于安全限制，我们只能执行预定义的函数
        // 在实际应用中，应该只允许执行白名单中的操作
        console.warn('安全警告：不允许执行任意脚本');
        return '由于安全限制，无法执行自定义脚本';
    }

    /**
     * 点击指定选择器的元素
     * @param {string} selector - CSS 选择器
     * @param {function} sendResponse - 回调函数
     */
    // 在 clickElement 方法中增加 XPath 支持
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
                sendResponse({ success: false, message: `未找到元素: ${selector}` });
                return;
            }
            element.click();
            sendResponse({ success: true, message: '已点击元素' });
        } catch (error) {
            sendResponse({ success: false, message: `点击元素失败: ${error.message}` });
        }
    }
}

// 初始化内容脚本
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
