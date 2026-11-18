import base64
import contextlib
import importlib.util
import io
import json
import stat
import sys
import tempfile
import time
import zipfile
from pathlib import Path, PurePosixPath
sys.path.insert(0, str(Path(__file__).resolve().parent))
from safety import inspect_project, protect_local_execution
from source_reference import SourceReference

WINDOWS_DEVICES = {"con", "prn", "aux", "nul", "conin$", "conout$"} | {
    prefix + str(index) for prefix in ("com", "lpt") for index in range(1, 10)
}


def estimated_tokens(value):
    raw = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return (len(raw.encode("utf-8")) + 3) // 4


def trace_value(value, limit=12_000):
    payload = json.dumps(value, ensure_ascii=False)
    size = len(payload.encode('utf-8'))
    if size <= limit:
        return value
    return {"preview": payload[:limit // 4], "originalBytes": size, "truncated": True}


class Context:
    def __init__(self, scenario, emit, sources):
        self.scenario = scenario
        self._emit = emit
        self._started = time.monotonic()
        self._count = 0
        self._model_count = 0
        self._benchmark_count = 0
        self._tool_attempts = {}
        self._sources = sources
        self._review_tools = json.loads(json.dumps((scenario.get("reviewPolicy") or {}).get("tools", {})))

    def _audit_tool(self, event_id, name, decision):
        if decision not in {"allow", "deny"}:
            return
        benchmark = bool(self.scenario.get("benchmark"))
        tool = self._review_tools.get(name, {})
        self._emit({"type": "tool-audit", "audit": {
            "eventId": event_id, "decision": decision, "scope": "benchmark" if benchmark else "scenario",
            "effect": tool.get("effect"), "approvalRequired": tool.get("approvalRequired"), "approval": tool.get("approval"),
        }})

    def record(self, kind, name, *, round=1, input=None, output=None, links=(),
               detail=None, usage=None, duration_ms=0, start_ms=None, status="ok", source=None):
        self._count += 1
        if self._count > 499:
            raise RuntimeError("达到上传 Agent 的步骤上限")
        if start_ms is None:
            start_ms = (time.monotonic() - self._started) * 1000
        if self.scenario.get("benchmark"):
            input = trace_value(input, 24_000 if kind == "model" else 12_000)
            output, detail = trace_value(output), trace_value(detail, 4000 if kind == "model" else 8000)
        location = self._sources.capture(sys._getframe(1), source)
        self._emit({"type": "event", "event": {
            "kind": kind, "name": name, "round": round, "input": input,
            "output": output, "links": list(links), "detail": detail, "usage": usage,
            "durationMs": duration_ms, "startMs": start_ms, "status": status, "source": location,
        }})
        return self._count

    def tool(self, name, arguments=None, *, round=1, links=()):
        start = time.monotonic()
        if self.scenario.get("benchmark", {}).get("id") == "bfcl":
            self._benchmark_count += 1
            request_id = self._benchmark_count
            self._emit({"type": "benchmark-tool", "id": request_id,
                        "name": name, "arguments": {} if arguments is None else arguments})
            answer = json.loads(sys.stdin.readline(8_000_000))
            if answer.get("id") != request_id:
                raise RuntimeError("Benchmark 返回了不匹配的请求 ID")
            error = answer.get("error")
            result = {"error": error} if error else answer["reply"]
            trace_result = {**result, "tools": trace_value(result["tools"], 5000)} if name == "next_turn" and isinstance(result, dict) and "tools" in result else result
            is_turn = name == "next_turn" and isinstance(result, dict) and not error
            event_round = result.get("round", max(1, round - 1)) if is_turn else round
            event = self.record("context" if is_turn else "tool", name, round=event_round, links=links,
                                input=arguments, output=trace_result,
                                status="error" if error else "ok",
                                duration_ms=(time.monotonic() - start) * 1000)
            if not is_turn:
                self._audit_tool(event, name, answer.get("decision"))
            return result, event
        fixtures = self.scenario.get("tools", {})
        responses = self.scenario.get("toolResponses", {})
        if "change" in self.scenario:
            fixtures = {
                "get_changes": self.scenario["change"],
                "read_policy": {
                    "policies": self.scenario["policies"], "notes": "历史说明与附件索引。" * 32
                },
                "lookup_owner": {"owner": self.scenario["owner"]},
            }
        if name in responses:
            attempt = self._tool_attempts.get(name, 0)
            sequence = responses[name]
            result = sequence[min(attempt, len(sequence) - 1)]
            self._tool_attempts[name] = attempt + 1
        elif name in fixtures:
            result = fixtures[name]
        else:
            event_id = self.record("tool", name, round=round, input=arguments, links=links,
                                   status="error", output={"error": "场景不提供此工具"})
            self._audit_tool(event_id, name, "deny")
            raise ValueError(f"场景不提供工具 {name}")
        event_id = self.record("tool", name, round=round, input=arguments, links=links,
                               output=result, duration_ms=(time.monotonic() - start) * 1000,
                               start_ms=(start - self._started) * 1000)
        self._audit_tool(event_id, name, "allow")
        return result, event_id

    def live_model(self, name, messages, *, tools=None, round=1, links=()):
        start = time.monotonic()
        self._model_count += 1
        request_id = self._model_count
        self._emit({"type": "model-request", "id": request_id,
                    "messages": messages, "tools": tools})
        answer = json.loads(sys.stdin.readline(140_000))
        if answer.get("id") != request_id:
            raise RuntimeError("模型网关返回了不匹配的请求 ID")
        inputs = {"messages": messages, "tools": tools}
        if self.scenario.get("benchmark"):
            inputs = {"messages": trace_value(messages), "tools": trace_value(tools, 6000)}
        timing = {
            "duration_ms": (time.monotonic() - start) * 1000,
            "start_ms": (start - self._started) * 1000,
        }
        if answer.get("error"):
            self.record("model", name, round=round, input=inputs, links=links,
                        output={"error": answer["error"]}, status="error", **timing)
            raise RuntimeError(answer["error"])
        reply = answer["reply"]
        event_id = self.record(
            "model", name, round=round, input=inputs, output=reply, links=links,
            usage=reply.get("usage"), **timing
        )
        return reply["message"], event_id

    def tokens(self, value):
        return estimated_tokens(value)

    def model(self, name, messages, response, *, round=1, links=()):
        start = time.monotonic()
        result = response() if callable(response) else response
        event_id = self.record(
            "model", name, round=round, input={"messages": messages}, output=result, links=links,
            duration_ms=(time.monotonic() - start) * 1000,
            start_ms=(start - self._started) * 1000,
            usage={"inputTokens": self.tokens(messages), "outputTokens": self.tokens(result), "estimated": True}
        )
        return result, event_id


def extract_agent(filename, archive, folder):
    if filename.lower().endswith(".py"):
        (folder / "agent.py").write_bytes(archive)
        return
    seen = set()
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        entries = bundle.infolist()
        if len(entries) > 100 or sum(entry.file_size for entry in entries) > 3_000_000:
            raise ValueError("ZIP 展开后超过尺寸或文件数上限")
        for entry in entries:
            name = entry.filename
            item = PurePosixPath(name)
            if (item.is_absolute() or not item.parts or "\\" in name or ":" in name or len(name) > 220
                    or any(part == ".." or part != part.rstrip(" .")
                           or part.split(".")[0].lower() in WINDOWS_DEVICES for part in item.parts)):
                raise ValueError("ZIP 包含无效路径")
            normalized = item.as_posix().casefold()
            if stat.S_ISLNK(entry.external_attr >> 16) or normalized in seen:
                raise ValueError("ZIP 包含链接或重复路径")
            seen.add(normalized)
            dest = folder.joinpath(*item.parts)
            if entry.is_dir():
                dest.mkdir(parents=True, exist_ok=True)
            else:
                if dest.suffix.lower() not in {".py", ".json", ".txt", ".md", ".csv"}:
                    raise ValueError(f"ZIP 包含该执行策略无法处理的文件：{name}")
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(bundle.read(entry))


def load_project(folder):
    entry = folder / "agent.py"
    if not entry.is_file():
        raise ValueError("ZIP 根目录必须包含 agent.py")
    sys.path.insert(0, str(folder))
    spec = importlib.util.spec_from_file_location("uploaded_agent", entry)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    entrypoint = getattr(module, "run", None)
    if not callable(entrypoint):
        raise ValueError("agent.py 必须提供 run(task, ctx)")
    return entrypoint


def main():
    protocol = sys.stdout

    def emit(value):
        payload = json.dumps(value, ensure_ascii=False, allow_nan=False)
        limit = 18_100_000 if value.get('type') == 'original-source' else (
            2_800_000 if benchmark and value.get('type') == 'model-request' else 45_000)
        if len(payload.encode("utf-8")) > limit:
            raise ValueError("单步骤数据超过上限")
        print(payload, file=protocol, flush=True)

    try:
        benchmark = False
        mode = sys.argv[1]
        envelope = json.loads(sys.stdin.readline(750_000))
        archive = base64.b64decode(envelope["packageBase64"], validate=True)
        scenario = envelope.get("scenario")
        benchmark = bool(scenario and scenario.get("benchmark"))
        with tempfile.TemporaryDirectory() as workspace:
            root = Path(workspace)
            if mode == "source":
                file = PurePosixPath(envelope["sourceFile"])
                if file.is_absolute() or ".." in file.parts or file.suffix.lower() != ".py" or file.as_posix() != envelope["sourceFile"] or "\\" in envelope["sourceFile"]:
                    raise ValueError("源码路径无效")
                extract_agent(envelope["filename"], archive, root)
                code = root.joinpath(*file.parts).read_bytes().decode("utf-8-sig")
                emit({"type": "original-source", "code": code})
                return 0
            try:
                extract_agent(envelope["filename"], archive, root)
                report = inspect_project(root)
            except (OSError, ValueError, RuntimeError, zipfile.BadZipFile) as error:
                report = {"approved": False, "files": [], "findings": [
                    {"file": envelope["filename"], "line": None, "rule": "archive", "message": str(error)[:300]}
                ]}
            if mode == "preflight":
                emit({"type": "preflight", "report": report})
                return 0
            if not report["approved"]:
                raise ValueError("执行前安全预检未通过")
            stop_guard = protect_local_execution(root)
            try:
                with contextlib.redirect_stdout(sys.stderr):
                    entrypoint = load_project(root)
                    result = entrypoint(scenario["task"], Context(scenario, emit, SourceReference(root, report["files"], emit)))
            finally:
                stop_guard()
            if not isinstance(result, dict):
                raise ValueError("run(task, ctx) 必须返回 JSON 对象")
            emit({"type": "result", "output": result})
    except Exception as error:
        emit({"type": "error", "message": str(error)[:500]})
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
