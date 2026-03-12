# 智能填表助手浏览器插件 - 项目结构

## 项目概述
这是一个融合了搜索助手和表单填写功能的浏览器插件，将原来的两个独立项目合并为一个统一的填表助手工具。

## 项目文件结构

```
form-filling-assistant/
├── manifest.json                 # 浏览器扩展配置文件
├── background.js                 # 背景脚本，处理扩展内部通信
├── sidebar.html                  # 侧边栏界面
├── sidebar.js                    # 侧边栏主控制器
├── styles.css                    # 样式文件
├── content_script.js             # 内容脚本，与目标网页交互
├── icons/                        # 图标文件夹
│   ├── icon16.png               # 16x16像素图标
│   ├── icon48.png               # 48x48像素图标
│   └── icon128.png              # 128x128像素图标
└── js/                           # JavaScript模块文件夹
    ├── llm_client.js             # LLM客户端，处理API调用
    ├── react_agent.js            # ReAct智能体核心实现
    ├── form_agent.js             # 表单填写智能体
    ├── form_parser.js            # 表单解析器
    ├── form_tools.js             # 表单操作工具
    ├── tool_executor.js          # 增强版工具执行器
    ├── tools.js                  # 各类工具集合
    └── browser_controller.js     # 浏览器交互控制器
```

## 核心功能模块

### 1. ReAct智能体系统 (js/react_agent.js)
- 实现了ReAct（Reasoning and Acting）架构
- 支持Thought-Action-Observation循环
- 可扩展的工具执行系统

### 2. LLM客户端 (js/llm_client.js)
- 集成DeepSeek API
- 支持多种模型选择
- 错误处理和重试机制

### 3. 表单填写智能体 (js/form_agent.js)
- 智能分析表单字段
- 上下文感知的填写策略
- 支持多种字段类型

### 4. 工具系统 (js/tools.js, js/tool_executor.js)
- 学术搜索工具
- 网页搜索工具
- 页面内容提取工具
- 表单填写工具

### 5. 浏览器交互 (js/browser_controller.js, content_script.js)
- 与目标网页DOM交互
- 跨域内容提取
- 表单自动填写

## 通信架构

### 扩展组件间通信
```
侧边栏 (sidebar.js) ↔ 背景脚本 (background.js) ↔ 内容脚本 (content_script.js) ↔ 目标网页
```

- 使用Chrome Extension Messaging System进行组件间通信
- 支持异步消息传递
- 具备错误处理机制

## UI界面功能

### 侧边栏界面 (sidebar.html)
- AI设置面板
- 表单URL输入
- 字段处理进度显示
- AI推荐与手动输入选项
- 填表统计信息

### 交互流程
1. 用户输入表单URL或使用当前页面
2. 解析表单结构，提取所有字段
3. 对每个字段执行AI思考-工具调用-填写循环
4. 用户可以选择AI推荐或手动输入
5. 实时显示填写进度和统计

## 配置要求

### manifest.json 权限
- activeTab: 访问当前标签页
- storage: 本地数据存储
- sidePanel: 侧边栏功能
- scripting: 内容脚本注入
- tabs: 标签页管理
- host_permissions: API和网站访问权限

### API配置
- 需要配置DeepSeek API密钥
- 支持多种模型选择
- 可调节温度参数

## 扩展性设计

### 工具扩展
- 支持注册新的工具
- 工具描述和参数定义
- 统一的工具执行接口

### 字段类型支持
- 文本输入框
- 选择框
- 单选/复选框
- 日期、邮箱等特殊类型

## 安全特性

- CSP策略保护
- API密钥本地加密存储
- 内容脚本沙箱执行
- 输入验证和过滤

## 部署说明

1. 将整个 `form-filling-assistant` 文件夹加载为开发者模式扩展
2. 在设置面板中配置DeepSeek API密钥
3. 访问需要填写的表单页面
4. 点击扩展图标打开侧边栏开始使用

## 使用场景

- 学术会议投稿表单填写
- 在线申请表格填写
- 数据录入表单自动化
- 重复性表单填写任务
```
