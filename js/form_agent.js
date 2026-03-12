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
    
重要指导：
1. 优先使用API：
    * 使用 GetPaperDetails[论文标题] 获取标题、作者、年份、期刊/会议、DOI 等基础信息。
    * 使用 GetPaperDetailsSemanticScholar[论文标题 或 {"doi": "..."}] 获取关键词、摘要、引用数、PDF 链接等补充信息。
    * 使用 GetAuthorDetails[作者姓名] 或 GetAuthorDetailsSemanticScholar[作者姓名] 获取作者主页、别名与机构信息。
    * 引用次数优先调用 GetCitationCount[{ "doi": "..." }]，无法获取时再从 Semantic Scholar 中读取 citationCount。
    * 会议日期/地点可调用 GetWorkOpenAlex[{ "doi": "..." }] 或 GetWorkCrossRef[{ "doi": "..." }]。
    * 需要会议地点时可调用 GetConferenceLocation[{ "name": "会议名称", "year": 2024 }]。
    * 需要会议组织者时可调用 GetConferenceOrganizers[{ "name": "会议名称", "year": 2024 }]。
2. 聚焦当前字段：
    * 核心任务是填写当前字段（{field_label}）。仅在最后用 JSON 补充你顺便获得的同组字段。
3. 选项优先：
    * 若存在多个高质量候选答案，使用 Options[选项1 | 选项2 | ...]，最多 10 项。
4. 缓存优先：
    * 如果“发现缓存”中已有答案或完整元数据，直接 Finish，不要重复调用工具。
5. 信息整合：
    * 对具体事实类字段需给出确定值；对叙述类字段基于已知信息生成1-3句完整句子。
6. 批量提取：
    * 通过一次或多次API调用（DBLP + Semantic Scholar + CrossRef/OpenAlex）获取论文详细信息，请将相关字段一并放入 Finish 后的 JSON。
    
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
                                isField: true
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
                const currentGroupSiblings = node.children.filter(c => c.isField);
                // 表格处理：遍历所有子节点（字段）
                for (const child of node.children) {
                    await processNode(child, depth + 1, currentGroupSiblings);
                }
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

    async _aiFillField(field, formStructure, group, context = null) {
        /**
         * 使用AI智能填写字段，考虑上下文和群组信息
         */
        const fieldLabel = field.label || field.name;
        const fieldKey = field.name || fieldLabel;
        
        // --- 核心优化：缓存预检 (Cache Fast-Path) ---
        // 检查发现缓存中是否已有该群组字段的答案，如果有，直接返回，避免冗余搜索
        if (this.discoveryCache) {
            // 尝试匹配：字段名、标签、或者模糊匹配
            const cachedValue = this.discoveryCache[fieldKey] || 
                                this.discoveryCache[fieldLabel] || 
                                this._fuzzyMatchCache(fieldLabel);
                            
            
                                
            // 特殊处理：如果当前是期刊/会议字段，检查是否有缓存的期刊/会议信息
            if (!cachedValue && (fieldLabel.toLowerCase().includes('venue') || fieldLabel.toLowerCase().includes('conference') || fieldLabel.toLowerCase().includes('journal'))) {
                // 检查是否有与已填论文标题关联的期刊信息
                const paperTitle = context[Object.keys(context).find(k => k.toLowerCase().includes('title'))]?.answer;
                if (paperTitle) {
                    const cachedVenue = this.discoveryCache[`_venue_for_${paperTitle}`];
                    if (cachedVenue) {
                        console.log(`📚 发现缓存的期刊/会议信息: ${paperTitle} -> ${cachedVenue}`);
                        return {
                            success: true,
                            type: 'finish',
                            answer: cachedVenue,
                            fromCache: true,
                            message: `已从缓存中获取期刊/会议信息：${cachedVenue}`
                        };
                    }
                }
            }
                                
            // 特殊处理：如果当前是年份字段，检查是否有缓存的年份信息
            if (!cachedValue && (fieldLabel.toLowerCase().includes('year') || fieldLabel.toLowerCase().includes('publication'))) {
                // 检查是否有与已填论文标题关联的年份信息
                const paperTitle = context[Object.keys(context).find(k => k.toLowerCase().includes('title'))]?.answer;
                if (paperTitle) {
                    const cachedYear = this.discoveryCache[`_year_for_${paperTitle}`];
                    if (cachedYear) {
                        console.log(`📅 发现缓存的年份信息: ${paperTitle} -> ${cachedYear}`);
                        return {
                            success: true,
                            type: 'finish',
                            answer: cachedYear,
                            fromCache: true,
                            message: `已从缓存中获取年份信息：${cachedYear}`
                        };
                    }
                }
            }
            
            // 特殊处理：如果当前是 Keywords/Abstract/引用次数/会议日期/地点等字段，尝试从整篇元数据缓存中命中
            const isPaperMetadataField = fieldLabel.toLowerCase().includes('keyword') || 
                                        fieldLabel.toLowerCase().includes('abstract') || 
                                        fieldLabel.toLowerCase().includes('关键词') || 
                                        fieldLabel.toLowerCase().includes('摘要') ||
                                        fieldLabel.toLowerCase().includes('引用') ||
                                        fieldLabel.toLowerCase().includes('citation') ||
                                        fieldLabel.toLowerCase().includes('日期') ||
                                        fieldLabel.toLowerCase().includes('地点');
            if (!cachedValue && isPaperMetadataField) {
                const paperTitle = context[Object.keys(context).find(k => k.toLowerCase().includes('title'))]?.answer;
                if (paperTitle) {
                    const meta = this.discoveryCache[`_paper_meta_for_${paperTitle}`];
                    const byField =
                        fieldLabel.toLowerCase().includes('keyword') || fieldLabel.toLowerCase().includes('关键词') ? (meta?.keywords || this.discoveryCache[`_keywords_for_${paperTitle}`]) :
                        fieldLabel.toLowerCase().includes('abstract') || fieldLabel.toLowerCase().includes('摘要') ? (meta?.abstract || this.discoveryCache[`_abstract_for_${paperTitle}`]) :
                        fieldLabel.toLowerCase().includes('引用') || fieldLabel.toLowerCase().includes('citation') ? (meta?.citationCount || this.discoveryCache[`_citation_for_${paperTitle}`]) :
                        fieldLabel.toLowerCase().includes('日期') ? (meta?.publicationDate || this.discoveryCache[`_date_for_${paperTitle}`]) :
                        fieldLabel.toLowerCase().includes('地点') ? (meta?.location || this.discoveryCache[`_location_for_${paperTitle}`]) :
                        null;
                    if (byField) {
                        console.log(`📝 发现缓存的元数据字段: ${fieldLabel} -> ${byField}`);
                        return {
                            success: true,
                            type: 'finish',
                            answer: byField,
                            fromCache: true,
                            message: `已从缓存中获取元数据信息`
                        };
                    }
                }
            }
                                
            // 特殊处理：如果当前是作者字段，检查是否有缓存的作者页面URL
            const isAuthorUrlField = (fieldLabel.toLowerCase().includes('author') || fieldLabel.toLowerCase().includes('dblp')) && fieldLabel.toLowerCase().includes('url');
            if (!cachedValue && isAuthorUrlField) {
                const authorName = context[Object.keys(context).find(k => k.toLowerCase().includes('author') && !k.toLowerCase().includes('url'))]?.answer || 
                                 fieldLabel.replace(/\s*url\s*/gi, '').replace(/dblp/gi, '').trim();
                if (authorName) {
                    const cachedUrl = this.discoveryCache[`_author_url_${authorName}`] || this.discoveryCache['dblp_persistent_url'];
                    if (cachedUrl) {
                        console.log(`🔗 发现缓存的作者页面URL: ${authorName} -> ${cachedUrl}`);
                        return {
                            success: true,
                            type: 'finish',
                            answer: cachedUrl,
                            fromCache: true,
                            message: `已从缓存中获取作者页面URL：${cachedUrl}`
                        };
                    }
                }
            }
                            
            if (cachedValue) {
                console.log(`✨ 从发现缓存中命中答案: '${fieldLabel}' -> ${cachedValue.substring(0, 100)}...`);
                                
                // 特殊处理：如果是URL字段且缓存中有URL，直接返回
                if (fieldLabel.toLowerCase().includes('url') || field.type === 'url') {
                    return {
                        success: true,
                        type: 'finish',
                        answer: cachedValue,
                        fromCache: true,
                        message: `已从缓存中获取URL：${cachedValue}`
                    };
                }
                                
                return {
                    success: true,
                    type: 'finish',
                    answer: cachedValue,
                    fromCache: true,
                    message: `已从之前的搜索中自动提取到答案：${cachedValue.substring(0, 100)}...`
                };
            }
        }
        
        console.log(`🤖 AI正在为 '${fieldLabel}' 思考（属于群组: ${group.name}）...`);
        
        try {
            const ctx = context || this.filledContext || {};
            const flat = {};
            for (const [k, v] of Object.entries(ctx)) {
                if (v && typeof v === 'object') {
                    if (v.answer != null) flat[k] = v.answer;
                    if (v.label && v.answer != null) flat[v.label] = v.answer;
                } else if (v != null) {
                    flat[k] = v;
                }
            }

            const paperTitleKey = Object.keys(ctx).find(k => {
                const s = String(k).toLowerCase();
                return s.includes('title') || s.includes('题目') || s.includes('标题');
            });
            const paperTitle = paperTitleKey ? (ctx[paperTitleKey]?.answer || ctx[paperTitleKey]) : '';
            const paperMeta = paperTitle ? (this.discoveryCache[`_paper_meta_for_${paperTitle}`] || {}) : {};

            const known = {
                ...paperMeta,
                title: paperMeta.title || flat['论文标题'] || flat['title'] || paperTitle || '',
                authors: paperMeta.authors || flat['论文作者'] || flat['作者'] || flat['authors'] || '',
                venue: paperMeta.venue || flat['期刊/会议'] || flat['venue'] || '',
                venueRaw: paperMeta.venueRaw || flat['期刊/会议(原始)'] || flat['venueRaw'] || '',
                year: paperMeta.year || flat['年份'] || flat['year'] || '',
                doi: paperMeta.doi || flat['DOI'] || flat['doi'] || '',
                url: paperMeta.url || flat['链接'] || flat['url'] || '',
                abstract: paperMeta.abstract || flat['摘要'] || flat['abstract'] || '',
                keywords: paperMeta.keywords || flat['关键词'] || flat['keywords'] || '',
                citationCount: paperMeta.citationCount != null ? paperMeta.citationCount : (flat['引用次数'] || flat['citationCount'] || ''),
                grants: paperMeta.grants || flat['基金/资助'] || flat['grants'] || '',
                articleNumber: paperMeta.articleNumber || flat['文章号/编码'] || flat['文章号'] || flat['articleNumber'] || '',
                firstPage: paperMeta.firstPage || flat['起始页码'] || flat['firstPage'] || '',
                lastPage: paperMeta.lastPage || flat['终止页码'] || flat['lastPage'] || '',
                pageRange: paperMeta.pageRange || flat['页码范围'] || flat['pageRange'] || '',
                publicationDate: paperMeta.publicationDate || flat['发表日期'] || flat['publicationDate'] || '',
                publicationMonth: paperMeta.publicationMonth || flat['发表月份'] || flat['publicationMonth'] || '',
                publicationDay: paperMeta.publicationDay || flat['发表日'] || flat['publicationDay'] || '',
                conferenceEventDate: paperMeta.conferenceEventDate || flat['会议举办日期'] || flat['conferenceEventDate'] || '',
                conferenceStartDate: paperMeta.conferenceStartDate || flat['会议开始日期'] || flat['conferenceStartDate'] || '',
                conferenceEndDate: paperMeta.conferenceEndDate || flat['会议结束日期'] || flat['conferenceEndDate'] || '',
                conferenceStartMonth: paperMeta.conferenceStartMonth || flat['会议开始月份'] || flat['conferenceStartMonth'] || '',
                conferenceStartDay: paperMeta.conferenceStartDay || flat['会议开始日'] || flat['conferenceStartDay'] || '',
                conferenceEndMonth: paperMeta.conferenceEndMonth || flat['会议结束月份'] || flat['conferenceEndMonth'] || '',
                conferenceEndDay: paperMeta.conferenceEndDay || flat['会议结束日'] || flat['conferenceEndDay'] || '',
                conferenceName: paperMeta.conferenceName || flat['会议名称'] || flat['conferenceName'] || '',
                conferenceLocation: paperMeta.conferenceLocation || flat['会议地点'] || flat['conferenceLocation'] || '',
                organizers: paperMeta.organizers || flat['会议组织者'] || flat['organizers'] || '',
                language: paperMeta.language || flat['文章语言'] || flat['语言'] || flat['language'] || '',
                currentAuthor: flat['_当前作者'] || flat['当前作者'] || this.discoveryCache['_current_author_name'] || '',
                currentAuthorIndex: flat['_作者行号'] || flat['作者行号'] || this.discoveryCache['_current_author_index'] || '',
                filters: flat['筛选条件'] || ''
            };

            const label = String(fieldLabel || '').toLowerCase();
            const type = String(field.type || '').toLowerCase();
            const authorsStr = Array.isArray(known.authors) ? known.authors.join(', ') : String(known.authors || '');

            const heuristic = async () => {
                if (label.includes('title') || label.includes('题目') || label.includes('标题')) return String(known.title || '');
                if ((label.includes('作者') || label.includes('author')) && (label.includes('姓名') || label.includes('name')) && known.currentAuthor) return String(known.currentAuthor);
                if (label.includes('author') || label.includes('作者')) return authorsStr;
                // 会议地点优先于 venue，避免“会议地址”误命中 venue
                if (label.includes('地点') || label.includes('地址') || label.includes('address') || label.includes('location')) {
                    if (known.conferenceLocation) return String(known.conferenceLocation);
                    const confName = String(known.venueRaw || known.conferenceName || known.venue || '').trim();
                    const confYear = String(known.year || '').trim();
                    if (confName && confYear && this.toolExecutor && this.toolExecutor.execute) {
                        const r = await this.toolExecutor.execute(
                            'GetConferenceLocation',
                            { name: confName, year: confYear },
                            { discoveryCache: this.discoveryCache }
                        );
                        const loc = r?.data?.location ? String(r.data.location).trim() : '';
                        if (loc) {
                            known.conferenceLocation = loc;
                            if (paperTitle) {
                                const metaKey = `_paper_meta_for_${paperTitle}`;
                                if (this.discoveryCache[metaKey] && typeof this.discoveryCache[metaKey] === 'object') {
                                    this.discoveryCache[metaKey].conferenceLocation = loc;
                                }
                            }
                            return loc;
                        }
                    }
                    return 'UNKNOWN';
                }
                if (
                    (label.includes('venue') || label.includes('conference') || label.includes('journal') || label.includes('期刊') || label.includes('会议')) &&
                    !(label.includes('地址') || label.includes('地点') || label.includes('address') || label.includes('location') || label.includes('组织者') || label.includes('organizer') || label.includes('organiser') || label.includes('chair'))
                ) return String(known.venue || '');
                if (label.includes('year') || label.includes('年份') || label.includes('出版')) return String(known.year || '');
                const isConferenceDateField =
                    (label.includes('会议') || label.includes('conference') || label.includes('event')) &&
                    (label.includes('日期') || label.includes('时间') || label.includes('date') || label.includes('time')) &&
                    !(label.includes('发表') || label.includes('出版') || label.includes('publication') || label.includes('publish'));
                const isConferenceStartDateField =
                    isConferenceDateField && (label.includes('开始') || label.includes('start') || label.includes('from') || label.includes('起始'));
                const isConferenceEndDateField =
                    isConferenceDateField && (label.includes('结束') || label.includes('end') || label.includes('to') || label.includes('终止'));
                if (isConferenceDateField) {
                    if (isConferenceStartDateField) return known.conferenceStartDate ? String(known.conferenceStartDate) : 'UNKNOWN';
                    if (isConferenceEndDateField) return known.conferenceEndDate ? String(known.conferenceEndDate) : 'UNKNOWN';
                    if (known.conferenceEventDate) return String(known.conferenceEventDate);
                    if (known.conferenceStartDate) return String(known.conferenceStartDate);

                    const confName = String(known.venueRaw || known.conferenceName || known.venue || '').trim();
                    const confYear = String(known.year || '').trim();
                    if (confName && confYear && this.toolExecutor && this.toolExecutor.execute) {
                        const r = await this.toolExecutor.execute(
                            'GetConferenceEventDate',
                            { name: confName, year: confYear },
                            { discoveryCache: this.discoveryCache }
                        );
                        const data = r?.data || null;
                        if (data && data.conferenceEventDate) {
                            known.conferenceEventDate = data.conferenceEventDate || '';
                            known.conferenceStartDate = data.conferenceStartDate || '';
                            known.conferenceEndDate = data.conferenceEndDate || '';
                            known.conferenceStartMonth = data.conferenceStartMonth || '';
                            known.conferenceStartDay = data.conferenceStartDay || '';
                            known.conferenceEndMonth = data.conferenceEndMonth || '';
                            known.conferenceEndDay = data.conferenceEndDay || '';
                            if (paperTitle) {
                                const metaKey = `_paper_meta_for_${paperTitle}`;
                                if (this.discoveryCache[metaKey] && typeof this.discoveryCache[metaKey] === 'object') {
                                    Object.assign(this.discoveryCache[metaKey], {
                                        conferenceEventDate: known.conferenceEventDate,
                                        conferenceStartDate: known.conferenceStartDate,
                                        conferenceEndDate: known.conferenceEndDate,
                                        conferenceStartMonth: known.conferenceStartMonth,
                                        conferenceStartDay: known.conferenceStartDay,
                                        conferenceEndMonth: known.conferenceEndMonth,
                                        conferenceEndDay: known.conferenceEndDay
                                    });
                                }
                            }
                            if (isConferenceStartDateField) return known.conferenceStartDate ? String(known.conferenceStartDate) : 'UNKNOWN';
                            if (isConferenceEndDateField) return known.conferenceEndDate ? String(known.conferenceEndDate) : 'UNKNOWN';
                            return String(known.conferenceEventDate);
                        }
                    }
                    return 'UNKNOWN';
                }

                if (label.includes('发表日期') || label.includes('出版日期') || (label.includes('publication') && label.includes('date')) || (label.includes('publish') && label.includes('date'))) {
                    return known.publicationDate ? String(known.publicationDate) : 'UNKNOWN';
                }
                if (label.includes('发表月份') || label.includes('出版月份') || ((label.includes('month') || label.includes('月份') || label.includes('月')) && (label.includes('发表') || label.includes('出版') || label.includes('publish') || label.includes('publication')))) {
                    return known.publicationMonth ? String(known.publicationMonth) : 'UNKNOWN';
                }
                if (label.includes('发表日') || label.includes('出版日') || ((label.includes('day') || label.includes('日')) && (label.includes('发表') || label.includes('出版') || label.includes('publish') || label.includes('publication')))) {
                    return known.publicationDay ? String(known.publicationDay) : 'UNKNOWN';
                }
                if (label.includes('language') || label.includes('语言')) {
                    const code = String(known.language || '').toLowerCase().trim();
                    if (!code) return 'UNKNOWN';
                    if (label.includes('language')) {
                        if (code === 'en') return 'English';
                        if (code === 'zh') return 'Chinese';
                        return code;
                    }
                    if (code === 'en') return '英文';
                    if (code === 'zh') return '中文';
                    return code;
                }
                const isStartPage = (label.includes('起始') || label.includes('首页') || label.includes('start') || label.includes('first')) && label.includes('page');
                const isEndPage = (label.includes('终止') || label.includes('末页') || label.includes('end') || label.includes('last')) && label.includes('page');
                const isPageRange = (label.includes('页码') || label.includes('pages') || label.includes('page range')) && !isStartPage && !isEndPage;
                if (isStartPage) return known.firstPage ? String(known.firstPage) : 'UNKNOWN';
                if (isEndPage) return known.lastPage ? String(known.lastPage) : 'UNKNOWN';
                if (isPageRange) return known.pageRange ? String(known.pageRange) : 'UNKNOWN';
                if (label.includes('组织者') || label.includes('organizer') || label.includes('organiser') || label.includes('chair')) {
                    const existing = (() => {
                        if (Array.isArray(known.organizers)) return known.organizers.filter(Boolean);
                        const s = String(known.organizers || '').trim();
                        if (!s) return [];
                        return s.split(/[;,，；\n\t]+/).map(x => x.trim()).filter(Boolean);
                    })();
                    if (existing.length) return existing.join(', ');
                    const confName = String(known.venueRaw || known.conferenceName || known.venue || '').trim();
                    const confYear = String(known.year || '').trim();
                    if (confName && confYear && this.toolExecutor && this.toolExecutor.execute) {
                        const r = await this.toolExecutor.execute(
                            'GetConferenceOrganizers',
                            { name: confName, year: confYear },
                            { discoveryCache: this.discoveryCache }
                        );
                        const orgs = Array.isArray(r?.data?.organizers) ? r.data.organizers : [];
                        if (orgs.length) {
                            known.organizers = orgs;
                            if (paperTitle) {
                                const metaKey = `_paper_meta_for_${paperTitle}`;
                                if (this.discoveryCache[metaKey] && typeof this.discoveryCache[metaKey] === 'object') {
                                    this.discoveryCache[metaKey].organizers = orgs;
                                }
                            }
                            return orgs.join(', ');
                        }
                    }
                    return 'UNKNOWN';
                }
                const isArticleNumber =
                    label.includes('文章号') || label.includes('文章编号') || label.includes('文章编码') ||
                    label.includes('articlenumber') || (label.includes('article') && label.includes('number')) ||
                    ((label.includes('编号') || label.includes('编码')) && !label.includes('doi'));
                if (isArticleNumber) return known.articleNumber ? String(known.articleNumber) : 'UNKNOWN';
                if (label.includes('doi')) return String(known.doi || '');
                if (label.includes('url') || label.includes('link') || label.includes('链接') || type === 'url') return String(known.url || '');
                if (label.includes('abstract') || label.includes('摘要')) return String(known.abstract || '');
                if (label.includes('keyword') || label.includes('关键词')) {
                    if (Array.isArray(known.keywords)) return known.keywords.join(', ');
                    return String(known.keywords || 'UNKNOWN');
                }
                if (label.includes('citation') || label.includes('引用')) return known.citationCount != null ? String(known.citationCount) : '';
                if (label.includes('grant') || label.includes('fund') || label.includes('基金') || label.includes('资助')) {
                    if (Array.isArray(known.grants)) return JSON.stringify(known.grants);
                    return String(known.grants || '');
                }
                return '';
            };

            const direct = await heuristic();
            if (direct) {
                const cleaned = this._cleanAiAnswer(direct, field);
                const validation = this._validateAnswer(cleaned, field);
                return {
                    success: true,
                    type: 'finish',
                    answer: cleaned,
                    rawAnswer: cleaned,
                    validation: validation,
                    confidence: validation.confidence || 0.9
                };
            }

            const options = field.options || [];
            const optionTexts = options.map(o => (o.text || o.value || '')).filter(Boolean);

            const messages = [{
                role: "user",
                content: [
                    "你是一个表单字段映射器。你只能从已知数据中选择值，绝对不能编造、搜索、推断新的事实。",
                    "如果找不到合适值，输出 UNKNOWN。",
                    "只输出一个值，不要解释，不要换行，不要 Markdown。",
                    "",
                    `字段: ${fieldLabel}`,
                    `字段类型: ${field.type || ''}`,
                    optionTexts.length ? `可选项: ${optionTexts.join(' | ')}` : "可选项: (无)",
                    "",
                    "已知数据(JSON):",
                    JSON.stringify(known)
                ].join("\n")
            }];

            let out = '';
            const stream = this.llmClient.thinkStream(messages);
            for await (const chunk of stream) {
                out += chunk;
                if (out.length > 2000) break;
            }
            const picked = String(out || '').trim().split('\n')[0].trim();
            const finalPicked = picked && picked.toUpperCase() !== 'UNKNOWN' ? picked : 'UNKNOWN';

            const cleaned = this._cleanAiAnswer(finalPicked, field);
            const validation = this._validateAnswer(cleaned, field);
            return {
                success: true,
                type: 'finish',
                answer: cleaned,
                rawAnswer: picked,
                validation: validation,
                confidence: validation.confidence || 0.7
            };
                
        } catch (error) {
            return {
                success: false,
                message: `AI处理出错: ${error.message}`,
                confidence: 0
            };
        }
    }

    _fuzzyMatchCache(label) {
        /**
         * 增强的模糊匹配缓存
         */
        if (!this.discoveryCache) return null;
        const normalizedLabel = label.toLowerCase();
        const isArticleNumber =
            normalizedLabel.includes('文章号') || normalizedLabel.includes('文章编号') || normalizedLabel.includes('文章编码') ||
            normalizedLabel.includes('articlenumber') || (normalizedLabel.includes('article') && normalizedLabel.includes('number')) ||
            ((normalizedLabel.includes('编号') || normalizedLabel.includes('编码')) && !normalizedLabel.includes('doi'));
        const looksLikeDoi = (v) => typeof v === 'string' && /^10\.\d{4,9}\/[-._;()/:A-Z0-9]+$/i.test(v.trim());
        
        // 优先匹配包含关键词的缓存项
        for (const [key, value] of Object.entries(this.discoveryCache)) {
            const normalizedKey = key.toLowerCase();
            // 检查标签是否包含关键字段标识
            if (normalizedLabel.includes('venue') || normalizedLabel.includes('conference') || normalizedLabel.includes('journal')) {
                // 如果缓存的值本身像是期刊或会议名称（包含常见期刊关键词）
                // 确保 value 是字符串类型
                if (typeof value === 'string') {
                    const normalizedValue = value.toLowerCase();
                    if (normalizedValue.includes('journal') || normalizedValue.includes('conference') || 
                        normalizedValue.includes('transac') || normalizedValue.includes('proc') || 
                        normalizedValue.includes('symposium') || normalizedValue.includes('workshop')) {
                        console.log(`🎯 模糊匹配到期刊/会议信息: ${key} -> ${value}`);
                        return value;
                    }
                }
            }
        }
        
        // 原有的通用模糊匹配逻辑
        for (const [key, value] of Object.entries(this.discoveryCache)) {
            const normalizedKey = key.toLowerCase();
            if (normalizedLabel.includes(normalizedKey) || normalizedKey.includes(normalizedLabel)) {
                if (isArticleNumber && (normalizedKey.includes('doi') || looksLikeDoi(value))) continue;
                return value;
            }
        }
        
        // 更宽松的匹配：检查缓存值是否包含标签关键词
        for (const [key, value] of Object.entries(this.discoveryCache)) {
            // 确保 value 是字符串类型
            if (typeof value === 'string') {
                const normalizedValue = value.toLowerCase();
                if (normalizedValue.includes(normalizedLabel) || normalizedLabel.includes(normalizedValue)) {
                    if (isArticleNumber && (String(key).toLowerCase().includes('doi') || looksLikeDoi(value))) continue;
                    return value;
                }
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
            prompt += "\n提示：这是一个选择字段，请从以下选项中选择：\n";
            for (let i = 0; i < Math.min(options.length, 10); i++) { // 显示最多10个选项
                const opt = options[i];
                const optText = opt.text || opt.value || '';
                if (optText) {
                    prompt += `${i + 1}. ${optText}\n`;
                }
            }
            if (options.length > 10) {
                prompt += `（还有 ${options.length - 10} 个选项未显示）\n`;
            }
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
