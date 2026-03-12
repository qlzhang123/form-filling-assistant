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
请注意，你是一个有能力调用外部工具的智能助手。

可用工具如下:
{tools}

请严格按照以下格式进行回应:

Thought: 你的思考过程，用于分析问题、拆解任务和规划下一步行动。
Action: 你决定采取的行动，必须是以下格式之一:
- ToolName[Input]: 调用一个可用工具。
- Options[选项1 | 选项2 | ...]: 当你发现多个可能的答案且难以抉择时，提供多个候选项供用户选择。
- Finish[最终答案]: 当你认为已经获得最终答案时。
- 当你收集到足够的信息，能够回答用户的最终问题时，你必须在Action: 字段后使用 Finish[最终答案] 来输出最终答案。如果存在多个高质量候选项，请使用 Options[...]。

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
    }

    async run(question) {
        /**
         * 运行ReAct智能体来回答一个问题。
         */
        this.history = []; // 每次运行时重置历史记录
        let currentStep = 0;

        while (currentStep < this.maxSteps) {
            currentStep++;
            console.log(`--- 第 ${currentStep} 步 ---`);

            // 1. 格式化提示词
            const toolsDesc = this.toolExecutor.getAvailableTools();
            const historyStr = this.history.join('\n');
            
            // 使用更安全的方式替换占位符，避免 $ 符号导致的替换错误
            let prompt = REACT_PROMPT_TEMPLATE;
            prompt = prompt.split('{tools}').join(toolsDesc);
            prompt = prompt.split('{question}').join(question);
            prompt = prompt.split('{history}').join(historyStr);

            // 2. 调用LLM进行流式思考
            const messages = [{"role": "user", "content": prompt}];
            let responseText = '';
            let lastThought = '';

            try {
                const stream = this.llmClient.thinkStream(messages);
                for await (const chunk of stream) {
                    responseText += chunk;
                    
                    // 实时提取并报告思考过程
                    const [thought] = this._parseOutput(responseText);
                    if (thought && thought !== lastThought && this.onStep) {
                        lastThought = thought;
                        this.onStep({ type: 'thought', content: thought, step: currentStep, isPartial: true });
                    }
                }
            } catch (error) {
                console.error("流式思考出错:", error);
                // 如果流式失败，尝试降级到普通请求或直接抛出
                throw error;
            }
            
            if (!responseText) {
                console.error("错误:LLM未能返回有效响应。");
                break;
            }

            // 3. 解析LLM的最终输出
            const [thought, action] = this._parseOutput(responseText);
            
            if (thought) {
                console.log(`思考: ${thought}`);
                // 如果有回调，通知思考过程
                if (this.onStep) {
                    this.onStep({ type: 'thought', content: thought, step: currentStep });
                }
            }

            if (!action) {
                console.warn("警告:未能解析出有效的Action，流程终止。");
                break;
            }

            // 4. 执行Action
            if (action.startsWith("Finish")) {
                // 如果是Finish指令，提取最终答案并结束
                const finalAnswer = action.match(/Finish\[([\s\S]*)\]/);
                if (finalAnswer) {
                    const answer = finalAnswer[1];
                    console.log(`🎉 最终答案: ${answer}`);
                    
                    // 尝试从原始响应文本中解析附加的 JSON 数据（用于批量提取）
                    let data = null;
                    const jsonMatch = responseText.match(/```json\n?([\s\S]*?)\n?```/);
                    if (jsonMatch) {
                        try { data = JSON.parse(jsonMatch[1]); } catch(e) { console.warn("解析 Finish JSON 失败:", e); }
                    }

                    if (this.onStep) {
                        this.onStep({ type: 'finish', content: answer, step: currentStep, data: data });
                    }
                    return { type: 'finish', answer: answer, data: data };
                }
            }
            
            if (action.startsWith("Options")) {
                // 如果是Options指令，提取候选项并结束
                const optionsMatch = action.match(/Options\[(.*)\]/);
                if (optionsMatch) {
                    const optionsStr = optionsMatch[1];
                    const options = optionsStr.split('|').map(opt => opt.trim());
                    console.log(`🤔 候选项: ${options.join(', ')}`);
                    
                    // 尝试解析附加的 JSON 数据
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
            
            const [toolName, toolInput] = this._parseAction(action);
            if (!toolName) {
                const errorMsg = `错误:无法解析Action格式: "${action}"。请确保使用格式: ToolName[Input] 或 ToolName[]。`;
                console.warn(errorMsg);
                // 将错误信息加入history，避免 AI 无限重复同样的错误
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
                    const result = await toolFunction(toolInput); // 调用真实工具
                    // 确保观察结果是字符串
                    let obsResult = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
                    
                    // 限制观察结果的长度，防止提示词过长导致模型异常
                    const maxObsLength = 15000;
                    if (obsResult.length > maxObsLength) {
                        observation = obsResult.substring(0, maxObsLength) + "\n\n【系统提示：内容过长，已截断。如果需要更多信息，请尝试滚动页面或进行更具体的搜索。】";
                    } else {
                        observation = obsResult;
                    }
                } catch (error) {
                    observation = `执行工具时出错: ${error.message}`;
                }
            }
            
            console.log(`👀 观察: ${observation}`);
            if (this.onStep) {
                this.onStep({ type: 'observation', content: observation, step: currentStep });
            }
            
            // 将本轮的Action和Observation添加到历史记录中
            this.history.push(`Action: ${action}`);
            this.history.push(`Observation: ${observation}`);
        }

        // 循环结束
        console.log("已达到最大步数，流程终止。");
        return null;
    }

    _parseOutput(text) {
        /** 解析LLM的输出，提取Thought和Action。 */
        // 不再全局移除 markdown 标记，以免破坏结构化数据
        const thoughtMatch = text.match(/Thought: ([\s\S]*?)(?=Action:|$)/i);
        const actionMatch = text.match(/Action: ([\s\S]*)/i);
        const thought = thoughtMatch ? thoughtMatch[1].trim() : null;
        const action = actionMatch ? actionMatch[1].trim() : null;
        return [thought, action];
    }

    _parseAction(actionText) {
        /** 解析Action字符串，提取工具名称和输入。 */
        // 1. 尝试匹配 ToolName[Input] 或 ToolName[]
        const match = actionText.match(/^(\w+)\s*\[([\s\S]*)\]/);
        if (match) {
            return [match[1], match[2].trim()];
        }
        
        // 2. 尝试匹配只有工具名的情况 (Action: ToolName)
        const simpleMatch = actionText.match(/^(\w+)\s*$/);
        if (simpleMatch) {
            return [simpleMatch[1], ''];
        }
        
        // 3. 容错处理：如果 AI 没用中括号而是用了空格 (Action: WebSearch "Title")
        const spaceMatch = actionText.match(/^(\w+)\s+(.+)$/);
        if (spaceMatch) {
            // 确保第一个词不是 Finish, Options, Thought 等关键字
            const keywords = ['Thought', 'Action', 'Observation', 'Finish', 'Options'];
            if (!keywords.includes(spaceMatch[1])) {
                return [spaceMatch[1], spaceMatch[2].trim()];
            }
        }
        
        return [null, null];
    }
}

export { ToolExecutor, ReActAgent };