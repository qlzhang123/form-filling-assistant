/**
 * JavaScript网页表单解析器
 */

class FormParser {
    /**
     * 网页表单解析器 - JavaScript版本
     */
    constructor() {
        this.document = null;
    }

    async loadForm(url, loginInfo = null) {
        /**
         * 加载网页表单 - 在浏览器扩展环境中，我们直接分析当前页面
         */
        try {
            // 在content script中，我们可以直接访问当前页面的DOM
            this.document = document;
            return true;
        } catch (e) {
            console.error(`❌ 加载网页失败: ${e}`);
            return false;
        }
    }

    async analyzeFormStructureViaLLM(llmClient) {
        /**
         * 使用 LLM 分析页面 HTML 结构以识别字段类型和分组
         * 返回字段的更正信息
         */
        if (!llmClient || !this.document) return null;

        try {
            // 获取简化的 HTML 结构（仅保留表单相关部分）
            const simplifiedHTML = this._getSimplifiedFormHTML();
            
            const messages = [
                {
                    role: 'system',
                    content: `你是一个 HTML 表单结构分析专家。你的任务是分析给定的 HTML 片段，识别出表单中的字段结构。
请特别注意以下几点：
1. **字段分组**：如果一个字段名（Label）控制多个输入框（Input），请将它们分到一个小组（Group）。
2. **关系识别**：对于小组内的字段，请识别它们之间的逻辑关系：
    - **AND**：所有空都需要填写（例如：姓名、电话）。
    - **OR**：只需填写其中一个（例如：发表日期 A 或 发表日期 B，或者二选一的互斥字段）。
    - **RANGE**：起始和结束关系（例如：会议日期的开始和结束，年份的起止）。
    - **TABLE**：表格结构，需要逐行填写。
3. **表格识别**：对于 HTML 表格（table），请识别为 type="table"，并列出所有可填写的列。
4. **单选/复选**：视觉上属于同一行或同一组的单选/复选框（如“语言”后的“中文”、“英文”），必须识别为一个单一字段（type="radio" or "checkbox"）。

请返回一个 JSON 数组，每个元素可以是一个 **字段 (Field)** 或一个 **组 (Group)**。

**字段 (Field) 结构**：
- type: "text", "select", "radio", "checkbox", "date", "number" 等
- name: 字段名（优先使用 name 属性）
- label: 字段显示标签
- category: "fill_in_the_blank" 或 "multiple_choice"
- options: (可选) 选项列表

**组 (Group) 结构**：
- type: "group"
- label: 组名（例如 "会议日期", "发表日期"）
- relationship: "and" | "or" | "range"
- children: [ ... 嵌套的字段或组 ... ]

**表格 (Table) 结构**：
- type: "table"
- label: 表格名
- columns: [ { label: "列名", type: "text/select..." }, ... ]

HTML 片段如下：
\`\`\`html
${simplifiedHTML}
\`\`\`

请只返回 JSON 数组，不要包含其他解释。`
                }
            ];

            const response = await llmClient.think(messages);
            // 尝试解析 JSON
            const jsonMatch = response.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[0]);
            }
            return null;
        } catch (error) {
            console.error('LLM 分析表单结构失败:', error);
            return null;
        }
    }

    _getSimplifiedFormHTML() {
        /**
         * 获取简化的表单 HTML（仅包含关键结构，包括表格）
         */
        if (!this.document) return '';
        
        const clone = this.document.body.cloneNode(true);
        
        // 移除无关元素
        const toRemove = clone.querySelectorAll('script, style, link, svg, img, iframe, nav, footer, header');
        toRemove.forEach(el => el.remove());
        
        // 仅保留表单容器或 form
        const formContainer = clone.querySelector('.form-container') || clone.querySelector('form') || clone;
        
        // 构建简化 HTML
        let simplifiedHTML = '';
        
        // 1. 提取所有 .field-row（常规表单行）
        const rows = Array.from(formContainer.querySelectorAll('.field-row'));
        if (rows.length > 0) {
            simplifiedHTML += '<!-- 常规表单字段 -->\n' + rows.map(r => {
                // 进一步简化行内内容，移除不必要的包装
                return r.outerHTML.replace(/\sclass="[^"]*"/g, '');
            }).join('\n') + '\n';
        }
        
        // 2. 提取所有 table（表格字段）
        const tables = Array.from(formContainer.querySelectorAll('table'));
        if (tables.length > 0) {
            simplifiedHTML += '<!-- 表格字段 -->\n' + tables.map(t => {
                // 仅保留表头和第一行数据作为示例结构
                const thead = t.querySelector('thead')?.outerHTML || '';
                const firstRow = t.querySelector('tbody tr')?.outerHTML || '';
                return `<table>${thead}<tbody>${firstRow}</tbody></table>`;
            }).join('\n');
        }
        
        // 如果没有找到特定结构，回退到提取所有 input/select/textarea 上下文
        if (!simplifiedHTML) {
            const inputs = Array.from(formContainer.querySelectorAll('input, select, textarea'));
            const inputContexts = inputs.map(input => {
                // 获取父级元素作为上下文
                const parent = input.parentElement?.parentElement || input.parentElement;
                return parent ? parent.outerHTML : input.outerHTML;
            });
            simplifiedHTML = inputContexts.slice(0, 20).join('\n'); // 限制数量防止过长
        }
        
        return simplifiedHTML.slice(0, 8000); // 截断以防过长
    }

    extractFormFields(formId = null) {
        /**
         * 提取表单字段信息（DOM 顺序版，修复单选/复选识别问题，增强日期范围识别）
         */
        const fields = [];
        const processedElements = new Set(); // 防止重复处理单选/复选组

        // 查找表单或使用容器降级
        let rootElement = null;
        if (formId) {
            rootElement = this.document.querySelector(`#${formId}`);
        } else {
            rootElement = this.document.querySelector('form');
        }
        if (!rootElement) {
            rootElement = this.document.querySelector('.form-container') || this.document.body;
        }
        if (!rootElement) return fields;

        // 1. 获取所有可能的字段行/组容器，按 DOM 顺序排列
        const fieldRows = Array.from(rootElement.querySelectorAll('.field-row'));
        
        // 如果没有 .field-row，则回退到直接遍历所有输入控件
        if (fieldRows.length === 0) {
            const inputTags = Array.from(rootElement.querySelectorAll('input, select, textarea'));
            for (const tag of inputTags) {
                if (processedElements.has(tag)) continue;
                
                // 跳过隐藏/禁用/按钮
                if (tag.type === 'hidden' || tag.type === 'submit' || tag.type === 'button' || tag.disabled) continue;

                // 针对单选/复选框进行特殊分组处理
                if (tag.type === 'radio' || tag.type === 'checkbox') {
                    const groupName = tag.name;
                    if (groupName) {
                        // 将同名组视为一个字段
                        const groupMembers = Array.from(rootElement.querySelectorAll(`input[type="${tag.type}"][name="${groupName}"]`));
                        groupMembers.forEach(m => processedElements.add(m));
                        
                        const fieldInfo = this._parseGroupField(groupMembers, tag.type);
                        if (fieldInfo) fields.push(fieldInfo);
                    } else {
                        // 无名复选框，作为独立字段
                        const fieldInfo = this._parseFormField(tag);
                        if (fieldInfo) fields.push(fieldInfo);
                        processedElements.add(tag);
                    }
                } else {
                    const fieldInfo = this._parseFormField(tag);
                    if (fieldInfo) fields.push(fieldInfo);
                    processedElements.add(tag);
                }
            }
            return fields;
        }

        // 2. 按行遍历（testform 结构），确保顺序正确
        for (const row of fieldRows) {
            // 获取该行的组标签
            const labelDiv = row.querySelector('.field-label');
            const groupLabel = labelDiv ? labelDiv.textContent.replace(/\*/g, '').trim() : '';

            // 获取该行内的所有输入控件
            const inputs = Array.from(row.querySelectorAll('input, select, textarea'))
                .filter(el => el.type !== 'hidden' && el.type !== 'submit' && el.type !== 'button' && !el.disabled);
            
            if (inputs.length === 0) continue;

            // 检查是否是单选/复选组（特征：多个同类型 input）
            const firstType = inputs[0].type;
            const isChoiceGroup = (firstType === 'radio' || firstType === 'checkbox') && inputs.length > 0;
            
            // 特殊处理：日期范围或多输入字段（如“发表日期”有两个框，中间可能是“至”或“或”）
            // 启发式规则：如果一行有2个输入框，且标签包含“日期”、“时间”、“年份”，则极可能是起始/结束或互斥关系
            // 用户要求：不要合并成 date_range，而是保留为两个独立字段
            const isDateRange = false; // inputs.length === 2 && (groupLabel.includes('日期') || groupLabel.includes('时间') || groupLabel.includes('年份') || groupLabel.includes('Date') || groupLabel.includes('Time'));
            
            if (isChoiceGroup) {
                // 将整行视为一个字段
                const fieldInfo = {
                    name: groupLabel || inputs[0].name || this._generateFieldName(inputs[0]),
                    type: firstType,
                    category: 'multiple_choice', // 分组字段默认为选择题
                    label: groupLabel, // 强制使用行标签作为字段标签
                    required: inputs.some(i => i.hasAttribute('required')),
                    options: inputs.map(input => {
                        // 获取每个选项的标签文本
                        let optLabel = '';
                        if (input.parentElement.tagName.toLowerCase() === 'label') {
                            optLabel = input.parentElement.textContent.trim();
                        } else {
                            const id = input.id;
                            if (id) {
                                const l = row.querySelector(`label[for="${id}"]`);
                                if (l) optLabel = l.textContent.trim();
                            }
                        }
                        // 如果还没找到，尝试取后继文本节点
                        if (!optLabel && input.nextSibling && input.nextSibling.nodeType === Node.TEXT_NODE) {
                            optLabel = input.nextSibling.textContent.trim();
                        }
                        return {
                            value: input.value,
                            text: optLabel || input.value
                        };
                    }),
                    description: this._getFieldDescription(inputs[0]),
                    isGroup: true
                };
                fields.push(fieldInfo);
                inputs.forEach(i => processedElements.add(i));
            } else if (isDateRange) {
                // 将日期范围合并为一个复合字段
                // 检查中间的连接词
                let connector = '至';
                const firstInput = inputs[0];
                let nextNode = firstInput.nextSibling;
                while (nextNode && nextNode !== inputs[1]) {
                    if (nextNode.nodeType === Node.TEXT_NODE || nextNode.tagName === 'SPAN') {
                        const text = nextNode.textContent.trim();
                        if (text) {
                            connector = text;
                            break;
                        }
                    }
                    nextNode = nextNode.nextSibling;
                }
                
                const isOrRelation = connector.includes('或') || connector.includes('or');
                const fieldName = groupLabel;
                
                const fieldInfo = {
                    name: fieldName,
                    type: 'date_range', // 自定义类型
                    category: 'fill_in_the_blank',
                    label: groupLabel,
                    required: inputs.some(i => i.hasAttribute('required')),
                    description: isOrRelation ? '只需填写其中一个日期' : '起始日期 至 结束日期',
                    isComposite: true, // 标记为复合字段
                    inputs: inputs.map((input, idx) => ({
                        name: input.name || input.id || `${fieldName}_${idx}`,
                        placeholder: input.placeholder || (idx === 0 ? '起始/选项1' : '结束/选项2')
                    })),
                    connector: connector
                };
                fields.push(fieldInfo);
                inputs.forEach(i => processedElements.add(i));
            } else {
                // 普通输入框或混合输入框
                inputs.forEach((input, index) => {
                    if (processedElements.has(input)) return;

                    // 生成带序号的标签（如果是多控件行）
                    let fieldLabel = groupLabel;
                    let fieldName = groupLabel; // 优先用中文名作为name以便匹配
                    
                    if (inputs.length > 1) {
                        // 尝试寻找每个控件特定的标签（如 "起始页", "终止页" placeholder）
                        const subLabel = input.getAttribute('placeholder') || input.getAttribute('aria-label');
                        if (subLabel && subLabel !== '请输入' && !subLabel.includes('例如')) {
                            fieldLabel = `${groupLabel} (${subLabel})`;
                            fieldName = `${groupLabel} - ${subLabel}`;
                        } else {
                            fieldLabel = `${groupLabel} [${index + 1}]`;
                            fieldName = `${groupLabel}[${index + 1}]`;
                        }
                    }

                    const fieldInfo = {
                        name: fieldName,
                        type: this._getFieldType(input),
                        category: (this._getFieldType(input) === 'select') ? 'multiple_choice' : 'fill_in_the_blank',
                        label: fieldLabel,
                        placeholder: input.getAttribute('placeholder') || '',
                        required: input.hasAttribute('required'),
                        options: this._getFieldOptions(input), // 仅针对 select 有效
                        validation: this._getValidationRules(input),
                        description: this._getFieldDescription(input),
                        xpath: this._getElementXPath(input)
                    };
                    fields.push(fieldInfo);
                    processedElements.add(input);
                });
            }
        }

        // 3. 处理表格内的字段（作者信息表）
        // 查找 .form-container 下的 table
        const tables = Array.from(rootElement.querySelectorAll('table'));
        for (const table of tables) {
            const headers = Array.from(table.querySelectorAll('th')).map(th => th.textContent.trim().replace(/\*/g, ''));
            const rows = Array.from(table.querySelectorAll('tbody tr'));
            
            rows.forEach((tr, rowIndex) => {
                const rowInputs = Array.from(tr.querySelectorAll('input, select, textarea'));
                rowInputs.forEach(input => {
                    if (processedElements.has(input)) return;
                    if (input.type === 'hidden' || input.type === 'button') return;

                    // 找到对应的列索引
                    const td = input.closest('td');
                    if (!td) return;
                    const colIndex = Array.from(tr.children).indexOf(td);
                    const colName = headers[colIndex] || `列${colIndex + 1}`;
                    
                    const fieldInfo = {
                        name: `作者列表[${rowIndex + 1}] - ${colName}`,
                        type: this._getFieldType(input),
                        category: (this._getFieldType(input) === 'select') ? 'multiple_choice' : 'fill_in_the_blank',
                        label: `作者 ${rowIndex + 1}: ${colName}`,
                        placeholder: input.getAttribute('placeholder') || '',
                        required: false,
                        options: [],
                        description: '表格行数据',
                        xpath: this._getElementXPath(input),
                        isTableField: true // 标记为表格字段
                    };
                    fields.push(fieldInfo);
                    processedElements.add(input);
                });
            });
        }

        return fields;
    }

    _parseFormField(tag) {
        /**
         * 解析单个表单字段
         */
        const groupLabel = this._getGroupLabel(tag);
        const generatedName = this._generateFieldName(tag, groupLabel);
        const fieldType = this._getFieldType(tag);
        
        // 初步推断字段大类（选择题/填空题）
        // 这是一个启发式判断，后续可以结合 LLM 进一步修正
        let category = 'fill_in_the_blank'; // 默认为填空题
        if (fieldType === 'select' || fieldType === 'radio' || fieldType === 'checkbox') {
            category = 'multiple_choice';
        }

        const fieldInfo = {
            name: tag.getAttribute('name') || tag.getAttribute('id') || generatedName,
            type: fieldType,
            category: category,
            label: this._getFieldLabel(tag) || groupLabel,
            placeholder: tag.getAttribute('placeholder') || '',
            required: tag.hasAttribute('required') || tag.hasAttribute('aria-required'),
            options: this._getFieldOptions(tag),
            validation: this._getValidationRules(tag),
            description: this._getFieldDescription(tag),
            xpath: this._getElementXPath(tag)
        };

        return fieldInfo;
    }

    _parseGroupField(inputs, type) {
        // 辅助方法：解析传统的同名 Radio/Checkbox 组（非 field-row 结构）
        if (!inputs || inputs.length === 0) return null;
        const first = inputs[0];
        // 尝试寻找公共标签
        let groupLabel = '';
        const container = first.closest('.form-group, .field-row, div');
        if (container) {
            const label = container.querySelector('label, .field-label');
            if (label && !inputs.some(i => label.contains(i))) {
                groupLabel = label.textContent.trim();
            }
        }
        
        return {
            name: first.name,
            type: type,
            category: 'multiple_choice', // 分组字段默认为选择题
            label: groupLabel || first.name,
            options: inputs.map(i => ({
                value: i.value,
                text: this._getFieldLabel(i)
            })),
            isGroup: true
        };
    }

    _generateFieldName(tag, groupLabel = '') {
        /**
         * 生成字段名称
         */
        if (tag.id) {
            return tag.id;
        }
        if (tag.name) {
            return tag.name;
        }
        // 优先使用分组标题作为字段名（便于人类理解和后续按组填写）
        const clean = (s) => (s || '').replace(/\*/g, '').trim();
        if (groupLabel) {
            const row = tag.closest('.field-row');
            if (row) {
                const controls = Array.from(row.querySelectorAll('input, select, textarea'));
                const index = controls.indexOf(tag);
                // 对多控件的行加上序号后缀，例如：发表日期[1]、发表日期[2]
                const suffixNeeded = controls.filter(el => el.tagName.toLowerCase() !== 'button').length > 1;
                if (suffixNeeded && index >= 0) {
                    return `${clean(groupLabel)}[${index + 1}]`;
                }
            }
            return clean(groupLabel);
        }
        // 如果都没有，生成一个唯一的名称
        return `field_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    _getFieldType(tag) {
        /**
         * 获取字段类型
         */
        if (tag.tagName.toLowerCase() === 'select') {
            return 'select';
        } else if (tag.tagName.toLowerCase() === 'textarea') {
            return 'textarea';
        } else if (tag.tagName.toLowerCase() === 'input') {
            const inputType = tag.getAttribute('type') || 'text';
            return inputType.toLowerCase();
        }
        return 'unknown';
    }

    _getFieldLabel(tag) {
        /**
         * 获取字段标签文本
         */
        // 方法1: 通过for属性查找label
        const fieldId = tag.getAttribute('id');
        if (fieldId) {
            const label = this.document.querySelector(`label[for="${fieldId}"]`);
            if (label) {
                return label.textContent.trim();
            }
        }

        // 方法2: 查找相邻的label
        let parent = tag.parentElement;
        while (parent && parent.tagName.toLowerCase() !== 'form') {
            const label = parent.querySelector('label');
            if (label && label.contains(tag)) {
                return label.textContent.trim();
            }
            parent = parent.parentElement;
        }

        // 方法3: 查找前一个兄弟元素中的label
        let prevSibling = tag.previousElementSibling;
        while (prevSibling) {
            if (prevSibling.tagName.toLowerCase() === 'label') {
                return prevSibling.textContent.trim();
            }
            prevSibling = prevSibling.previousElementSibling;
        }

        // 方法4: 查找aria-label
        const ariaLabel = tag.getAttribute('aria-label');
        if (ariaLabel) {
            return ariaLabel;
        }

        // 方法5: 查找title属性
        const title = tag.getAttribute('title');
        if (title) {
            return title;
        }

        // 方法6: 回退到组标题
        const group = this._getGroupLabel(tag);
        if (group) {
            return group;
        }

        return '';
    }

    _getFieldOptions(tag) {
        /**
         * 获取选择框的选项
         */
        const options = [];

        if (tag.tagName.toLowerCase() === 'select') {
            const optionTags = tag.querySelectorAll('option');
            for (const option of optionTags) {
                options.push({
                    value: option.getAttribute('value') || '',
                    text: option.textContent.trim()
                });
            }
        } else if (tag.type === 'radio' || tag.type === 'checkbox') {
            // 查找同组的所有radio/checkbox
            const fieldName = tag.name;
            if (fieldName) {
                const allRadios = this.document.querySelectorAll(`input[type="${tag.type}"][name="${fieldName}"]`);
                for (const radio of allRadios) {
                    // 查找关联的label
                    const radioId = radio.getAttribute('id');
                    let labelText = '';
                    
                    if (radioId) {
                        const label = this.document.querySelector(`label[for="${radioId}"]`);
                        labelText = label ? label.textContent.trim() : '';
                    } else {
                        // 查找紧邻的label元素
                        let sibling = radio.nextElementSibling;
                        while (sibling && sibling.tagName.toLowerCase() === 'label') {
                            labelText = sibling.textContent.trim();
                            break;
                        }
                    }
                    
                    options.push({
                        value: radio.getAttribute('value') || '',
                        text: labelText
                    });
                }
            }
        }

        return options;
    }

    _getValidationRules(tag) {
        /**
         * 获取验证规则
         */
        const rules = {};

        // 必填验证
        if (tag.hasAttribute('required')) {
            rules.required = true;
        }

        // 模式验证
        const pattern = tag.getAttribute('pattern');
        if (pattern) {
            rules.pattern = pattern;
        }

        // 最小/最大值
        const minVal = tag.getAttribute('min');
        const maxVal = tag.getAttribute('max');
        if (minVal) {
            rules.min = minVal;
        }
        if (maxVal) {
            rules.max = maxVal;
        }

        // 长度限制
        const minLength = tag.getAttribute('minlength');
        const maxLength = tag.getAttribute('maxlength');
        if (minLength) {
            rules.minLength = minLength;
        }
        if (maxLength) {
            rules.maxLength = maxLength;
        }

        // 输入类型
        const inputType = tag.getAttribute('type');
        if (['email', 'url', 'tel', 'number'].includes(inputType)) {
            rules.type = inputType;
        }

        return rules;
    }

    _getFieldDescription(tag) {
        /**
         * 获取字段描述（帮助文本）
         */
        // 查找帮助文本元素
        let nextSibling = tag.nextElementSibling;
        while (nextSibling && nextSibling.tagName.toLowerCase() !== 'form') {
            if (nextSibling.tagName.toLowerCase() === 'small' || 
                nextSibling.classList.contains('help-text') ||
                nextSibling.classList.contains('description')) {
                return nextSibling.textContent.trim();
            }
            nextSibling = nextSibling.nextElementSibling;
        }

        // 查找父元素中的帮助文本
        let parent = tag.parentElement;
        while (parent && parent.tagName.toLowerCase() !== 'form') {
            const helpDiv = parent.querySelector('.help-text, .description, .form-help');
            if (helpDiv) {
                return helpDiv.textContent.trim();
            }
            parent = parent.parentElement;
        }

        return '';
    }

    _getGroupLabel(tag) {
        /**
         * 获取字段所在行的组标签（如 .field-row > .field-label）
         */
        const row = tag.closest('.field-row');
        if (!row) return '';
        const labelDiv = row.querySelector('.field-label');
        if (!labelDiv) return '';
        return (labelDiv.textContent || '').replace(/\*/g, '').trim();
    }

    _getElementXPath(element) {
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

    getFormStructure() {
        /**
         * 获取整个表单结构
         */
        if (!this.document) {
            return {};
        }

        const form = this.document.querySelector('form');
        const container = this.document.querySelector('.form-container');
        const titleSource = form || container || this.document;
        return {
            title: this._getFormTitle(titleSource),
            description: form ? this._getFormDescription(form) : '',
            action: form ? (form.getAttribute('action') || '') : '',
            method: form ? (form.getAttribute('method') || 'get') : 'get',
            fields: this.extractFormFields()
        };
    }

    _getFormTitle(form) {
        /**
         * 获取表单标题
         */
        // 查找form之前的h1-h3
        if (form && form.previousElementSibling) {
            const prevHeading = this._findPreviousSibling(form, ['h1', 'h2', 'h3']);
            if (prevHeading) {
                return prevHeading.textContent.trim();
            }
        }

        // 查找form内的legend
        if (form && form.querySelector) {
            const legend = form.querySelector('legend');
            if (legend) {
                return legend.textContent.trim();
            }
            // 回退：在容器内查找标题
            const innerHeading = form.querySelector && form.querySelector('h1, h2, h3');
            if (innerHeading) {
                return innerHeading.textContent.trim();
            }
        }

        return '未命名表单';
    }

    _getFormDescription(form) {
        /**
         * 获取表单描述
         */
        // 查找form之前的段落
        const prevP = this._findPreviousSibling(form, ['p']);
        if (prevP) {
            return prevP.textContent.trim();
        }

        // 查找包含描述的div
        const descDiv = form.querySelector('.description, .form-description');
        if (descDiv) {
            return descDiv.textContent.trim();
        }

        return '';
    }

    _findPreviousSibling(element, tagNames) {
        /**
         * 查找前面的兄弟元素
         */
        let prevElement = element.previousElementSibling;
        while (prevElement) {
            if (tagNames.includes(prevElement.tagName.toLowerCase())) {
                return prevElement;
            }
            prevElement = prevElement.previousElementSibling;
        }
        return null;
    }
}

export { FormParser };
