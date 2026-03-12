/**
 * JavaScript表单操作工具
 */

class FormFiller {
    /**
     * 交互式网页表单填写器 - JavaScript版本
     */
    constructor(parser) {
        this.parser = parser;
        this.filledFields = {};
    }

    async fillFieldInteractive(fieldName, value, fieldInfo = null) {
        /**
         * 交互式填写单个字段
         */
        try {
            // 针对复合字段（date_range）的特殊处理
            if (fieldInfo && fieldInfo.isComposite && fieldInfo.inputs) {
                // 简单的分割逻辑：按“至”、“-”、“~”、“,”分割，但也支持用户直接给一个值（如果是互斥字段）
                const subValues = String(value).split(/\s*[至\-~,，]\s*/).map(v => v.trim());
                let successCount = 0;
                
                // 判断是否是“或”关系（发表日期）
                const isOrRelation = fieldInfo.connector && (fieldInfo.connector.includes('或') || fieldInfo.connector.includes('or'));
                
                for (let i = 0; i < fieldInfo.inputs.length; i++) {
                    const subInput = fieldInfo.inputs[i];
                    let valToFill = subValues[i];

                    if (isOrRelation) {
                        // 对于“或”关系：
                        // 如果用户只提供了一个值，默认填第一个空，第二个空留白。
                        // 如果提供了两个值（显式分隔），则依次填。
                        if (i === 0) {
                            valToFill = valToFill || subValues[0]; // 总是填第一个
                        } else {
                            // 第二个空仅当用户显式提供了第二个值时才填
                            if (!valToFill) continue;
                        }
                    } else {
                        // 对于“至”关系（会议日期）：
                        // 必须填两个空。如果用户只给了一个值，可能意味着起止相同，或者数据缺失。
                        // 暂时策略：如果只给一个值，填入第一个空，第二个空尝试复用或留白。
                        if (!valToFill && i > 0) {
                            // 只有起始日期？那结束日期也填一样的？还是留白？
                            // 还是留白比较安全，让用户补全
                            continue;
                        }
                    }

                    if (valToFill) {
                        // 递归调用自身来填写子字段
                        // 注意：这里我们传入 subInput.name 作为 fieldName
                        const result = await this.fillFieldInteractive(subInput.name, valToFill, { type: 'text' });
                        if (result.success) successCount++;
                    }
                }
                
                return {
                    success: successCount > 0,
                    message: `复合字段已填写 ${successCount} 部分`,
                    field: fieldName
                };
            }

            // 查找字段元素
            const element = this._findFormElement(fieldName, fieldInfo);
            
            if (!element) {
                return {
                    success: false,
                    message: `未找到字段元素: ${fieldName}`,
                    field: fieldName
                };
            }
            
            // 根据字段类型填写
            const fieldType = fieldInfo?.type || 'text';
            
            let result;
            if (fieldType === 'select') {
                result = this._fillSelectField(element, value, fieldInfo);
            } else if (fieldType === 'radio' || fieldType === 'checkbox') {
                result = this._fillChoiceField(element, value, fieldName, fieldInfo);
            } else {
                result = this._fillInputField(element, value, fieldInfo);
            }
            
            // 记录已填写的字段
            if (result?.success) {
                this.filledFields[fieldName] = {
                    value: value,
                    fieldInfo: fieldInfo,
                    timestamp: Date.now()
                };
            }
            
            return result;
            
        } catch (e) {
            return {
                success: false,
                message: `填写字段时出错: ${e.message}`,
                field: fieldName
            };
        }
    }

    _findFormElement(fieldName, fieldInfo = null) {
        /**
         * 查找表单元素
         */
        // 尝试多种查找方式
        const selectors = [
            `[name="${fieldName}"]`,
            `#${fieldName}`,
            `input[name="${fieldName}"]`,
            `select[name="${fieldName}"]`,
            `textarea[name="${fieldName}"]`,
            `*[id="${fieldName}"]`,
        ];
        
        if (fieldInfo) {
            if (fieldInfo.xpath) {
                // 尝试使用xpath查找（需要转换为CSS选择器）
                try {
                    const elementFromXPath = this._elementFromXPath(fieldInfo.xpath);
                    if (elementFromXPath) {
                        return elementFromXPath;
                    }
                } catch (e) {
                    console.warn(`XPath查找失败: ${e.message}`);
                }
            }
            
            // 也可以通过label查找
            const label = fieldInfo.label;
            if (label) {
                // 原有的 label + 兄弟节点查找
                selectors.push(`label:contains('${label}') + input, label:contains('${label}') + select, label:contains('${label}') + textarea`);
            }
        }
        
        // 1. 优先尝试精确匹配
        for (const selector of selectors) {
            try {
                // 注意：:contains 不是标准 CSS 选择器，这里仅作为示意，实际 querySelector 会报错
                // 应该在后面用 JS 逻辑处理 label 查找
                if (!selector.includes(':contains')) {
                    const element = document.querySelector(selector);
                    if (element && this._isElementVisible(element)) {
                        return element;
                    }
                }
            } catch (e) {
                // 忽略无效选择器错误
            }
        }

        // 2. 如果没找到，尝试按组标签（.field-row > .field-label）查找
        // 针对 testform.html 这种结构，字段名往往就是组标签名
        const normalize = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');
        const targetName = normalize(fieldName);
        
        const rows = Array.from(document.querySelectorAll('.field-row'));
        for (const row of rows) {
            const labelDiv = row.querySelector('.field-label');
            if (labelDiv && normalize(labelDiv.textContent).includes(targetName)) {
                // 找到了对应的行，在该行内查找输入控件
                // 优先找 select，因为用户报错提到的是“成果类型”下拉框
                const select = row.querySelector('select');
                if (select && this._isElementVisible(select)) return select;
                
                const input = row.querySelector('input:not([type="hidden"])');
                if (input && this._isElementVisible(input)) return input;
                
                const textarea = row.querySelector('textarea');
                if (textarea && this._isElementVisible(textarea)) return textarea;
            }
        }
        
        // 3. 最后尝试模糊匹配 label 标签
        if (fieldInfo && fieldInfo.label) {
            const labels = Array.from(document.querySelectorAll('label'));
            for (const lbl of labels) {
                // 增加更宽松的匹配：移除标点符号
                const lblText = normalize(lbl.textContent).replace(/[*:：]/g, '');
                const targetText = normalize(fieldInfo.label).replace(/[*:：]/g, '');
                
                if (lblText.includes(targetText) || targetText.includes(lblText)) {
                    const id = lbl.getAttribute('for');
                    if (id) {
                        const el = document.getElementById(id);
                        if (el && this._isElementVisible(el)) return el;
                    }
                    // 或者是 label 内部的 input
                    const el = lbl.querySelector('input, select, textarea');
                    if (el && this._isElementVisible(el)) return el;
                }
            }
        }
        
        // 4. 终极回退：遍历所有可见的 select/input，看其关联文本是否包含字段名
        // 这对于没有 label 标签，只用 div/span 显示文字的表单很有效
        const candidates = Array.from(document.querySelectorAll('select, input:not([type="hidden"]), textarea'));
        for (const el of candidates) {
            if (!this._isElementVisible(el)) continue;
            
            // 获取该元素的所有可能关联文本
            const labelText = normalize(this._getElementLabelText(el));
            const rowText = normalize(el.closest('.field-row, .form-group, tr')?.textContent || '');
            const targetName = normalize(fieldName);
            
            if (labelText.includes(targetName) || rowText.includes(targetName)) {
                return el;
            }
        }

        return null;
    }

    _elementFromXPath(xpath) {
        /**
         * 从XPath获取元素（简化版）
         */
        try {
            // 如果传入的是 undefined 或 null，直接返回 null
            if (!xpath) return null;
            
            // 确保 document 上有 evaluate 方法
            if (!document.evaluate) {
                console.warn('浏览器不支持 XPath');
                return null;
            }

            const result = document.evaluate(
                xpath,
                document,
                null,
                XPathResult.FIRST_ORDERED_NODE_TYPE,
                null
            );
            return result.singleNodeValue;
        } catch (e) {
            console.warn(`XPath评估失败: ${e.message}`);
            return null;
        }
    }

    _isElementVisible(element) {
        /**
         * 检查元素是否可见且启用
         */
        const style = window.getComputedStyle(element);
        return element.offsetParent !== null && 
               style.visibility !== 'hidden' && 
               style.display !== 'none' &&
               !element.disabled;
    }

    _parseDateString(value) {
        /**
         * 解析日期字符串
         */
        if (!value) return null;
        const str = String(value).trim();
        let match = str.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
        if (match) return { year: match[1], month: match[2].padStart(2, '0'), day: match[3].padStart(2, '0') };
        match = str.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
        if (match) return { year: match[1], month: match[2].padStart(2, '0'), day: match[3].padStart(2, '0') };
        match = str.match(/^(\d{4})(\d{2})(\d{2})$/);
        if (match) return { year: match[1], month: match[2], day: match[3] };
        return null;
    }

    _fillInputField(element, value, fieldInfo) {
        /**
         * 填写输入框
         */
        try {
            // 尝试智能日期拆分
            const dateParts = this._parseDateString(value);
            if (dateParts) {
                const row = element.closest('.field-row') || element.parentElement;
                if (row) {
                    const visibleInputs = Array.from(row.querySelectorAll('input:not([type="hidden"])'))
                        .filter(el => this._isElementVisible(el));
                    
                    if (visibleInputs.length === 3 && visibleInputs.includes(element)) {
                         const [yInput, mInput, dInput] = visibleInputs;
                         yInput.value = dateParts.year;
                         yInput.dispatchEvent(new Event('input', { bubbles: true }));
                         yInput.dispatchEvent(new Event('change', { bubbles: true }));

                         mInput.value = dateParts.month;
                         mInput.dispatchEvent(new Event('input', { bubbles: true }));
                         mInput.dispatchEvent(new Event('change', { bubbles: true }));

                         dInput.value = dateParts.day;
                         dInput.dispatchEvent(new Event('input', { bubbles: true }));
                         dInput.dispatchEvent(new Event('change', { bubbles: true }));
                         
                         return {
                            success: true,
                            message: "日期字段智能拆分填写成功",
                            actualValue: `${dateParts.year}-${dateParts.month}-${dateParts.day}`
                         };
                    }
                }
            }

            // 清空现有内容
            element.value = '';
            
            // 填写新值
            element.value = value;
            
            // 触发相关事件，确保React等框架能检测到变化
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
            
            // 验证填写是否成功
            const actualValue = element.value;
            
            if (actualValue === value || String(value).includes(actualValue)) {
                return {
                    success: true,
                    message: "字段填写成功",
                    actualValue: actualValue
                };
            } else {
                return {
                    success: false,
                    message: `填写验证失败，期望: ${value}，实际: ${actualValue}`,
                    actualValue: actualValue
                };
            }
                
        } catch (e) {
            return {
                success: false,
                message: `填写输入框时出错: ${e.message}`
            };
        }
    }

    _fillSelectField(element, value, fieldInfo) {
        /**
         * 填写下拉框
         */
        try {
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
                    'openaccess': '开放获取',
                    'oa': '开放获取',
                    'closedaccess': '非开放获取',
                    'nonopenaccess': '非开放获取'
                };
                return m[x] || v;
            };
            const normalize = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');
            const options = Array.from(element.querySelectorAll('option'));
            const candidates = [String(value), mapEnZh(value)];
            let selected = false;
            // 值匹配
            for (const c of candidates) {
                const opt = options.find(o => o.value === c);
                if (opt) {
                    element.value = opt.value;
                    element.dispatchEvent(new Event('change', { bubbles: true }));
                    selected = true;
                    break;
                }
            }
            // 文本模糊匹配
            if (!selected) {
                for (const c of candidates) {
                    const opt = options.find(o => normalize(o.textContent).includes(normalize(c)));
                    if (opt) {
                        element.value = opt.value;
                        element.dispatchEvent(new Event('change', { bubbles: true }));
                        selected = true;
                        break;
                    }
                }
            }
            if (!selected) {
                // 直接尝试设置值或索引
                try {
                    element.value = String(value);
                    element.dispatchEvent(new Event('change', { bubbles: true }));
                    selected = true;
                } catch (_) {
                    if (!isNaN(value) && value >= 0) {
                        element.selectedIndex = parseInt(value, 10);
                        element.dispatchEvent(new Event('change', { bubbles: true }));
                        selected = true;
                    }
                }
            }
            if (selected) {
                const actualText = element.options[element.selectedIndex]?.text || "";
                const actualValue = element.value;
                return {
                    success: true,
                    message: "下拉框选择成功",
                    selectedText: actualText,
                    selectedValue: actualValue
                };
            }
            return { success: false, message: `无法选择选项: ${value}` };
                
        } catch (e) {
            return {
                success: false,
                message: `填写下拉框时出错: ${e.message}`
            };
        }
    }

    _fillChoiceField(element, value, fieldName, fieldInfo) {
        /**
         * 填写单选/复选框
         */
        try {
            const fieldTypes = ['radio', 'checkbox'];
            const fieldType = fieldInfo?.type || 'radio';
            
            if (!fieldTypes.includes(fieldType)) {
                return {
                    success: false,
                    message: `不支持的字段类型: ${fieldType}`
                };
            }

            // 1. 尝试按 name 查找
            let elements = Array.from(document.querySelectorAll(`input[type="${fieldType}"][name="${fieldName}"]`));
            
            // 2. 如果按 name 找不到，尝试按组标题查找（针对 testform 这种结构）
            if (!elements.length) {
                const normalize = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');
                const rows = Array.from(document.querySelectorAll('.field-row'));
                let groupRow = null;
                for (const row of rows) {
                    const labelDiv = row.querySelector('.field-label');
                    if (labelDiv && normalize(labelDiv.textContent).includes(normalize(fieldName))) {
                        groupRow = row;
                        break;
                    }
                }
                if (groupRow) {
                    elements = Array.from(groupRow.querySelectorAll(`input[type="${fieldType}"]`));
                }
            }

            if (!elements.length) {
                return {
                    success: false,
                    message: `未找到${fieldType}元素: ${fieldName}`
                };
            }
            
            // 解析值（支持多选，分隔符：分号、逗号、顿号、竖线）
            const selectedValues = String(value).split(/[;,；、|]/).map(v => v.trim()).filter(v => v);
            
            // 中英映射辅助函数
            const mapEnZh = (v) => {
                const x = String(v || '').trim().toLowerCase();
                const m = {
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
                    'istp': 'ISTP',
                    'pku': '北大中文核心期刊',
                    'pkucore': '北大中文核心期刊',
                    'invitedtalk': '特邀报告',
                    'invited': '特邀报告',
                    'poster': '墙报展示',
                    'oral': '分组报告',
                    'talk': '分组报告'
                };
                return m[x] || v;
            };
            
            const normalize = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');
            let selectedCount = 0;
            
            for (const elem of elements) {
                const elemValue = elem.value;
                const elemText = this._getElementLabelText(elem);
                
                // 检查是否应该选择这个选项
                let shouldSelect = false;
                for (const selected of selectedValues) {
                    const mapped = mapEnZh(selected);
                    // 匹配逻辑：值完全匹配 或 文本包含 或 映射后文本包含
                    if (selected && 
                        (normalize(selected) === normalize(elemValue) ||
                         normalize(elemText).includes(normalize(selected)) ||
                         normalize(elemText).includes(normalize(mapped)))) {
                        shouldSelect = true;
                        break;
                    }
                }
                
                // 处理选择状态
                if (shouldSelect && !elem.checked) {
                    elem.click(); // 优先尝试点击以触发框架事件
                    if (!elem.checked) elem.checked = true;
                    elem.dispatchEvent(new Event('change', { bubbles: true }));
                    selectedCount++;
                } else if (!shouldSelect && elem.checked && fieldType === 'checkbox') {
                    // 仅复选框需要取消选择，单选框通常不需要（选了别的自动取消）
                    elem.click();
                    if (elem.checked) elem.checked = false;
                    elem.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
            
            return {
                success: selectedCount > 0,
                message: `选择了 ${selectedCount} 个选项`,
                selectedCount: selectedCount
            };
                
        } catch (e) {
            return {
                success: false,
                message: `填写${fieldInfo?.type || '选项'}时出错: ${e.message}`
            };
        }
    }

    _getElementLabelText(element) {
        /**
         * 获取元素的标签文本
         */
        try {
            const elemId = element.id;
            if (elemId) {
                const label = document.querySelector(`label[for="${elemId}"]`);
                return label ? label.textContent.trim() : '';
            }
        } catch (e) {
            console.warn(`获取标签文本失败: ${e.message}`);
        }
        
        // 查找父元素中的label
        try {
            const parent = element.parentElement;
            const label = parent?.querySelector('label');
            return label ? label.textContent.trim() : '';
        } catch (e) {
            console.warn(`获取父元素标签文本失败: ${e.message}`);
        }
        
        // 查找相邻的文本节点
        try {
            return element.getAttribute('aria-label') || '';
        } catch (e) {
            console.warn(`获取ARIA标签失败: ${e.message}`);
        }
        
        return '';
    }

    getFilledSummary() {
        /**
         * 获取填写摘要
         */
        return {
            totalFilled: Object.keys(this.filledFields).length,
            fields: Object.keys(this.filledFields),
            details: this.filledFields
        };
    }
}

export { FormFiller };
