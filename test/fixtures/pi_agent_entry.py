import json
import time
from dataclasses import asdict

from pi_agent.agent import Agent
from pi_agent.config import AgentConfig
from pi_agent.llm import AssistantResponse, ToolCall
from pi_agent.sandbox import Sandbox

COMPACT_TOOL_RESULTS = False


def snapshot(messages):
    items = []
    for message in messages:
        item = dict(message)
        if "tool_calls" in item:
            item["tool_calls"] = [asdict(call) for call in item["tool_calls"]]
        if "results" in item:
            item["results"] = [asdict(result) for result in item["results"]]
        items.append(item)
    return items


def run(task, ctx):
    events = {"round": 1, "model": None, "context": None, "calls": {}, "results": {}, "callbacks": []}

    class ObservedAgent(Agent):
        def _history_for_request(self):
            started = time.monotonic()
            before = snapshot(self.messages)
            kept = super()._history_for_request()
            after = snapshot(kept)
            cap = self.config.max_history_messages
            links = events["callbacks"] or ([events["model"]] if events["model"] else [])
            is_trim = cap > 0 and len(before) > cap
            events["context"] = ctx.record(
                "compression" if is_trim else "context",
                "按用户轮次裁剪历史" if is_trim else "组装原始消息",
                round=events["round"], input={"messages": before}, output={"messages": after},
                links=links, duration_ms=(time.monotonic() - started) * 1000,
                detail={
                    "strategy": "max_history_messages · 回到用户消息边界",
                    "messageLimit": cap, "beforeMessages": len(before), "afterMessages": len(after),
                    "beforeTokens": ctx.tokens(before), "afterTokens": ctx.tokens(after),
                },
            )
            return kept

    class ScenarioTools:
        names = ("get_changes", "read_policy")

        def schemas(self):
            return [{"name": name, "description": name, "input_schema": {"type": "object"}} for name in self.names]

        def get(self, name):
            return None

        def run(self, name, args, sandbox):
            if name not in self.names:
                raise ValueError("工具不在固定场景中")
            result, step = ctx.tool(name, args, round=events["round"], links=[events["calls"][name]])
            if COMPACT_TOOL_RESULTS and name == "read_policy":
                projected = {"policies": result["policies"]}
                step = ctx.record(
                    "context", "精简发布规范工具结果", round=events["round"],
                    input=result, output=projected, links=[step],
                    detail={"strategy": "保留 policies，诊断轨迹保留原始返回",
                            "beforeTokens": ctx.tokens(result), "afterTokens": ctx.tokens(projected)},
                )
                result = projected
            events["results"][name] = step
            return json.dumps(result, ensure_ascii=False)

    class ReplayProvider:
        supports_streaming = False

        def complete(self, system, messages, tools):
            captured = snapshot(messages)
            if not any(message["role"] == "tool" for message in captured):
                calls = [ToolCall("changes-1", "get_changes", {}), ToolCall("rules-1", "read_policy", {})]
                payload = {"toolCalls": [asdict(call) for call in calls]}
                _, step = ctx.model("pi-agent 选择固定场景工具", captured, payload,
                                    round=events["round"], links=[events["context"]])
                response = AssistantResponse(text="", tool_calls=calls)
            else:
                results = [result for msg in captured if msg["role"] == "tool" for result in msg["results"]]
                rules = [rule for result in results if result["name"] == "read_policy"
                         for rule in json.loads(result["output"])["policies"] if rule["required"]]
                output = {"summary": "pi-agent 发布检查清单", "checklist": [
                    {"ruleId": rule["id"], "action": rule["text"]} for rule in rules
                ]}
                _, step = ctx.model("pi-agent 根据收到的工具结果生成清单", captured, output,
                                    round=events["round"], links=[events["context"], *events["callbacks"]])
                response = AssistantResponse(text=json.dumps(output, ensure_ascii=False))
            events["model"] = step
            return response

    def receive(kind, payload):
        if kind == "tool_call":
            events["calls"][payload.name] = ctx.record(
                "tool_request", "pi-agent 请求 " + payload.name,
                round=events["round"], input=asdict(payload), links=[events["model"]],
            )
        elif kind == "tool_result":
            call = payload["call"]
            events["callbacks"].append(ctx.record(
                "tool_result", "pi-agent 回传 " + call.name, round=events["round"],
                output={"callId": call.id, "result": payload["output"]},
                links=[events["calls"][call.name], events["results"][call.name]],
            ))
            if len(events["callbacks"]) == len(ScenarioTools.names):
                events["round"] += 1

    agent = ObservedAgent(
        provider=ReplayProvider(), registry=ScenarioTools(), sandbox=Sandbox(),
        config=AgentConfig(max_history_messages=2), on_event=receive,
        messages=[
            {"role": "user", "content": "之前的发布示例"},
            {"role": "assistant", "content": "之前的摘要", "tool_calls": []},
        ],
    )
    result = json.loads(agent.run(task))
    ctx.record("output", "pi-agent 返回最终产出", round=events["round"],
               links=[events["model"]], output=result)
    return result
