/**
 * JavaScript ReAct智能体实现
 */

class ToolExecutor {
    /**
     * 一个工具执行器，负责管理和执行工具。
     */
    constructor() {
        this.tools = {};
    }

    registerTool(name, description, func) {
        /**
         * 向工具箱中注册一个新工具。
         */
        if (name in this.tools) {
            console.warn(`警告:工具 '${name}' 已存在，将被覆盖。`);
        }
        this.tools[name] = {"description": description, "func": func};
        console.log(`工具 '${name}' 已注册。`);
    }

    getTool(name) {
        /**
         * 根据名称获取一个工具的执行函数。
         */
        return this.tools[name] ? this.tools[name].func : null;
    }

    getAvailableTools() {
        /**
         * 获取所有可用工具的格式化描述字符串。
         */
        return Object.entries(this.tools)
            .map(([name, info]) => `- ${name}: ${info.description}`)
            .join('\n');
    }
}

const REACT_PROMPT_TEMPLATE = `
你是一个智能填表助手，能够调用外部工具来获取信息。

可用工具如下:
{tools}

**重要指导**：
- 调用工具时，必须只请求你需要的字段，不要请求全部数据。
- 使用工具的参数（如 fields、select）指定你需要的字段列表。
- 示例：
  * 如果只需要论文标题和作者： GetPaperDetailsSemanticScholar[{"title": "...", "fields": ["title", "authors"]}]
  * 如果只需要会议名称和年份： GetWorkOpenAlex[{"doi": "...", "select": ["title", "publication_year", "primary_location"]}]
  * 如果只需要关键词： GetPaperDetailsSemanticScholar[{"doi": "...", "fields": ["fieldsOfStudy"]}]
- 不要重复调用同一个工具获取相同数据，尽量利用上下文中的缓存。
- 如果某个 API 返回 429 错误（请求过于频繁），请尝试使用其他数据源（如 CrossRef 或 OpenAlex）进行查询。
- 在调用工具时，务必使用 fields 或 select 参数只请求需要的字段，以节省请求次数。

请严格按照以下格式进行回应：

Thought: 你的思考过程，用于分析问题、拆解任务和规划下一步行动。
Action: 你决定采取的行动，必须是以下格式之一：
- ToolName[{"param1": "value1", "param2": "value2"}]: 调用一个可用工具，参数必须是 JSON 对象。
- Options[选项1 | 选项2 | ...]: 当你发现多个可能的答案且难以抉择时，提供多个候选项供用户选择。每个选项可以是纯文本，也可以是 JSON 对象格式：{"text": "选项文本", "value": "实际值"}。例如：Options[{"text":"EI收录","value":"EI"}|{"text":"SCI收录","value":"SCI"}]
- Finish[最终答案]: 当你认为已经获得最终答案时。

现在，请开始解决以下问题:
Question: {question}
History: {history}
`;

class ReActAgent {
    constructor(llmClient, toolExecutor, maxSteps = 20, onStep = null) {
        this.llmClient = llmClient;
        this.toolExecutor = toolExecutor;
        this.maxSteps = maxSteps;
        this.onStep = onStep; // 回调函数，用于报告思考和行动
        this.history = [];
        this.cancelled = false;
    }

    cancel() {
        this.cancelled = true;
    }

    // react_agent.js 中 ReActAgent 类的 run 方法

    async run(question) {
        this.cancelled = false;
        this.history = [];
        let currentStep = 0;

        while (currentStep < this.maxSteps) {
            if (this.cancelled) {
                console.log('ReActAgent 已被用户取消');
                return { type: 'cancelled', message: '用户取消了操作' };
            }
            currentStep++;
            console.log(`--- 第 ${currentStep} 步 ---`);

            // 构建 prompt
            const toolsDesc = this.toolExecutor.getToolsDescription ? this.toolExecutor.getToolsDescription() : this.toolExecutor.getAvailableTools();
            const historyStr = this.history.join('\n');
            let prompt = REACT_PROMPT_TEMPLATE;
            prompt = prompt.split('{tools}').join(toolsDesc);
            prompt = prompt.split('{question}').join(question);
            prompt = prompt.split('{history}').join(historyStr);

            const messages = [{ role: "user", content: prompt }];
            let responseText = '';
            let lastThought = '';

            try {
                const stream = this.llmClient.thinkStream(messages);
                for await (const chunk of stream) {
                    responseText += chunk;
                    const [thought] = this._parseOutput(responseText);
                    if (thought && thought !== lastThought && this.onStep) {
                        lastThought = thought;
                        this.onStep({ type: 'thought', content: thought, step: currentStep, isPartial: true });
                    }
                }
            } catch (error) {
                console.error("流式思考出错:", error);
                throw error;
            }

            if (!responseText) {
                console.error("错误:LLM未能返回有效响应。");
                break;
            }

            const [thought, action] = this._parseOutput(responseText);
            if (thought) {
                console.log(`思考: ${thought}`);
                if (this.onStep) this.onStep({ type: 'thought', content: thought, step: currentStep });
            }

            if (!action) {
                console.warn("警告:未能解析出有效的Action，流程终止。");
                break;
            }

            // 处理 Finish
            if (action.startsWith("Finish")) {
            const match = action.match(/Finish\[([\s\S]*?)\](?:\s*$|\s*\n)/);
            let finalAnswer = null;
            if (match) {
                finalAnswer = match[1].trim();
            } else {
                finalAnswer = action.replace(/^Finish\s*\[?/, '').trim();
            }
            if (finalAnswer) {
                console.log(`✅ 解析到 Finish 答案: ${finalAnswer}`);
                // 清理答案：移除可能的代码块标记
                finalAnswer = finalAnswer.replace(/^```json\s*|\s*```$/g, '').trim();
                let data = null;
                const jsonMatch = responseText.match(/```json\n?([\s\S]*?)\n?```/);
                if (jsonMatch) {
                    try { data = JSON.parse(jsonMatch[1]); } catch(e) { console.warn("解析 JSON 失败", e); }
                }
                if (this.onStep) {
                    this.onStep({ type: 'finish', content: finalAnswer, step: currentStep, data: data });
                }
                return { type: 'finish', answer: finalAnswer, data: data };
            } else {
                console.warn("Finish 解析失败，Action 内容:", action);
                return { type: 'finish', answer: action.replace(/^Finish\s*/, ''), data: null };
            }
        }

            // 处理 Options
            if (action.startsWith("Options")) {
            const optionsMatch = action.match(/Options\[(.*)\]/);
            if (optionsMatch) {
                let optionsStr = optionsMatch[1];
                let options = [];
                
                // 尝试解析为 JSON 对象数组（格式：{"text":"a","value":"b"}|...）
                if (optionsStr.includes('{"')) {
                    // 按 | 分割，然后分别解析 JSON
                    const parts = optionsStr.split('|').map(p => p.trim());
                    for (const part of parts) {
                        try {
                            const obj = JSON.parse(part);
                            if (obj.text) {
                                options.push(obj);
                            } else {
                                options.push(part);
                            }
                        } catch (e) {
                            options.push(part);
                        }
                    }
                } else {
                    // 简单分割
                    options = optionsStr.split('|').map(opt => opt.trim());
                }
                
                let data = null;
                const jsonMatch = responseText.match(/```json\n?([\s\S]*?)\n?```/);
                if (jsonMatch) {
                    try { data = JSON.parse(jsonMatch[1]); } catch(e) {}
                }
                if (this.onStep) {
                    this.onStep({ type: 'options', content: options, step: currentStep, data: data });
                }
                return { type: 'options', options: options, data: data };
            }
        }

            // 处理工具调用
            const [toolName, toolInput] = this._parseAction(action);
            if (!toolName) {
                const errorMsg = `错误:无法解析Action格式: "${action}"。请确保使用格式: ToolName[Input] 或 ToolName[]。`;
                console.warn(errorMsg);
                this.history.push(`Action: ${action}`);
                this.history.push(`Observation: ${errorMsg}`);
                continue;
            }

            console.log(`🎬 行动: ${toolName}[${toolInput}]`);
            if (this.onStep) {
                this.onStep({ type: 'action', tool: toolName, input: toolInput, step: currentStep });
            }

            const toolFunction = this.toolExecutor.getTool(toolName);
            let observation;
            if (!toolFunction) {
                observation = `错误:未找到名为 '${toolName}' 的工具。`;
            } else {
                try {
                    const result = await toolFunction(toolInput);
                    observation = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
                    if (observation.length > 15000) observation = observation.substring(0, 15000) + "\n\n【系统提示：内容过长，已截断。】";
                } catch (error) {
                    observation = `执行工具时出错: ${error.message}`;
                }
            }

            console.log(`👀 观察: ${observation}`);
            if (this.onStep) {
                this.onStep({ type: 'observation', content: observation, step: currentStep });
            }

            this.history.push(`Action: ${action}`);
            this.history.push(`Observation: ${observation}`);
        }

        console.log("已达到最大步数，流程终止。");
        // 如果循环结束还没返回，说明没有完成
        return null;
    }

    _parseOutput(text) {
        const thoughtMatch = text.match(/Thought: ([\s\S]*?)(?=\nAction:|$)/i);
        const actionMatch = text.match(/Action: ([\s\S]*?)(?=\n|$)/i);
        const thought = thoughtMatch ? thoughtMatch[1].trim() : null;
        const action = actionMatch ? actionMatch[1].trim() : null;
        return [thought, action];
    }

    _parseAction(actionText) {
        // 首先尝试匹配 ToolName[任意内容]
        const match = actionText.match(/^(\w+)\s*\[([\s\S]*)\]$/);
        if (match) {
            let input = match[2].trim();
            // 如果输入是 JSON 对象，尝试解析，但保留原字符串给工具函数处理
            // 这里只负责提取，不解析 JSON，由工具函数解析
            return [match[1], input];
        }
        // 如果没有括号，则认为是只有工具名
        const simpleMatch = actionText.match(/^(\w+)\s*$/);
        if (simpleMatch) {
            return [simpleMatch[1], ''];
        }
        // 容错：如果 AI 没用中括号而是用了空格，例如 ToolName {"title": "..."}
        const spaceMatch = actionText.match(/^(\w+)\s+(.+)$/);
        if (spaceMatch) {
            return [spaceMatch[1], spaceMatch[2].trim()];
        }
        return [null, null];
    }
}

export { ToolExecutor, ReActAgent };