import json
from dataclasses import asdict

from pi_agent.agent import Agent
from pi_agent.config import AgentConfig
from pi_agent.llm import AssistantResponse, ToolCall, to_openai_messages, to_openai_tools
from pi_agent.sandbox import Sandbox


def schema_for_model(schema):
    types = {"dict": "object", "list": "array", "tuple": "array", "float": "number", "int": "integer", "bool": "boolean"}
    converted = dict(schema)
    original = schema.get("type")
    if isinstance(original, str):
        normalized = types.get(original, original)
        if normalized in {"string", "object", "array", "number", "integer", "boolean", "null"}:
            converted["type"] = normalized
        else:
            converted.pop("type")
    if "properties" in schema:
        converted["properties"] = {key: schema_for_model(value) for key, value in schema["properties"].items()}
    if isinstance(schema.get("items"), dict):
        converted["items"] = schema_for_model(schema["items"])
    return converted


def run(task, ctx):
    round_number = 1
    previous = None
    context = None
    model = None
    request = None
    actual = None
    incoming = None
    answers = []

    class ObservedAgent(Agent):
        def _history_for_request(self):
            nonlocal context
            before = to_openai_messages(self.config.system_prompt, self.messages)[1:]
            kept = super()._history_for_request()
            after = to_openai_messages(self.config.system_prompt, kept)[1:]
            cap = self.config.max_history_messages
            trimmed = cap > 0 and len(self.messages) > cap
            context = ctx.record("compression" if trimmed else "context", "裁剪历史消息" if trimmed else "组装历史消息",
                                 round=round_number, links=[incoming, previous], source=Agent._history_for_request,
                                 input={"messages": before}, output={"messages": after},
                                 detail={"strategy": "保留最近完整用户轮次", "messageLimit": cap,
                                         "beforeMessages": len(self.messages), "afterMessages": len(kept),
                                         "beforeTokens": ctx.tokens(before), "afterTokens": ctx.tokens(after),
                                         "droppedToolResults": sum(msg["role"] == "tool" for msg in before) -
                                                                sum(msg["role"] == "tool" for msg in after)})
            return kept

    class ScenarioTools:
        current = []

        def schemas(self):
            return [{"name": tool["name"], "description": tool["description"],
                     "input_schema": schema_for_model(tool["parameters"])} for tool in self.current]

        def get(self, name):
            return None

        def run(self, name, args, sandbox):
            nonlocal actual
            output, actual = ctx.tool(name, args, round=round_number, links=[request])
            return output if isinstance(output, str) else json.dumps(output, ensure_ascii=False)

    class Provider:
        supports_streaming = False

        def complete(self, system, messages, tools):
            nonlocal model, previous
            reply, model = ctx.live_model("pi-agent 调用 DeepSeek", to_openai_messages(system, messages),
                                          tools=to_openai_tools(tools), round=round_number, links=[context])
            calls = [ToolCall(call["id"], call["function"]["name"], json.loads(call["function"]["arguments"]))
                     for call in reply.get("tool_calls", []) or []]
            previous = model
            return AssistantResponse(text=reply.get("content") or "", tool_calls=calls)

    def receive(kind, payload):
        nonlocal request, previous
        if kind == "tool_call":
            request = ctx.record("tool_request", "pi-agent 请求 " + payload.name, round=round_number,
                                 input=asdict(payload), links=[model])
        elif kind == "tool_result":
            call = payload["call"]
            previous = ctx.record("tool_result", "pi-agent 回传 " + call.name, round=round_number,
                                  output={"callId": call.id, "result": payload["output"]}, links=[request, actual])

    tools = ScenarioTools()
    agent = ObservedAgent(provider=Provider(), registry=tools, sandbox=Sandbox(),
                          config=AgentConfig(max_history_messages=2), on_event=receive)
    while True:
        turn, incoming = ctx.tool("next_turn", round=round_number, links=[previous])
        if "error" in turn:
            raise RuntimeError(turn["error"])
        if turn.get("done"):
            break
        tools.current = turn["tools"]
        user_input = "\n".join(message["content"] for message in turn["messages"] if message["role"] == "user")
        answer = agent.run(user_input)
        answers.append(answer)
        previous = ctx.record("state", "本轮产出", round=round_number, output=answer, links=[previous])
        round_number += 1

    result = {"answers": answers}
    ctx.record("output", "pi-agent 返回最终产出", round=max(1, round_number - 1), output=result, links=[previous])
    return result
