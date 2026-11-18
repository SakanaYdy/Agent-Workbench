# 已发表的 Agent Benchmark

下表整理原版 Benchmark 的发表出处、实际任务和作者发布的评测入口。任务数据、环境与评分规则共同决定可比的评测结果。记录结果时应保留 Benchmark 版本、任务 ID、数据划分和评分器版本。

## 工具调用与多轮工作流

| Benchmark | 正式发表 | 原始任务入口 | 官方评测 |
|---|---|---|---|
| BFCL | [ICML 2025](https://proceedings.mlr.press/v267/patil25a.html) | [作者数据目录](https://huggingface.co/datasets/gorilla-llm/Berkeley-Function-Calling-Leaderboard/tree/main)，包括 [v3 multi-turn base 原始文件](https://huggingface.co/datasets/gorilla-llm/Berkeley-Function-Calling-Leaderboard/blob/main/BFCL_v3_multi_turn_base.json) | [官方评分器](https://github.com/ShishirPatil/gorilla/tree/main/berkeley-function-call-leaderboard)。按各子集检查函数、参数、执行结果或多轮状态。 |
| ToolBench（ToolLLM） | [ICLR 2024](https://proceedings.iclr.cc/paper_files/paper/2024/file/28e50ee5b72e90b50e7196fde8ea260e-Paper-Conference.pdf) | [数据发布](https://github.com/OpenBMB/ToolBench#data-release) | [ToolEval 与作者复现说明](https://github.com/OpenBMB/ToolBench)。按原版工具任务比较通过率与胜率。 |
| StableToolBench | [Findings of ACL 2024](https://aclanthology.org/2024.findings-acl.664/) | [原始数据与缓存](https://github.com/THUNLP-MT/StableToolBench) | [官方模拟与评测](https://github.com/THUNLP-MT/StableToolBench)。采用缓存与模拟服务，按作者定义的可解样本和 ToolEval 协议评估。 |
| τ-bench | [ICLR 2025](https://proceedings.iclr.cc/paper_files/paper/2025/hash/1b126cc38b8638e07bef37e7b2bb72bf-Abstract-Conference.html) | [Retail 和 Airline 原始任务环境](https://github.com/sierra-research/tau-bench/tree/main/tau_bench/envs) | [作者评分实现](https://github.com/sierra-research/tau-bench)。对照最终业务状态与策略，用 `pass^k` 衡量多次试验的可靠性。 |
| τ²-bench | [ICML 2026](https://proceedings.mlr.press/v306/barres26a.html) | [官方领域目录](https://github.com/sierra-research/tau2-bench/tree/main/data/tau2/domains)及 [Retail tasks.json](https://github.com/sierra-research/tau2-bench/blob/main/data/tau2/domains/retail/tasks.json) | [官方运行器](https://github.com/sierra-research/tau2-bench)。检查目标状态和约束，Telecom 场景包括用户与 Agent 两侧的操作。 |
| AgentBench | [ICLR 2024](https://proceedings.iclr.cc/paper_files/paper/2024/hash/e9df36b21ff4ee211a8b71ee8b7e9f57-Abstract-Conference.html) | [原始任务、环境及配置](https://github.com/THUDM/AgentBench) | [官方评测包](https://github.com/THUDM/AgentBench)。按各交互环境的任务指标与汇总协议评分。 |
| AgentBoard | [NeurIPS 2024 · Datasets and Benchmarks](https://proceedings.nips.cc/paper_files/paper/2024/hash/877b40688e330a0e2a3fc24084208dfa-Abstract-Datasets_and_Benchmarks_Track.html) | [完整评测任务压缩包入口](https://huggingface.co/datasets/hkust-nlp/agentboard/tree/main) | [官方运行器与数据目录说明](https://github.com/hkust-nlp/AgentBoard)。报告中间进度率和最终成功率，可用于对照调用链的中间子目标。 |

## 通用助理、网页、桌面与代码

| Benchmark | 正式发表 | 原始任务入口 | 官方评测 |
|---|---|---|---|
| GAIA | [ICLR 2024](https://proceedings.iclr.cc/paper_files/paper/2024/hash/25ae35b5b1738d80f1f03a8713e405ec-Abstract-Conference.html) | [官方数据及访问条款](https://huggingface.co/datasets/gaia-benchmark/GAIA) | [官方榜单与提交](https://huggingface.co/spaces/gaia-benchmark/leaderboard)。评估通用工具助理的最终答案，测试答案由官方保留。 |
| WebArena | [ICLR 2024](https://proceedings.iclr.cc/paper_files/paper/2024/file/4410c0711e9154a7a2d26f9b3816d1ef-Paper-Conference.pdf) | [原始 test.raw.json](https://github.com/web-arena-x/webarena/blob/main/config_files/test.raw.json) | [官方 evaluation_harness](https://github.com/web-arena-x/webarena/tree/main/evaluation_harness)。依赖浏览器和可复现网站，检查网页操作结果。 |
| OSWorld | [NeurIPS 2024 · Datasets and Benchmarks](https://proceedings.neurips.cc/paper_files/paper/2024/hash/5d413e48f84dc61244b6be550f1cd8f5-Abstract-Datasets_and_Benchmarks_Track.html) | [官方 test_all.json](https://github.com/xlang-ai/OSWorld/blob/main/evaluation_examples/test_all.json) | [任务专用评估器](https://github.com/xlang-ai/OSWorld/tree/main/desktop_env/evaluators)。需要桌面环境，按任务验证电脑操作结果。 |
| SWE-bench | [ICLR 2024](https://proceedings.iclr.cc/paper_files/paper/2024/file/edac78c3e300629acfe6cbe9ca88fb84-Paper-Conference.pdf) | [原版任务](https://huggingface.co/datasets/SWE-bench/SWE-bench)及 [Verified 官方子集](https://huggingface.co/datasets/SWE-bench/SWE-bench_Verified) | [官方运行器](https://github.com/SWE-bench/SWE-bench)。在仓库测试环境中应用补丁并运行测试。 |

## 上下文、记忆与安全

| Benchmark | 正式发表 | 原始任务入口 | 官方评测 |
|---|---|---|---|
| MemoryAgentBench | [ICLR 2026](https://proceedings.iclr.cc/paper_files/paper/2026/hash/fd1eff9dd295df50a41f2521942fa31d-Abstract.html) | [官方任务数据](https://huggingface.co/datasets/ai-hyz/MemoryAgentBench) | [作者评测实现](https://github.com/HUST-AI-HYZ/MemoryAgentBench)。按顺序输入多轮数据，评估检索、更新、理解和遗忘相关能力。 |
| LongMemEval | [ICLR 2025](https://proceedings.iclr.cc/paper_files/paper/2025/file/d813d324dbf0598bbdc9c8e79740ed01-Paper-Conference.pdf) | [官方问题及跨会话历史](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned) | [作者评测实现](https://github.com/xiaowu0162/LongMemEval)。核对历史信息提取、时序、新事实更新和合理弃答。 |
| AgentDojo | [NeurIPS 2024 · Datasets and Benchmarks](https://proceedings.neurips.cc/paper_files/paper/2024/hash/97091a5177d8dc64b1da8bf3e1f6fb54-Abstract-Datasets_and_Benchmarks_Track.html) | [官方任务套件](https://github.com/ethz-spylab/agentdojo) | [官方模拟工具与评分器](https://github.com/ethz-spylab/agentdojo)。同时检查正常任务完成和安全约束。 |
| AgentHarm | [ICLR 2025](https://proceedings.iclr.cc/paper_files/paper/2025/hash/c493d23af93118975cdbc32cbe7323f5-Abstract-Conference.html) | [作者数据及划分](https://huggingface.co/datasets/ai-safety-institute/AgentHarm) | [作者评分实现](https://github.com/epfl-nlp/helpful-to-a-fault/tree/main/agentharm)。使用其模拟工具、任务级判定和公开数据划分。 |

## 对应工作台关注点

- 工具调用与多轮状态可从 **BFCL v3 multi-turn** 的原始任务与对应状态化评分器开始核对。
- 上下文压缩和记忆优化可用 **MemoryAgentBench** 的原版输入顺序与任务，关联工作台记录的记忆更新、压缩事件和最终成绩。
- 业务约束与安全可参考 **τ-bench / τ²-bench** 的状态验证和 **AgentDojo** 的任务效用与安全信号。
- 工作台的「官方 Benchmark」提供检索和原始资料入口。「本地需求」管理当前执行器使用的回归场景，运行记录标示其需求版本。原版 Benchmark 的成绩由相应的官方评测协议产生。
