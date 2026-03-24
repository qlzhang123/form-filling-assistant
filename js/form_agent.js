/**
 * JavaScript表单填写智能体
 */

import { ReActAgent, ToolExecutor } from './react_agent.js';
import { FormParser } from './form_parser.js';
import { FormFiller } from './form_tools.js';

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
        
        请严格按照以下格式思考，不要添加任何多余的 Markdown 标记：
        Thought: 思考过程（必须包含你对任务类型的判断。**如果是综合叙述型且已到第 8 步，必须在 Thought 中写明“已达步数上限，开始总结”**）
        Action: ToolName[Input]
            
        现在开始：
        `;
    }

    async fillFormInteractively(url, loginInfo = null) {
        /**
         * 交互式填表主流程
         */
        console.log(`🌐 开始处理网页表单: ${url}`);

        try {
            // 加载和解析表单
            const [parser, formStructure] = await this._loadAndParseForm(url, loginInfo);
            if (!parser || !formStructure) {
                return { success: false, error: "无法加载或解析表单" };
            }
            
            // 提取表单字段
            const fields = parser.extractFormFields();
            if (!fields || fields.length === 0) {
                console.log("❌ 未找到表单字段");
                return { success: false, error: "未找到表单字段" };
            }
            
            console.log(`✅ 发现 ${fields.length} 个表单字段`);

            // 对字段进行逻辑分组
            console.log("🧩 正在对字段进行逻辑分组...");
            const fieldGroups = await this._groupFields(fields, formStructure);
            console.log(`✅ 已将字段划分为 ${fieldGroups.length} 个群组`);
            
            // 初始化交互式填写器
            const filler = new FormFiller(parser);
            
            // 开始交互式填表流程（按群组处理）
            const results = await this._interactiveFillingLoop(fieldGroups, formStructure, filler);
            
            // 生成最终结果
            return this._generateFinalResult(results, fields.length);
            
        } catch (error) {
            console.error('填表过程中发生错误:', error);
            return { success: false, error: error.message };
        }
    }

    

    async _loadAndParseForm(url, loginInfo = null) {
        /**
         * 加载和解析网页表单
         */
        console.log("📋 正在加载和解析表单...");
        
        try {
            // 使用表单解析器
            const parser = new FormParser();
            
            // 加载表单
            const success = await parser.loadForm(url, loginInfo);
            if (!success) {
                console.log("❌ 表单加载失败");
                return [null, null];
            }
            
            // 尝试使用 LLM 增强表单结构分析
            // 注意：这会消耗 tokens 且需要时间，但能显著提高复杂表单的识别准确率
            console.log("🤖 正在使用 LLM 分析表单结构...");
            const llmStructure = await parser.analyzeFormStructureViaLLM(this.llmClient);
            
            // 获取表单结构（结合 LLM 分析结果）
            const formStructure = parser.getFormStructure();
            
            // 如果 LLM 返回了有效结构，保存它供后续分组使用
            if (llmStructure && Array.isArray(llmStructure) && llmStructure.length > 0) {
                console.log("✅ LLM 成功分析出表单结构，将用于后续分组...");
                formStructure.llmTree = llmStructure;
            }
            
            if (!formStructure.fields || formStructure.fields.length === 0) {
                console.log("⚠️  表单结构解析可能不完整");
            }
            
            console.log(`✅ 表单加载成功：${formStructure.title || '未命名表单'}`);
            return [parser, formStructure];
            
        } catch (error) {
            console.error(`❌ 表单加载过程中发生错误: ${error}`);
            return [null, null];
        }
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

    async _interactiveFillingLoop(executionTree, formStructure, filler) {
        /**
         * 交互式填写循环（递归处理）
         */
        const results = [];
        
        // 定义递归处理函数
        const processNode = async (node, depth = 0, siblings = []) => {
            const indent = '  '.repeat(depth);
            
            if (node.isGroup) {
                console.log(`\n${indent}📂 进入群组: ${node.label} (关系: ${node.relationship || '默认'})`);
                
                // 获取当前组内的所有字段兄弟节点，用于提示词构建
                const currentGroupSiblings = node.children.filter(c => c.isField);

                // 处理群组关系
                if (node.relationship === 'or') {
                    // OR 关系：只填一个
                    console.log(`${indent}❓ 检测到互斥关系 (OR)，正在决策填写哪个字段...`);
                    // 简单策略：遍历子节点，如果第一个填写成功，就跳过后面的
                    let filled = false;
                    for (const child of node.children) {
                        if (filled) {
                            console.log(`${indent}⏭️ 已填写互斥组的一个字段，跳过: ${child.label || child.name}`);
                            continue;
                        }
                        const result = await processNode(child, depth + 1, currentGroupSiblings);
                        if (result && result.success) {
                            filled = true;
                        }
                    }
                } else if (node.relationship === 'range') {
                     // Range 关系：通常是起止，都填
                     console.log(`${indent}↔️ 检测到范围关系 (RANGE)，依次填写...`);
                     for (const child of node.children) {
                        await processNode(child, depth + 1, currentGroupSiblings);
                     }
                } else {
                    // 默认 AND 关系：都填
                    for (const child of node.children) {
                        await processNode(child, depth + 1, currentGroupSiblings);
                    }
                }
                return { success: true }; // 群组本身总是算成功处理
            } else if (node.isTable) {
                console.log(`\n${indent}📊 进入表格: ${node.label}`);
                // 调用专门的表格处理方法
                await this.processTable(node, depth, siblings);
                return { success: true };
            } else if (node.isField) {
                return await processField(node, depth, siblings);
            }
        };
        
        const processField = async (field, depth, siblings = []) => {
            const indent = '  '.repeat(depth);
            console.log(`\n${indent}${'='.repeat(40)}`);
            console.log(`${indent}📝 字段: ${field.label || field.name || '未知字段'}`);
            console.log(`${indent}${'='.repeat(40)}`);
            
            // 显示字段信息
            this._displayFieldInfo(field);
            
            // 构造 group 对象用于 _aiFillField，包含同组兄弟字段
            const tempGroup = { 
                name: field.label || '当前字段', 
                fields: siblings.filter(s => s.name !== field.name) 
            };
            
            // 智能填写：使用AI生成答案
            const aiResult = await this._aiFillField(field, formStructure, tempGroup, this.filledContext);
            
            let resultEntry = null;

            if (aiResult.success) {
                // 使用AI答案填写
                const result = await filler.fillFieldInteractive(
                    field.name, 
                    aiResult.answer, 
                    field
                );
                
                resultEntry = {
                    ...result,
                    field: field.name,
                    label: field.label || '',
                    answer: aiResult.answer,
                    method: 'ai',
                    confidence: aiResult.confidence || 0.8
                };
                
                results.push(resultEntry);
                
                // 更新上下文记忆
                this.filledContext[field.name] = {
                    label: field.label || field.name,
                    answer: aiResult.answer,
                    fieldType: field.type || 'text'
                };

                if (aiResult.discoveryData) {
                    console.log(`${indent}💡 发现了额外的群组信息:`, aiResult.discoveryData);
                    Object.assign(this.discoveryCache, aiResult.discoveryData);
                }
                
                return { success: result.success };
            } else {
                console.log(`${indent}❌ AI无法生成答案: ${aiResult.message || '未知错误'}`);
                
                // 添加失败结果
                results.push({
                    field: field.name,
                    label: field.label || '',
                    answer: null,
                    method: 'ai_failed',
                    result: { success: false, message: aiResult.message },
                    confidence: 0
                });
                return { success: false };
            }
        };

        // 开始遍历执行树
        for (const node of executionTree) {
            await processNode(node);
        }
        
        return results;
    }

    /**
     * 获取表格所有行的输入框信息（每行按列顺序返回）
     * 返回数组，每项是该行输入框的数组，每个元素包含 field 对象（含 name, type, xpath）和 label
     */
    async getTableRowsWithColumns() {
        const rows = [];
        try {
            // 使用更通用的选择器：所有表格行（包括可能不在 tbody 内的行）
            const trs = await this.toolExecutor.execute(
                'GetPageElements',
                { selector: 'table tr', tabId: this.formTabId },
                { tabId: this.formTabId }
            );
            if (!trs.success || !trs.elements) return rows;

            for (let i = 0; i < trs.elements.length; i++) {
                // 获取该行内的所有输入框
                const selector = `table tr:nth-child(${i+1}) input, table tr:nth-child(${i+1}) select, table tr:nth-child(${i+1}) textarea`;
                const inputs = await this.toolExecutor.execute(
                    'GetPageElements',
                    { selector, tabId: this.formTabId },
                    { tabId: this.formTabId }
                );
                if (inputs.success && inputs.elements) {
                    const rowFields = inputs.elements.map(el => ({
                        field: { name: el.name || el.id, type: el.type, xpath: el.xpath },
                        label: el.label || ''
                    }));
                    rows.push(rowFields);
                } else {
                    // 即使该行没有输入框，也添加一个空数组以保持行数一致
                    rows.push([]);
                }
            }
        } catch (e) {
            console.error('获取表格行列失败', e);
        }
        return rows;
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

    _cleanAiAnswer(answer, field) {
        /**
         * 清理 AI 返回的答案，移除多余的符号
         */
        if (!answer) return '';
        
        // 移除 Markdown 代码块标记
        let cleaned = answer.replace(/```json[\s\S]*?```/g, '').replace(/```[\s\S]*?```/g, '').trim();
        
        // 如果答案本身就是 JSON 格式（有时候 AI 会直接返回 JSON 而不是放在代码块里）
        if (cleaned.startsWith('{') && cleaned.endsWith('}')) {
            try {
                const json = JSON.parse(cleaned);
                // 尝试提取当前字段的值
                // 1. 优先匹配字段名
                if (json[field.name]) return String(json[field.name]);
                // 2. 其次匹配 label
                if (field.label && json[field.label]) return String(json[field.label]);
                // 3. 再次匹配 'answer' 或 'value' 字段
                if (json.answer) return String(json.answer);
                if (json.value) return String(json.value);
                
                // 4. 如果只有一个键值对，直接返回
                const keys = Object.keys(json);
                if (keys.length === 1) return String(json[keys[0]]);
            } catch (e) {
                // JSON 解析失败，当做普通字符串处理
            }
        }

        // 移除可能的格式标记
        const patterns = [
            /^答案[:：]\s*/i,  // 中文"答案："前缀
            /^Answer[:：]\s*/i,  // 英文"Answer："前缀
            /^填写[:：]\s*/i,  // "填写："前缀
            /^建议[:：]\s*/i,  // "建议："前缀
            /^最终答案[:：]\s*/i,  // "最终答案："前缀
            /^我认为是[:：]\s*/i,  // "我认为是："前缀
            /^应该是[:：]\s*/i,  // "应该是："前缀
        ];
        
        for (const pattern of patterns) {
            cleaned = cleaned.replace(pattern, '');
        }

        // 移除首尾引号
        cleaned = cleaned.replace(/^["']|["']$/g, '').trim();
        
        // 如果是选择字段，尝试匹配选项
        const options = field.options || [];
        if (options.length > 0) {
            // 查找最匹配的选项
            let bestMatch = cleaned;
            let bestScore = 0;
            
            for (const option of options) {
                const optText = (option.text || '').toLowerCase();
                const optValue = (option.value || '').toLowerCase();
                const cleanedLower = cleaned.toLowerCase();
                
                // 计算匹配度
                if (optText && cleanedLower.includes(optText)) {
                    const score = optText.length / cleanedLower.length;
                    if (score > bestScore) {
                        bestScore = score;
                        bestMatch = option.text || cleaned;
                    }
                }
                
                if (optValue && cleanedLower.includes(optValue)) {
                    const score = optValue.length / cleanedLower.length;
                    if (score > bestScore) {
                        bestScore = score;
                        bestMatch = option.value || cleaned;
                    }
                }
            }
            
            // 如果匹配度较高，使用匹配的选项
            if (bestScore > 0.5) {
                cleaned = bestMatch;
            }
        }
        
        // 截断过长的答案（仅当字段有明确的 maxLength 限制时）
        const maxLength = field.validation?.maxLength;
        if (maxLength && cleaned.length > maxLength) {
            // 按照字段限制截断，不添加省略号
            cleaned = cleaned.substring(0, maxLength);
        }
        
        return cleaned;
    }

    _validateAnswer(answer, field) {
        /**
         * 验证答案的合理性
         */
        const validation = {
            valid: true,
            confidence: 0.8,
            warnings: [],
            errors: []
        };
        
        // 检查是否为空
        if (!answer) {
            if (field.required) {
                validation.valid = false;
                validation.errors.push("字段为必填项，不能为空");
            }
            return validation;
        }
        
        // 检查长度
        const answerLen = answer.length;
        const minLen = field.validation?.minLength;
        const maxLen = field.validation?.maxLength;
        
        if (minLen && answerLen < parseInt(minLen)) {
            validation.warnings.push(`长度(${answerLen})小于最小要求(${minLen})`);
            validation.confidence *= 0.8;
        }
        
        if (maxLen && answerLen > parseInt(maxLen)) {
            validation.warnings.push(`长度(${answerLen})超过最大限制(${maxLen})`);
            validation.confidence *= 0.7;
        }
        
        // 检查格式
        const fieldType = (field.type || '').toLowerCase();
        
        // 邮箱格式检查
        if (fieldType === 'email' || field.label?.toLowerCase().includes('email') || field.label?.includes('邮箱')) {
            const emailPattern = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
            if (!emailPattern.test(answer)) {
                validation.warnings.push("邮箱格式可能不正确");
                validation.confidence *= 0.6;
            }
        }
        
        // 网址格式检查
        if (fieldType === 'url' || field.label?.toLowerCase().includes('url') || field.label?.includes('网址') || field.label?.includes('链接')) {
            const urlPattern = /^(https?:\/\/)?([\da-z\.-]+)\.([a-z\.]{2,6})([\/\w \.-]*)*\/?$/;
            if (!urlPattern.test(answer)) {
                validation.warnings.push("网址格式可能不正确");
                validation.confidence *= 0.6;
            }
        }
        
        // 日期格式检查
        if (fieldType === 'date' || field.label?.toLowerCase().includes('date') || field.label?.includes('日期')) {
            const datePatterns = [
                /^\d{4}-\d{2}-\d{2}$/,  // YYYY-MM-DD
                /^\d{4}\/\d{2}\/\d{2}$/,  // YYYY/MM/DD
                /^\d{4}年\d{1,2}月\d{1,2}日$/  // 中文日期
            ];
            if (!datePatterns.some(pattern => pattern.test(answer))) {
                validation.warnings.push("日期格式可能不正确");
                validation.confidence *= 0.7;
            }
        }
        
        // 模式匹配检查
        const pattern = field.validation?.pattern;
        if (pattern) {
            try {
                const regex = new RegExp(pattern);
                if (!regex.test(answer)) {
                    validation.warnings.push("不符合指定的格式模式");
                    validation.confidence *= 0.5;
                }
            } catch (e) {
                console.warn('正则表达式验证失败:', e);
            }
        }
        
        return validation;
    }

    _generateFinalResult(results, totalFields) {
        /**
         * 生成最终结果
         */
        // 统计
        const filled = results.filter(r => r.result?.success);
        const skipped = results.filter(r => r.method === 'skipped');
        const failed = results.filter(r => !r.result?.success && r.method !== 'skipped');
        
        return {
            success: filled.length > 0,  // 只要有成功填写的就算成功
            message: `填表完成，成功填写 ${filled.length} 个字段`,
            stats: {
                totalFields: totalFields,
                filled: filled.length,
                skipped: skipped.length,
                failed: failed.length,
                completionRate: totalFields > 0 ? (filled.length / totalFields * 100) : 0
            },
            results: results
        };
    }
}

export { FormFillingAgent };
