export const officialBenchmarks = [
  {
    id: 'bfcl', name: 'Berkeley Function Calling Leaderboard（BFCL）', category: '工具调用', venue: 'ICML 2025',
    scope: '选择正确函数和参数，涵盖并行调用、无法调用时的判断及有状态多轮交互。',
    scoring: '按子集使用结构匹配、执行检查和多轮状态检查。',
    environment: '多轮子集使用作者提供的模拟函数及初始状态。',
    paper: 'https://proceedings.mlr.press/v267/patil25a.html',
    resources: [
      { label: 'BFCL v3 原始多轮任务', url: 'https://huggingface.co/datasets/gorilla-llm/Berkeley-Function-Calling-Leaderboard/blob/main/BFCL_v3_multi_turn_base.json' },
      { label: '官方数据及参考答案', url: 'https://huggingface.co/datasets/gorilla-llm/Berkeley-Function-Calling-Leaderboard/tree/main' },
      { label: '官方评分器', url: 'https://github.com/ShishirPatil/gorilla/tree/main/berkeley-function-call-leaderboard' }
    ]
  },
  {
    id: 'toolbench', name: 'ToolBench（ToolLLM）', category: '工具调用', venue: 'ICLR 2024',
    scope: '围绕真实 API 设计原始指令、工具定义与工具调用任务，用于评估多 API 工具使用。',
    scoring: 'ToolEval 提供任务通过率与相对胜率。',
    environment: '原始流程依赖 API 环境；作者仓库同时提供复现数据入口。',
    paper: 'https://proceedings.iclr.cc/paper_files/paper/2024/file/28e50ee5b72e90b50e7196fde8ea260e-Paper-Conference.pdf',
    resources: [
      { label: '原始数据发布', url: 'https://github.com/OpenBMB/ToolBench#data-release' },
      { label: '作者仓库与 ToolEval', url: 'https://github.com/OpenBMB/ToolBench' }
    ]
  },
  {
    id: 'stabletoolbench', name: 'StableToolBench', category: '工具调用', venue: 'Findings of ACL 2024',
    scope: '用缓存和 API 响应模拟减少工具环境漂移，是 ToolBench 的独立发表版本。',
    scoring: '使用论文和仓库指定的可解样本与 ToolEval 流程。',
    environment: '按官方说明准备缓存、模拟服务和对应评测数据。',
    paper: 'https://aclanthology.org/2024.findings-acl.664/',
    resources: [{ label: '原始任务、缓存及评分代码', url: 'https://github.com/THUNLP-MT/StableToolBench' }]
  },
  {
    id: 'tau-bench', name: 'τ-bench', category: '多轮工作流', venue: 'ICLR 2025',
    scope: '零售和航空领域的多轮客服任务，结合模拟用户、业务策略和工具 API。',
    scoring: '检查任务结束时的目标状态；pass^k 衡量多次尝试全部成功的能力。',
    environment: '需要原版领域环境及用户模拟器。',
    paper: 'https://proceedings.iclr.cc/paper_files/paper/2025/hash/1b126cc38b8638e07bef37e7b2bb72bf-Abstract-Conference.html',
    resources: [
      { label: '原始领域和任务', url: 'https://github.com/sierra-research/tau-bench/tree/main/tau_bench/envs' },
      { label: '官方评测实现', url: 'https://github.com/sierra-research/tau-bench' }
    ]
  },
  {
    id: 'tau2-bench', name: 'τ²-bench', category: '多轮工作流', venue: 'ICML 2026',
    scope: '在共享环境中考查 Agent 与用户的协调；Telecom 场景中双方都能使用工具。',
    scoring: '通过任务的目标状态和相应约束评分。',
    environment: '需要官方状态化模拟器，Telecom 案例还包含用户侧操作。',
    paper: 'https://proceedings.mlr.press/v306/barres26a.html',
    resources: [
      { label: '原始领域任务目录', url: 'https://github.com/sierra-research/tau2-bench/tree/main/data/tau2/domains' },
      { label: 'Retail 原始 tasks.json', url: 'https://github.com/sierra-research/tau2-bench/blob/main/data/tau2/domains/retail/tasks.json' },
      { label: '官方运行器及评分', url: 'https://github.com/sierra-research/tau2-bench' }
    ]
  },
  {
    id: 'agentbench', name: 'AgentBench', category: '多轮工作流', venue: 'ICLR 2024',
    scope: '在多类交互环境评估长期推理、决策与指令遵循。',
    scoring: '按官方各环境的任务指标和汇总协议计算。',
    environment: '每种环境有各自的运行依赖和任务配置。',
    paper: 'https://proceedings.iclr.cc/paper_files/paper/2024/hash/e9df36b21ff4ee211a8b71ee8b7e9f57-Abstract-Conference.html',
    resources: [{ label: '原始任务环境与评分代码', url: 'https://github.com/THUDM/AgentBench' }]
  },
  {
    id: 'agentboard', name: 'AgentBoard', category: '多轮工作流', venue: 'NeurIPS 2024 · Datasets and Benchmarks',
    scope: '涵盖工具、网页、游戏和具身任务，并对中间子目标进行标注。',
    scoring: '成功率与进度率，另外提供 grounding accuracy 等分析维度。',
    environment: '各环境分别运行；作者要求使用完整下载数据。',
    paper: 'https://proceedings.nips.cc/paper_files/paper/2024/hash/877b40688e330a0e2a3fc24084208dfa-Abstract-Datasets_and_Benchmarks_Track.html',
    resources: [
      { label: '作者发布的原始数据包', url: 'https://huggingface.co/datasets/hkust-nlp/agentboard/tree/main' },
      { label: '官方运行器与数据说明', url: 'https://github.com/hkust-nlp/AgentBoard' }
    ]
  },
  {
    id: 'gaia', name: 'GAIA', category: '通用助理', venue: 'ICLR 2024',
    scope: '真实问题需要推理、网页检索、文件或多模态处理，以及工具协作。',
    scoring: '以各级别的最终答案正确率评估。',
    environment: '官方任务集需同意访问条款；测试答案由官方保留，验证集可用于本地实验。',
    paper: 'https://proceedings.iclr.cc/paper_files/paper/2024/hash/25ae35b5b1738d80f1f03a8713e405ec-Abstract-Conference.html',
    resources: [
      { label: '官方任务与访问条款', url: 'https://huggingface.co/datasets/gaia-benchmark/GAIA' },
      { label: '官方榜单与提交', url: 'https://huggingface.co/spaces/gaia-benchmark/leaderboard' }
    ]
  },
  {
    id: 'webarena', name: 'WebArena', category: '网页与桌面', venue: 'ICLR 2024',
    scope: '在可复现网站上完成导航、查询和网站内操作。',
    scoring: '任务级检查验证所需页面状态、内容或目标结果。',
    environment: '浏览器与作者提供的网站环境。',
    paper: 'https://proceedings.iclr.cc/paper_files/paper/2024/file/4410c0711e9154a7a2d26f9b3816d1ef-Paper-Conference.pdf',
    resources: [
      { label: '原始任务 test.raw.json', url: 'https://github.com/web-arena-x/webarena/blob/main/config_files/test.raw.json' },
      { label: '官方评测实现', url: 'https://github.com/web-arena-x/webarena/tree/main/evaluation_harness' }
    ]
  },
  {
    id: 'osworld', name: 'OSWorld', category: '网页与桌面', venue: 'NeurIPS 2024 · Datasets and Benchmarks',
    scope: '在真实桌面应用中按界面和多模态反馈完成任务。',
    scoring: '用任务专用评估器检查文件、应用状态或操作结果。',
    environment: '需要官方配置的桌面环境及截图、键盘和鼠标能力。',
    paper: 'https://proceedings.neurips.cc/paper_files/paper/2024/hash/5d413e48f84dc61244b6be550f1cd8f5-Abstract-Datasets_and_Benchmarks_Track.html',
    resources: [
      { label: '官方任务索引 test_all.json', url: 'https://github.com/xlang-ai/OSWorld/blob/main/evaluation_examples/test_all.json' },
      { label: '任务专用评分器', url: 'https://github.com/xlang-ai/OSWorld/tree/main/desktop_env/evaluators' }
    ]
  },
  {
    id: 'swe-bench', name: 'SWE-bench', category: '软件工程', venue: 'ICLR 2024',
    scope: '由真实 GitHub Issue 和仓库快照构成的缺陷修复任务。',
    scoring: '在官方测试环境中应用补丁，验证修复测试与既有测试。',
    environment: '依赖各仓库的可复现测试环境；Verified 是另行发布的子集。',
    paper: 'https://proceedings.iclr.cc/paper_files/paper/2024/file/edac78c3e300629acfe6cbe9ca88fb84-Paper-Conference.pdf',
    resources: [
      { label: '原版任务数据', url: 'https://huggingface.co/datasets/SWE-bench/SWE-bench' },
      { label: 'Verified 官方子集', url: 'https://huggingface.co/datasets/SWE-bench/SWE-bench_Verified' },
      { label: '官方评测实现', url: 'https://github.com/SWE-bench/SWE-bench' }
    ]
  },
  {
    id: 'memory-agent-bench', name: 'MemoryAgentBench', category: '上下文与记忆', venue: 'ICLR 2026',
    scope: '将材料分多轮输入，测试准确检索、测试时学习、长程理解和选择性遗忘。',
    scoring: '按原版不同记忆子任务的评分协议计算。',
    environment: '用官方顺序逐段输入数据，保留该次运行的 Agent 记忆状态。',
    paper: 'https://proceedings.iclr.cc/paper_files/paper/2026/hash/fd1eff9dd295df50a41f2521942fa31d-Abstract.html',
    resources: [
      { label: '官方任务数据', url: 'https://huggingface.co/datasets/ai-hyz/MemoryAgentBench' },
      { label: '官方评测实现', url: 'https://github.com/HUST-AI-HYZ/MemoryAgentBench' }
    ]
  },
  {
    id: 'longmemeval', name: 'LongMemEval', category: '上下文与记忆', venue: 'ICLR 2025',
    scope: '基于跨会话聊天历史，检查信息提取、时间推理、新旧事实更新、多会话理解和合理弃答。',
    scoring: '用作者评价协议检查答案和弃答行为。',
    environment: '导入作者发布的会话历史与问题，分别记录检索和回答。',
    paper: 'https://proceedings.iclr.cc/paper_files/paper/2025/file/d813d324dbf0598bbdc9c8e79740ed01-Paper-Conference.pdf',
    resources: [
      { label: '官方任务及会话历史', url: 'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned' },
      { label: '官方评测实现', url: 'https://github.com/xiaowu0162/LongMemEval' }
    ]
  },
  {
    id: 'agentdojo', name: 'AgentDojo', category: '安全', venue: 'NeurIPS 2024 · Datasets and Benchmarks',
    scope: '在模拟业务工具中同时测量合法任务的效用和处理不可信工具数据时的安全性。',
    scoring: '分别检查用户任务成功与安全约束，保留正常场景作为对照。',
    environment: '使用作者提供的模拟工具环境和指定版本的任务套件。',
    paper: 'https://proceedings.neurips.cc/paper_files/paper/2024/hash/97091a5177d8dc64b1da8bf3e1f6fb54-Abstract-Datasets_and_Benchmarks_Track.html',
    resources: [
      { label: '官方任务套件与评分环境', url: 'https://github.com/ethz-spylab/agentdojo' }
    ]
  },
  {
    id: 'agentharm', name: 'AgentHarm', category: '安全', venue: 'ICLR 2025',
    scope: '针对具备工具调用能力的 Agent 测试不安全任务完成情况，也提供正常需求对照。',
    scoring: '使用作者发布的任务级评分规则和公开划分。',
    environment: '使用原版模拟工具以及对应评测器。',
    paper: 'https://proceedings.iclr.cc/paper_files/paper/2025/hash/c493d23af93118975cdbc32cbe7323f5-Abstract-Conference.html',
    resources: [
      { label: '官方数据集与划分', url: 'https://huggingface.co/datasets/ai-safety-institute/AgentHarm' },
      { label: '作者评测实现', url: 'https://github.com/epfl-nlp/helpful-to-a-fault/tree/main/agentharm' }
    ]
  }
];
