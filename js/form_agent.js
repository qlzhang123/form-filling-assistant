/**
 * JavaScript表单填写智能体
 */

import { ReActAgent } from './react_agent.js';
import { FormParser } from './form_parser.js';

class FormFillingAgent {
    /**
     * 交互式网页表单填表智能体 - JavaScript版本
     */
    constructor(llmClient, toolExecutor, onStep = null) {
        this.llmClient = llmClient;
        this.toolExecutor = toolExecutor;
        this.onStep = onStep;
        this.agent = new ReActAgent(llmClient, toolExecutor, 20, onStep);
        
        // 添加上下文记忆
        this.filledContext = {}; // 存储已填写的字段信息
        this.discoveryCache = {}; // 存储在搜索过程中发现的额外信息（如论文的元数据）
        
        // 专用的表单填写提示词模板
        this.FORM_PROMPT_TEMPLATE = `你是一个专业的表单填写助手，专门帮助填写网页表单。

        表单信息：
        表单标题：{form_title}
        表单描述：{form_description}

        当前字段群组信息：
        群组名称：{group_name}
        同组其他字段：{group_fields}

        当前字段信息：
        字段名称：{field_label}
        字段类型：{field_type}
        是否必填：{required}
        提示文本：{placeholder}
        字段描述：{field_desc}
        验证规则：{validation_rules}

        已填写字段（上下文）：
        {filled_context}

        发现缓存（在之前的搜索中偶然发现的相关信息）：
        {discovery_cache}

        可用工具：
        {tools}
            
        **重要指导**：
        1. **按需调用API**：只获取解决当前字段所需的信息。在调用工具时，务必通过参数（如 select、fields）指定你需要的字段，避免请求全部数据。
        - 示例：GetWorkOpenAlex[{"doi": "10.xxx", "select": ["title", "authors", "publication_year"]}]
        - 示例：GetPaperDetailsSemanticScholar[{"doi": "10.xxx", "fields": ["citationCount", "abstract"]}]
        - 基础字段通常包括：title, authors, year, venue, doi, url。如果只需要这些，可以不指定 select/fields 或使用默认值。
        2. **缓存优先**：如果“发现缓存”中已有答案或完整元数据，直接 Finish，不要重复调用工具。
        3. **选项优先**：若存在多个高质量候选答案，使用 Options[选项1 | 选项2 | ...]，最多 10 项。
        4. **信息整合**：对具体事实类字段需给出确定值；对叙述类字段基于已知信息生成1-3句完整句子。
        5. **批量提取**：如果同组有其他字段，且可以通过一次API调用获取，请在 Finish 的 JSON 中一并返回。
        6. **输出格式**：
        - 最终答案使用 Finish[答案文本]
        - 如果还附带其他字段的发现数据，用 JSON 代码块包裹：
            \`\`\`json
            {
            "字段名1": "值1",
            "字段名2": "值2",
            "source": "API名称"
            }
            \`\`\`
        - 多选项使用 Options[选项1 | 选项2]，JSON 同理。
        7. **处理选择类字段**：对于 select、radio、checkbox 类型字段，你必须先使用 GetPageElements 工具获取该字段的可用选项列表。调用时可以使用字段名、标签文本或 CSS 选择器。例如：
        - 如果知道字段名：GetPageElements["select[name='成果类型']"]
        - 如果知道标签文本：GetPageElements["成果类型"]  （工具会自动查找标签文本）
        - 也可以使用 CSS 选择器：GetPageElements[".field-row .field-label:contains('成果类型') + select"]
        8. **解析 GetPageElements 结果**：当你调用 GetPageElements 获取某个字段的可选项时，返回的结构如下：
        {
            "success": true,
            "elements": [
            {
                "tagName": "select",
                "name": "field_name",
                "options": [ { "value": "opt1", "text": "选项1" }, ... ]
            }
            ]
        }
        对于 select 字段，你应从 elements[0].options 中提取所有选项。然后，根据论文信息（如标题、会议、年份）判断哪个选项最匹配，输出 Finish[选项的 text 或 value]。如果匹配结果不唯一，可以使用 Options[选项1 | 选项2] 提供候选项。
        对于 radio/checkbox 字段，elements 中可能包含多个元素，每个元素有自己的 value 和 label，你也需要从中选择匹配项。
        9. **处理工具返回空结果**：如果 GetPageElements 返回的 elements 为空（即找不到该字段），请按以下步骤降级：
        - 第一步：尝试使用更通用的选择器，如 GetPageElements["select"] 获取页面上所有下拉框。返回的每个元素都有 options 属性。
        - 第二步：遍历这些下拉框的 options，根据上下文（如论文类型、会议信息）选择最匹配的选项。如果多个下拉框都有相关选项，可以使用 Options 提供候选项。
        - 第三步：如果还是无法获取，再基于上下文直接推断最可能的选项，并用 Finish[答案] 输出。
        - 示例：对于“成果类型”字段，如果找不到特定元素，可以调用 GetPageElements["select"]，然后从所有下拉框的选项中寻找“会议论文”、“期刊论文”等，选择匹配的选项。
        请严格按照以下格式思考，不要添加任何多余的 Markdown 标记：
        Thought: 思考过程（必须包含你对任务类型的判断。**如果是综合叙述型且已到第 8 步，必须在 Thought 中写明“已达步数上限，开始总结”**）
        Action: ToolName[Input]
            
        现在开始：
        `;
    }

    

    

    async _groupFields(fields, formStructure) {
        /**
         * 对表单字段进行逻辑分组（基于 LLM 结构树）
         */
        try {
            // 1. 如果有 LLM 分析出的树状结构，则基于此结构构建执行树
            if (formStructure.llmTree && Array.isArray(formStructure.llmTree) && formStructure.llmTree.length > 0) {
                console.log("🧩 基于 LLM 分析的结构树进行分组...");
                
                const usedFields = new Set();
                
                // 递归构建执行树
                const buildTree = (node) => {
                    if (node.type === 'group') {
                        const children = (node.children || []).map(buildTree).filter(Boolean);
                        if (children.length > 0) {
                            return {
                                ...node,
                                isGroup: true,
                                children: children
                            };
                        }
                        return null;
                    } else if (node.type === 'table') {
                        // 表格特殊处理：找到所有属于该表格的字段
                        const tableLabel = (node.label || node.name || '').toLowerCase();
                        const tableFields = fields.filter(f => {
                            if (usedFields.has(f.name)) return false;
                            const fLabel = (f.label || f.name || '').toLowerCase();
                            const fName = (f.name || '').toLowerCase();
                            return fLabel.includes(tableLabel) || fName.includes(tableLabel) || f.isTableField;
                        });
                        
                        if (tableFields.length > 0) {
                            tableFields.forEach(f => usedFields.add(f.name));
                            return {
                                ...node,
                                isTable: true,
                                children: tableFields.map(f => ({ ...f, isField: true })) // 表格字段作为子节点
                            };
                        }
                        return null;
                    } else {
                        // 查找匹配的 DOM 字段
                        const match = fields.find(f => {
                            if (usedFields.has(f.name)) return false;
                            
                            // 精确匹配 name
                            if (f.name === node.name) return true;
                            
                            // 模糊匹配 label
                            const fLabel = (f.label || '').toLowerCase();
                            const nLabel = (node.label || '').toLowerCase();
                            if (fLabel && nLabel && (fLabel === nLabel || fLabel.includes(nLabel) || nLabel.includes(fLabel))) return true;
                            
                            return false;
                        });
                        
                        if (match) {
                            usedFields.add(match.name);
                            return {
                                ...match, // 保留 DOM 字段的所有属性
                                ...node,  // 覆盖 LLM 的属性
                                isField: true,
                                format_hint: node.format_hint || match.format_hint
                            };
                        }
                        return null;
                    }
                };
                
                const executionTree = formStructure.llmTree.map(buildTree).filter(Boolean);
                
                // 3. 展平树状结构为 sidebar.js 可用的 Group 列表
                // sidebar.js 仅支持两层结构：Group List -> Field List
                const flatGroups = [];
                
                const flatten = (nodes, parentLabel = '') => {
                    let currentGroup = {
                        name: parentLabel || '默认分组',
                        label: parentLabel || '默认分组',
                        fields: [],
                        isGroup: true,
                        relationship: 'and' // 默认为 and
                    };
                    
                    // 如果当前节点本身就是一个组（且有关系定义），我们保留它的元数据
                    // 但我们需要把它的子字段收集起来
                    
                    for (const node of nodes) {
                        if (node.isGroup || node.isTable) {
                            // 如果遇到嵌套组，递归处理
                            // 策略：如果该组包含字段，将其作为一个新的 Group 添加到 flatGroups
                            // 如果该组包含子组，继续递归
                            
                            // 先收集该组下的直接字段
                            const directFields = (node.children || []).filter(c => c.isField);
                            if (directFields.length > 0) {
                                flatGroups.push({
                                    name: node.label || node.name,
                                    label: node.label || node.name,
                                    relationship: node.relationship || (node.isTable ? 'table' : 'and'),
                                    fields: directFields,
                                    isGroup: true,
                                    isTable: node.isTable
                                });
                            }
                            
                            // 递归处理子组
                            const subGroups = (node.children || []).filter(c => c.isGroup || c.isTable);
                            if (subGroups.length > 0) {
                                flatten(subGroups, node.label);
                            }
                        } else if (node.isField) {
                            // 顶层字段，归入一个通用组，或者添加到上一个组？
                            // 这里我们暂时收集到一个临时组，最后如果非空则添加
                            currentGroup.fields.push(node);
                        }
                    }
                    
                    if (currentGroup.fields.length > 0) {
                        // 只有当这些字段不属于已经添加的 directFields 时才添加
                        // 由于上面的逻辑已经处理了 directFields，这里的 currentGroup.fields 主要是顶层游离字段
                        // 检查是否已经存在同名组
                        const existing = flatGroups.find(g => g.name === currentGroup.name);
                        if (existing) {
                            existing.fields.push(...currentGroup.fields);
                        } else {
                            flatGroups.push(currentGroup);
                        }
                    }
                };
                
                flatten(executionTree);
                
                // 找出未被分配的字段
                const remainingFields = fields.filter(f => !usedFields.has(f.name));
                if (remainingFields.length > 0) {
                    console.log(`⚠️  发现 ${remainingFields.length} 个未分配字段，归入“其他”组`);
                    flatGroups.push({
                        name: '其他信息',
                        label: '其他信息',
                        fields: remainingFields.map(f => ({ ...f, isField: true })),
                        isGroup: true,
                        relationship: 'and'
                    });
                }
                
                return flatGroups;
            }

            // 2. 回退逻辑：使用扁平化的 AI 分组
            console.log("⚠️ 无 LLM 结构树，回退到扁平分组...");
            const groups = await this._aiGroupFields(fields, formStructure);
            
            // 转换为 sidebar.js 兼容格式
            return groups.map(g => ({
                name: g.name,
                label: g.name,
                fields: g.fields.map(f => ({ ...f, isField: true })),
                isGroup: true,
                relationship: 'and'
            }));
            
        } catch (error) {
            console.error("字段分组失败，退回到线性顺序:", error);
            // 最后的兜底：线性列表
            return [{
                name: "表单字段",
                label: "表单字段",
                fields: fields.map(f => ({ ...f, isField: true })),
                isGroup: true,
                relationship: 'and'
            }];
        }
    }

    async _aiGroupFields(fields, formStructure) {
        /**
         * 调用 AI 对字段进行语义分组
         */
        const fieldInfo = fields.map(f => ({
            name: f.name,
            label: f.label,
            type: f.type,
            required: f.required
        }));

        const prompt = `你是一个表单分析专家。请对以下表单字段进行逻辑分组。
表单标题：${formStructure.title}
表单描述：${formStructure.description}

待分组字段：
${JSON.stringify(fieldInfo, null, 2)}

分组规则：
1. 将语义高度关联的字段放在一组（如：论文标题、年份、DOI 应该在一组；姓名、邮箱、单位应该在一组）。
2. 每组应有一个清晰的名称。
3. 必须包含所有字段，不得遗漏。
4. 请以 JSON 数组格式返回，格式如下：
[
  { "name": "组名", "fields": ["字段名1", "字段名2"] },
  ...
]
只返回 JSON 数组，不要任何其他文字。`;

        const response = await this.llmClient.think([{"role": "user", "content": prompt}]);
        try {
            const groupDefinitions = JSON.parse(response.trim().replace(/```json\n?|```/g, ''));
            
            // 将字段名映射回完整的字段对象
            return groupDefinitions.map(def => ({
                name: def.name,
                fields: def.fields.map(fieldName => fields.find(f => f.name === fieldName)).filter(Boolean)
            }));
        } catch (e) {
            console.error("解析分组 JSON 失败:", e, response);
            throw new Error("无法解析分组结果");
        }
    }

    async getAllTableInputs() {
        // 首选：针对您的test1.html表格结构
        const primarySelectors = [
            '#author-table tbody input',          // 精准命中作者表格内的所有输入框
            '#author-table input',                 // 更宽松
            '.author-table tbody input',            // 可能类名
            'table tbody input'                      // 通用
        ];

        for (const selector of primarySelectors) {
            const result = await this.toolExecutor.execute(
                'GetPageElements',
                { selector, tabId: this.formTabId },
                { tabId: this.formTabId }
            );
            if (result.success && result.elements && result.elements.length > 0) {
                console.log(`getAllTableInputs 使用选择器 "${selector}" 获取到 ${result.elements.length} 个输入框`);
                return result.elements.map(el => ({
                    field: { name: el.name || el.id, type: el.type, xpath: el.xpath },
                    label: el.label || ''
                }));
            }
        }

        // 备选：如果上述都失败，则回退到之前的多选择器组合
        const fallbackSelectors = [
            'table input, table select, table textarea',
            'input:not([type="hidden"]), select, textarea'
        ];
        for (const selector of fallbackSelectors) {
            const result = await this.toolExecutor.execute(
                'GetPageElements',
                { selector, tabId: this.formTabId },
                { tabId: this.formTabId }
            );
            if (result.success && result.elements && result.elements.length > 0) {
                console.log(`getAllTableInputs 使用回退选择器 "${selector}" 获取到 ${result.elements.length} 个输入框`);
                return result.elements.map(el => ({
                    field: { name: el.name || el.id, type: el.type, xpath: el.xpath },
                    label: el.label || ''
                }));
            }
        }

        console.warn('所有选择器均未找到输入框');
        return [];
    }

    /**
     * 获取表格第一行的输入框（用于推断每行列数）
     */
    async getFirstRowInputs() {
        const selectors = [
            '#author-table tbody tr:first-child input',
            '#author-table tbody tr:first-child select',
            '#author-table tbody tr:first-child textarea',
            'table tbody tr:first-child input'
        ];
        for (const selector of selectors) {
            const result = await this.toolExecutor.execute(
                'GetPageElements',
                { selector, tabId: this.formTabId },
                { tabId: this.formTabId }
            );
            if (result.success && result.elements) {
                return result.elements.map(el => ({
                    field: { name: el.name || el.id, type: el.type, xpath: el.xpath },
                    label: el.label || ''
                }));
            }
        }
        return [];
    }
    

    async processTable(node, depth, siblings) {
        const indent = '  '.repeat(depth);
        console.log(`\n${indent}📊 开始批量处理表格: ${node.label}`);

        // 获取作者列表
        let authors = this.discoveryCache._current_paper_authors || [];
        if ((!authors || authors.length === 0) && typeof window !== 'undefined' && window.__tempAuthors) {
            console.log(`${indent}从 window.__tempAuthors 恢复作者信息`);
            authors = window.__tempAuthors;
            this.discoveryCache._current_paper_authors = authors;
        }

        if (!authors || authors.length === 0) {
            console.log(`${indent}⚠️ 未找到作者信息，跳过表格`);
            return;
        }
        console.log(`${indent}📋 需要填写 ${authors.length} 位作者:`, authors.map(a => a.name).join(', '));

        const NAME_PREFIX = 'author_name_';
        const AFF_PREFIX = 'author_affiliation_';

        // 逐行处理，动态添加行直到填写成功
        for (let i = 1; i <= authors.length; i++) {
            const author = authors[i-1];
            const nameFieldName = `${NAME_PREFIX}${i}`;
            const affFieldName = `${AFF_PREFIX}${i}`;

            // 填写姓名（如果失败则添加行重试）
            let nameFilled = false;
            let nameAttempts = 0;
            const MAX_ATTEMPTS = 20;

            while (!nameFilled && nameAttempts < MAX_ATTEMPTS) {
                console.log(`${indent}尝试填写作者 ${i} 姓名: ${author.name}`);
                const nameResult = await this.fillFieldValue({ name: nameFieldName }, author.name);
                if (nameResult && nameResult.success) {
                    nameFilled = true;
                    console.log(`${indent}作者 ${i} 姓名填写成功`);
                } else {
                    console.log(`${indent}作者 ${i} 姓名填写失败，尝试添加行...`);
                    const added = await this.clickAddButton();
                    if (!added) {
                        console.log(`${indent}无法点击添加按钮，停止`);
                        return;
                    }
                    await this.delay(500); // 等待 DOM 更新
                    nameAttempts++;
                }
            }

            if (!nameFilled) {
                console.log(`${indent}无法填写作者 ${i} 姓名，停止`);
                return;
            }

            // 获取单位
            let affiliation = author.affiliation || '';
            if (!affiliation && author.name) {
                try {
                    const res = await this.toolExecutor.execute(
                        'GetAuthorDetailsSemanticScholar',
                        author.name,
                        { discoveryCache: this.discoveryCache, tabId: this.formTabId }
                    );
                    if (res.success && res.data && res.data.affiliations) {
                        affiliation = Array.isArray(res.data.affiliations)
                            ? res.data.affiliations.join('; ')
                            : res.data.affiliations;
                    }
                } catch (e) {
                    console.warn(`获取作者 ${author.name} 单位失败`, e);
                }
            }

            // 填写单位（如果存在且失败则添加行重试）
            if (affiliation) {
                let affFilled = false;
                let affAttempts = 0;
                while (!affFilled && affAttempts < MAX_ATTEMPTS) {
                    const affResult = await this.fillFieldValue({ name: affFieldName }, affiliation);
                    if (affResult && affResult.success) {
                        affFilled = true;
                        console.log(`${indent}作者 ${i} 单位填写成功`);
                    } else {
                        console.log(`${indent}作者 ${i} 单位填写失败，尝试添加行...`);
                        const added = await this.clickAddButton();
                        if (!added) {
                            console.log(`${indent}无法点击添加按钮，停止`);
                            return;
                        }
                        await this.delay(500);
                        affAttempts++;
                    }
                }
                if (!affFilled) {
                    console.log(`${indent}无法填写作者 ${i} 单位，停止`);
                    return;
                }
            } else {
                console.log(`${indent}作者 ${i} 无单位信息，跳过`);
            }
        }

        console.log(`${indent}表格处理完成`);
    }
    /**
     * 检查指定字段名的输入框是否存在
     */
    async checkFieldExists(fieldName) {
        const result = await this.toolExecutor.execute(
            'GetPageElements',
            { selector: `[name="${fieldName}"]`, tabId: this.formTabId },
            { tabId: this.formTabId }
        );
        return result.success && result.elements && result.elements.length > 0;
    }

    async clickAddButton() {
        const addButtonSelectors = [
            '.action-btn',
            'button[onclick*="addRow"]',
            '#add-author-btn',
            'button:contains("添加作者")',  // 注意 :contains 不是标准 CSS，需确保 GetPageElements 能处理
            'button[title*="add"]',
            'button[aria-label*="add"]'
        ];
        for (const sel of addButtonSelectors) {
            try {
                const result = await this.toolExecutor.execute(
                    'ClickElement',
                    { selector: sel, tabId: this.formTabId },
                    { tabId: this.formTabId }
                );
                if (result.success) {
                    console.log(`点击添加按钮成功: ${sel}`);
                    return true;
                }
            } catch (e) {
                console.warn(`尝试点击 ${sel} 失败:`, e);
            }
            await this.delay(300);
        }
        return false;
    }       

    // 获取表头文本数组
    async getTableHeaders() {
        let headers = [];
        // 方案1：标准 thead 中的 th
        const result1 = await this.toolExecutor.execute(
            'GetPageElements',
            { selector: 'table thead th', tabId: this.formTabId },
            { tabId: this.formTabId }
        );
        if (result1.success && result1.elements && result1.elements.length > 0) {
            headers = result1.elements.map(el => el.textContent || '').filter(Boolean);
        }

        // 如果没找到，尝试获取表格第一行中的所有 td
        if (headers.length === 0) {
            const result2 = await this.toolExecutor.execute(
                'GetPageElements',
                { selector: 'table tbody tr:first-child td', tabId: this.formTabId },
                { tabId: this.formTabId }
            );
            if (result2.success && result2.elements && result2.elements.length > 0) {
                headers = result2.elements.map(el => el.textContent || '').filter(Boolean);
            }
        }

        // 如果还是没找到，尝试获取第一行输入框的数量，并生成默认列名
        if (headers.length === 0) {
            const firstRowInputs = await this.toolExecutor.execute(
                'GetPageElements',
                { selector: 'table tbody tr:first-child input, table tbody tr:first-child select, table tbody tr:first-child textarea', tabId: this.formTabId },
                { tabId: this.formTabId }
            );
            if (firstRowInputs.success && firstRowInputs.elements) {
                const colCount = firstRowInputs.elements.length;
                headers = Array.from({ length: colCount }, (_, i) => `列 ${i+1}`);
            }
        }

        return headers;
    }

    // 调整表格行数（添加或删除）
    async adjustTableRows(count, action) {
        console.log(`adjustTableRows: action=${action}, count=${count}`);
        if (action === 'add') {
            const addButtonSelectors = [
                '.action-btn',
                'button[onclick*="addRow"]',
                'button:contains("添加作者")',
                '#add-author-btn'
            ];
            let currentRows = await this.getTableRowCount();
            const targetRows = currentRows + count;
            let attempts = 0;
            console.log(`添加行: 当前行数=${currentRows}, 目标行数=${targetRows}`);
            while (currentRows < targetRows && attempts < 20) {
                let clicked = false;
                for (const sel of addButtonSelectors) {
                    try {
                        const result = await this.toolExecutor.execute(
                            'ClickElement',
                            { selector: sel, tabId: this.formTabId },
                            { tabId: this.formTabId }
                        );
                        if (result.success) {
                            clicked = true;
                            console.log(`点击添加按钮成功: ${sel}`);
                            break;
                        }
                    } catch (e) {}
                    await this.delay(300);
                }
                if (!clicked) {
                    console.log(`⚠️ 无法自动添加行，请手动添加`);
                    break;
                }
                await this.delay(500);
                const newRows = await this.getTableRowCount();
                console.log(`添加后新行数: ${newRows}`);
                if (newRows > currentRows) {
                    currentRows = newRows;
                    attempts = 0; // 成功增加，重置尝试次数
                } else {
                    attempts++;
                    console.log(`添加行未增加，尝试次数: ${attempts}`);
                    if (attempts >= 20) {
                        console.log(`⚠️ 添加行多次尝试无效，停止`);
                        break;
                    }
                }
            }
        } else if (action === 'remove') {
            let currentRows = await this.getTableRowCount();
            const targetRows = currentRows - count;
            console.log(`删除行: 当前行数=${currentRows}, 目标行数=${targetRows}`);
            while (currentRows > targetRows) {
                const deleteButtons = await this.getDeleteButtons();
                if (deleteButtons.length === 0) {
                    console.log(`未找到删除按钮`);
                    break;
                }
                const lastButton = deleteButtons[deleteButtons.length - 1];
                try {
                    await this.toolExecutor.execute(
                        'ClickElement',
                        { selector: lastButton.xpath, tabId: this.formTabId },
                        { tabId: this.formTabId }
                    );
                    console.log(`点击删除按钮`);
                    await this.delay(300);
                    const newRows = await this.getTableRowCount();
                    console.log(`删除后新行数: ${newRows}`);
                    if (newRows < currentRows) {
                        currentRows = newRows;
                    } else {
                        console.log(`删除行未减少，停止`);
                        break;
                    }
                } catch (e) {
                    console.log(`删除按钮点击失败: ${e.message}`);
                    break;
                }
            }
        }
    }

    // 获取所有删除按钮（返回包含 XPath 的数组）
    async getDeleteButtons() {
        const result = await this.toolExecutor.execute(
            'GetPageElements',
            { selector: 'table tbody tr button', tabId: this.formTabId },
            { tabId: this.formTabId }
        );
        const buttons = [];
        if (result.success && result.elements) {
            for (const el of result.elements) {
                if (el.textContent && el.textContent.includes('删除')) {
                    // 使用元素自带的 XPath（由 GetPageElements 返回）
                    if (el.xpath) {
                        buttons.push({ xpath: el.xpath, element: el });
                    }
                }
            }
        }
        return buttons;
    }


    async getTableRowCount() {
        try {
            // 扩展选择器列表，覆盖更多表格结构
            const selectors = [
                '#author-table tbody tr',        // 特定 ID 的表格体行
                'table tbody tr',                 // 标准表格体行
                'table tr',                        // 所有表格行（包括表头）
                '.author-table tbody tr',          // 类名表格
                '[role="table"] [role="row"]',     // ARIA 表格
                '.ant-table-row',                   // Ant Design 表格行
                '.el-table__row',                    // Element UI 表格行
                '.data-row',                          // 常见数据行类名
                'tr'                                   // 最后退回到所有 tr（但可能误抓，所以放最后）
            ];
            
            for (const sel of selectors) {
                const result = await this.toolExecutor.execute(
                    'GetPageElements',
                    { selector: sel, tabId: this.formTabId },
                    { tabId: this.formTabId }
                );
                if (result.success && result.elements && result.elements.length > 0) {
                    console.log(`getTableRowCount 使用选择器 "${sel}" 获取到 ${result.elements.length} 行`);
                    return result.elements.length;
                }
            }

            // 如果上述选择器都未找到行，尝试根据输入框数量估算行数（假设每行有固定数量的输入框，比如姓名+单位两个）
            const inputResult = await this.toolExecutor.execute(
                'GetPageElements',
                { selector: 'table input, table select, table textarea', tabId: this.formTabId },
                { tabId: this.formTabId }
            );
            if (inputResult.success && inputResult.elements && inputResult.elements.length > 0) {
                // 假设每行有两个输入框（姓名和单位），估算行数
                const estimatedRows = Math.ceil(inputResult.elements.length / 2);
                console.log(`根据输入框数量估算行数: ${estimatedRows}`);
                return estimatedRows;
            }
        } catch (e) {
            console.warn('获取表格行数失败', e);
        }
        return 0;
    }

    async fillFieldValue(field, value) {
        if (!field || !value) return { success: false, message: '参数无效' };
        try {
            const result = await this.toolExecutor.execute(
                'FillFormField',
                { fieldName: field.name, value, tabId: this.formTabId },
                { tabId: this.formTabId }
            );
            return result; // 假设 result 有 success 字段
        } catch (e) {
            console.warn(`填写字段 ${field.name} 失败`, e);
            return { success: false, message: e.message };
        }
    }


    /**
     * 获取表格中每一行的输入字段信息
     * 返回数组，每项是该行输入字段的数组（每个元素包含 field 对象和 label）
     */
    async getTableRows() {
        const rows = [];
        try {
            // 获取所有行
            const trs = await this.toolExecutor.execute(
                'GetPageElements',
                { selector: 'tbody tr', tabId: this.formTabId },
                { tabId: this.formTabId }
            );
            if (!trs.success || !trs.elements) return rows;

            for (let i = 0; i < trs.elements.length; i++) {
                // 获取该行内的输入框，使用 nth-child 选择器
                const selector = `tbody tr:nth-child(${i+1}) input, tbody tr:nth-child(${i+1}) select, tbody tr:nth-child(${i+1}) textarea`;
                const inputs = await this.toolExecutor.execute(
                    'GetPageElements',
                    { selector, tabId: this.formTabId },
                    { tabId: this.formTabId }
                );
                if (inputs.success && inputs.elements) {
                    const rowFields = inputs.elements.map(el => ({
                        field: { 
                            name: el.name || el.id,  // 优先使用 name，若空则用 id
                            type: el.type 
                        },
                        label: el.label || ''  // GetPageElements 返回的每个元素已包含 label 字段
                    }));
                    rows.push(rowFields);
                }
            }
        } catch (e) {
            console.error('获取表格行失败', e);
        }
        return rows;
    }

    /**
     * 简单的延迟函数
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    _displayFieldInfo(field) {
        /**
         * 显示字段信息和已填写的上下文
         */
        console.log(`字段名称: ${field.name || 'N/A'}`);
        console.log(`字段标签: ${field.label || 'N/A'}`);
        console.log(`字段类型: ${field.type || 'text'}`);
        console.log(`是否必填: ${field.required ? '✅ 是' : '❌ 否'}`);
        
        if (field.placeholder) {
            console.log(`提示文本: ${field.placeholder}`);
        }
        
        if (field.description) {
            console.log(`字段描述: ${field.description}`);
        }
        
        // 显示已填写的上下文（如果有）
        if (Object.keys(this.filledContext).length > 0) {
            console.log("\n📋 已填写的内容（供参考）：");
            for (const [fieldName, data] of Object.entries(this.filledContext)) {
                console.log(`  - ${data.label || fieldName}: ${data.answer?.substring(0, 50)}...`);
            }
        }
        
        // 显示验证规则
        const validation = field.validation || {};
        if (Object.keys(validation).length > 0) {
            console.log("\n验证规则:");
            for (const [key, value] of Object.entries(validation)) {
                console.log(`  - ${key}: ${value}`);
            }
        }
        
        // 显示选项（对于选择框）
        const options = field.options || [];
        if (options.length > 0) {
            console.log("\n可用选项:");
            for (const opt of options.slice(0, 5)) { // 只显示前5个选项
                const optText = opt.text || opt.value || '';
                if (optText) {
                    console.log(`  • ${optText}`);
                }
            }
            if (options.length > 5) {
                console.log(`   ... 还有 ${options.length - 5} 个选项`);
            }
        }
    }

    cancelCurrentTask() {
        if (this.agent) {
            this.agent.cancel();
            this.agent = null;   // 清除引用
        }
    }

    async _aiFillField(field, formStructure, group, context = null) {
        // 1. 检查缓存
        const cached = this._getCachedAnswer(field);
        if (cached) {
            return { success: true, answer: cached, fromCache: true, type: 'finish' };
        }

        // 2. 构建问题描述
        const fieldLabel = field.label || field.name;
        const fieldType = field.type || 'text';
        const required = field.required ? '是' : '否';
        const fieldDesc = field.description || '无';
        const filledText = this._formatAllContext(context);
        const groupFields = group.fields.map(f => f.label || f.name).join(', ');

        const question = `
    你是智能填表助手。当前需要填写字段：
    - 标签：${fieldLabel}
    - 类型：${fieldType}
    - 必填：${required}
    - 描述：${fieldDesc}

    已填写字段（上下文）：
    ${filledText}

    同组其他字段（可能一起填写）：${groupFields}

    可用工具如下：
    ${this.toolExecutor.getToolsDescription()}

    请根据上下文，自主决定是否调用工具获取信息。你可以多次调用工具，最终输出该字段的值。
    输出格式：
    - 如果只有一个确定答案：Finish[答案]
    - 如果有多个候选：Options[选项1 | 选项2 | ...]
    `;

        // 3. 使用 ReActAgent 执行
        const tempAgent = new ReActAgent(this.llmClient, this.toolExecutor, 10, this.onStep);
        this.agent = tempAgent;
        const result = await tempAgent.run(question);
        this.agent = null; 

        if (result && result.type === 'cancelled') {
            return { success: false, type: 'cancelled', message: 'AI 任务已被用户取消' };
        }

        console.log("ReActAgent 返回结果:", result);   // ← 添加这一行

        // 4. 处理结果（增加容错）
        if (result && result.type === 'finish') {
            this._cacheAnswer(field, result.answer);
            return { success: true, type: 'finish', answer: result.answer, discoveryData: result.data };
        } else if (result && result.type === 'options') {
            return { success: true, type: 'options', options: result.options, discoveryData: result.data };
        } else if (result && result.answer) {
            // 如果 result 有 answer 但 type 不是标准值，则按 finish 处理
            console.warn("ReActAgent 返回了非标准结构，但包含 answer，按 finish 处理:", result);
            this._cacheAnswer(field, result.answer);
            return { success: true, type: 'finish', answer: result.answer, discoveryData: result.data };
        } else {
            console.error("AI 未返回有效答案，result =", result);
            return { success: false, message: 'AI 未返回有效答案' };
        }
    }

    _getCachedAnswer(field) {
        const key = field.name || field.label;
        return this.discoveryCache && this.discoveryCache[key] ? this.discoveryCache[key] : null;
    }

    _cacheAnswer(field, value) {
        const key = field.name || field.label;
        if (value && !this.discoveryCache[key]) {
            this.discoveryCache[key] = value;
        }
    }

    _fuzzyMatchCache(label) {
        if (!this.discoveryCache) return null;
        const normalizedLabel = label.toLowerCase();
        
        // 特殊字段：摘要、关键词
        if (normalizedLabel.includes('摘要') || normalizedLabel.includes('abstract')) {
            // 尝试从论文元数据中获取摘要
            const abstractKey = Object.keys(this.discoveryCache).find(k => k.includes('_abstract_for_'));
            if (abstractKey) return this.discoveryCache[abstractKey];
        }
        if (normalizedLabel.includes('关键词') || normalizedLabel.includes('keyword') || normalizedLabel.includes('keywords')) {
            const keywordsKey = Object.keys(this.discoveryCache).find(k => k.includes('_keywords_for_'));
            if (keywordsKey) return this.discoveryCache[keywordsKey];
        }
        
        // 原有逻辑：遍历缓存键
        for (const [key, value] of Object.entries(this.discoveryCache)) {
            const normalizedKey = key.toLowerCase();
            if (normalizedLabel.includes(normalizedKey) || normalizedKey.includes(normalizedLabel)) {
                return value;
            }
        }
        return null;
    }

    async _generateFieldSpecificHintViaLLM(field) {
        /**
         * 使用大模型动态生成字段特定的引导提示
         */
        const fieldLabel = field.label || field.name || '';
        const fieldName = field.name || '';
        const fieldType = field.type || 'text';

        const messages = [
            {
                role: 'system',
                content: `你是一个网页表单填充专家。你的任务是根据表单字段的元数据，生成一条针对该字段的“填充引导提示”。
这条提示将作为上下文发送给另一个 AI Agent，指导它如何利用工具（GetPaperDetails, GetAuthorDetails, FillFormField, GetPageElements）来获取数据并填写。

引导原则：
1. 简洁明了：直接给出建议，不要废话。
2. API策略：
   - 论文相关字段：优先调用 GetPaperDetails[论文标题]，一次获取标题、作者、年份、期刊/会议、关键词、摘要、DOI。
   - 作者相关字段：优先调用 GetAuthorDetails[作者姓名]，获取 PID、主页、机构、别名信息。
   - 表单选择字段：如需定位选项，先用 GetPageElements 获取备选项再比对。
   - 叙述类字段：基于API返回信息概括生成1-3句完整句子，避免省略号。
3. 格式要求：
   - 日期：要求使用 YYYY-MM-DD 格式。
   - 邮箱/网址/数字：明确要求提供有效格式。
4. 通用性：适应学术、社交、商业、国际信息等各种领域的表单。
5. 只输出提示内容本身，不要包含“提示：”或“Hint:”等前缀。`
            },
            {
                role: 'user',
                content: `字段标签: ${fieldLabel}\n字段名: ${fieldName}\n字段类型: ${fieldType}`
            }
        ];

        try {
            const hint = await this.llmClient.think(messages);
            return hint.trim();
        } catch (error) {
            console.error('LLM生成字段提示失败:', error);
            return '';
        }
    }

    async _generateFieldPrompt(field, formStructure, group, context = null) {
        /**
         * 为字段生成提示词，包含已填写的上下文、群组信息和发现缓存
         */
        
        // 格式化验证规则
        const validation = field.validation || {};
        const validationRules = [];
        
        if (validation.required) {
            validationRules.push("必填字段");
        }
        if (validation.type) {
            validationRules.push(`类型: ${validation.type}`);
        }
        if (validation.pattern) {
            validationRules.push(`格式: ${validation.pattern}`);
        }
        if (validation.minLength) {
            validationRules.push(`最小长度: ${validation.minLength}`);
        }
        if (validation.maxLength) {
            validationRules.push(`最大长度: ${validation.maxLength}`);
        }
        
        const validationText = validationRules.length > 0 ? validationRules.join("，") : "无特殊要求";
        
        // 获取所有已填写字段的上下文
        const filledContextText = this._formatAllContext(context);
        
        // 格式化发现缓存
        let discoveryCacheText = "暂无相关缓存信息。";
        if (Object.keys(this.discoveryCache).length > 0) {
            discoveryCacheText = JSON.stringify(this.discoveryCache, null, 2);
        }

        // 获取同组其他待填字段
        const otherFieldsInGroup = group.fields
            .filter(f => f.name !== field.name && !context[f.name])
            .map(f => f.label || f.name)
            .join(", ");
        
        // 获取工具描述
        const toolsDesc = this.toolExecutor.getAvailableTools();
        
        // 构建提示词
        let prompt = this.FORM_PROMPT_TEMPLATE;
        prompt = prompt.split('{form_title}').join(formStructure.title || '未命名表单');
        prompt = prompt.split('{form_description}').join(formStructure.description || '无描述');
        prompt = prompt.split('{group_name}').join(group.name);
        prompt = prompt.split('{group_fields}').join(otherFieldsInGroup || "无（本组其他字段已填完）");
        prompt = prompt.split('{field_label}').join(field.label || field.name || '');
        prompt = prompt.split('{field_type}').join(field.type || '文本');
        prompt = prompt.split('{required}').join(field.required ? '是' : '否');
        prompt = prompt.split('{placeholder}').join(field.placeholder || '无');
        prompt = prompt.split('{field_desc}').join(field.description || '无描述');
        prompt = prompt.split('{validation_rules}').join(validationText);
        prompt = prompt.split('{filled_context}').join(filledContextText);
        prompt = prompt.split('{discovery_cache}').join(discoveryCacheText);
        prompt = prompt.split('{tools}').join(toolsDesc);
        
        // 添加字段特定的指导（提前定义变量以避免访问错误）
        const fieldLabelLower = (field.label || '').toLowerCase();
        const fieldNameLower = (field.name || '').toLowerCase();
        const fieldType = (field.type || '').toLowerCase();
        
        // 针对字段的动态引导 (取代硬编码逻辑)
        const dynamicHint = await this._generateFieldSpecificHintViaLLM(field);
        if (dynamicHint) {
            prompt += `\n提示：${dynamicHint}`;
        }

        // 添加群组批量提取引导
        if (otherFieldsInGroup) {
            prompt += `\n\n【重要：批量提取模式】
通过 'GetPaperDetails[论文标题]' 一次获取论文的所有关键字段，同时顺便填写同组其他字段：[${otherFieldsInGroup}]。
如果需要关键词/摘要/引用数/开放获取链接等，请额外调用 'GetPaperDetailsSemanticScholar[论文标题 或 {"doi": "..."}]'。
若需要会议日期/地点，请调用 'GetWorkOpenAlex[{"doi": "..."}]' 或 'GetWorkCrossRef[{"doi": "..."}]'。
请在返回的 JSON 中附上你顺便提取到的字段，格式如下：
7. **严格格式要求**：
   Finish[答案文本]
   \`\`\`json
   {
     "字段名1": "值1",
     "字段名2": "值2",
     "source": "DBLP API"
   }
   \`\`\`
如果你处于 Options 阶段（用于重名或多篇论文选择）：
Options[选项1 | 选项2]
\`\`\`json
{
  "选项1": { "相关字段名": "值" },
  "选项2": { "相关字段名": "值" }
}
\`\`\``;
        }
        
        // 对于选择框
        const options = field.options || [];
        if (options.length > 0) {
            prompt += "\n⚠️ 这是一个选择题字段，你必须严格从以下选项中选择，不要自行编造任何新选项。只能使用下列选项之一：\n";
            for (let i = 0; i < Math.min(options.length, 10); i++) {
                const opt = options[i];
                const optText = opt.text || opt.value || '';
                if (optText) {
                    prompt += `${i + 1}. ${optText} (值: ${opt.value || optText})\n`;
                }
            }
            if (options.length > 10) {
                prompt += `（还有 ${options.length - 10} 个选项未显示）\n`;
            }
            prompt += "请直接选择最合适的一项，并返回该选项的文本或值。\n";
        }

        if (field.type === 'select' || field.type === 'radio' || field.type === 'checkbox') {
            prompt += `\n⚠️ 这是一个选择题字段。在调用工具时，优先使用 GetPageElements["[name='${field.name}']"] 或 GetPageElements["select[name='${field.name}']"] 获取该字段的所有选项。然后从选项中选择最匹配的一项。不要自己编造选项。`;
        }

        // 格式提示（由LLM在解析时生成）
        if (field.format_hint && field.format_hint.trim()) {
            prompt += `\n格式要求：${field.format_hint}`;
        }
        
        return prompt;
    }

    _formatAllContext(context = null) {
        /**
         * 格式化所有已填写的上下文
         */
        const ctx = context || this.filledContext;
        
        if (!ctx || Object.keys(ctx).length === 0) {
            return "这是第一个字段，还没有填写其他字段。";
        }
        
        // 计算总字符数，避免提示词过长
        let totalChars = 0;
        let filledContextText = `已填写 ${Object.keys(ctx).length} 个字段：\n`;
        
        for (const [fieldName, fieldData] of Object.entries(ctx)) {
            const label = fieldData.label || fieldName;
            const answer = fieldData.answer || '';
            
            // 限制答案显示长度，避免提示词过长
            const maxAnswerLength = 100;
            const displayAnswer = answer.length > maxAnswerLength 
                ? answer.substring(0, maxAnswerLength) + "..." 
                : answer;
            
            // 显示字段类型（如果有）
            const fieldType = fieldData.fieldType || '';
            const typeInfo = fieldType ? ` (${fieldType})` : "";
            
            const line = `- ${label}${typeInfo}: ${displayAnswer}\n`;
            
            // 检查是否超过合理长度（例如2000字符）
            totalChars += line.length;
            if (totalChars > 2000) {
                // 如果超过限制，只显示部分字段
                const remainingFields = Object.keys(ctx).length - filledContextText.split('\n').length + 1;
                filledContextText += `\n（还有 ${remainingFields} 个字段未显示）\n`;
                break;
            }
            
            filledContextText += line;
        }
        
        // 添加简单的指导
        filledContextText += "\n提示：请确保当前字段的填写内容与上述已填写字段在逻辑上保持一致。";
        
        return filledContextText;
    }


    
}

export { FormFillingAgent };
