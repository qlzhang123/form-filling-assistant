/**
 * JavaScript LLM客户端
 */

class DeepSeekLLM {
    /**
     * DeepSeek LLM客户端，用于调用DeepSeek API
     */
    constructor(apiKey = null, model = null, baseUrl = null) {
        this.apiKey = apiKey || localStorage.getItem('deepseek_api_key') || '';
        this.model = model || localStorage.getItem('llm_model') || 'deepseek-chat';
        this.baseUrl = baseUrl || 'https://api.deepseek.com';
    }

    async think(messages, temperature = 0) {
        /**
         * 调用大语言模型进行思考，并返回其响应。
         */
        const stream = this.thinkStream(messages, temperature);
        let fullContent = '';
        for await (const chunk of stream) {
            fullContent += chunk;
        }
        return fullContent;
    }

    async *thinkStream(messages, temperature = 0) {
        /**
         * 流式调用大语言模型进行思考
         */
        console.log(`🧠 正在流式调用 ${this.model} 模型...`);
        
        if (!this.apiKey) {
            if (typeof chrome !== 'undefined' && chrome.storage) {
                const result = await chrome.storage.local.get(['aiSettings']);
                if (result.aiSettings && result.aiSettings.apiKey) {
                    this.apiKey = result.aiSettings.apiKey;
                }
            } else {
                this.apiKey = localStorage.getItem('deepseek_api_key') || '';
            }
        }
        
        if (!this.apiKey) {
            throw new Error('API密钥未配置，请在设置中配置DeepSeek API密钥');
        }
        
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({
                model: this.model,
                messages: messages,
                temperature: temperature,
                stream: true
            })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API请求失败: ${response.status} ${response.statusText}. ${errorText}`);
        }
        
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = '';
        
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop(); // 保持最后一个可能不完整的行在缓冲区
            
            for (const line of lines) {
                if (line.trim() === '') continue;
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data.trim() === '[DONE]') continue;
                    try {
                        const parsed = JSON.parse(data);
                        const content = parsed.choices[0]?.delta?.content || '';
                        if (content) yield content;
                    } catch (e) {
                        // 忽略解析错误（可能是部分行）
                    }
                }
            }
        }
    }
}

export { DeepSeekLLM };