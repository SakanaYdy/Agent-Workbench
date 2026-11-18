"""Package the original Agent loop with a fixed provider and read-only fixtures."""
import ast
import hashlib
import sys
import zipfile
from pathlib import Path


def message_types(source, include_openai_codec=False):
    lines = source.splitlines(keepends=True)
    nodes = ast.parse(source).body
    chunks = [
        "".join(lines[min(symbol.lineno for symbol in [node, *node.decorator_list]) - 1:node.end_lineno])
        for node in nodes if isinstance(node, ast.ClassDef)
        and node.name in {"ToolCall", "ToolResult", "Usage", "AssistantResponse"}
    ]
    if len(chunks) != 4:
        raise ValueError("pi-agent 的消息类型定义与测试适配不匹配")
    if include_openai_codec:
        chunks.extend("".join(lines[node.lineno - 1:node.end_lineno]) for node in nodes
                      if isinstance(node, ast.FunctionDef) and node.name in {"to_openai_messages", "to_openai_tools"})
    return (
        "import json\nfrom dataclasses import dataclass, field\nfrom typing import Any, Protocol\n"
        "\nNeutralMessage = dict[str, Any]\nclass LLMProvider(Protocol):\n    pass\n\n"
        + "\n\n".join(chunks)
    )


def make_package(pi_repo, output, compact=False, bfcl=False):
    original = pi_repo / "src" / "pi_agent"
    entry = Path(__file__).parent / "fixtures" / ("pi_agent_bfcl.py" if bfcl else "pi_agent_entry.py")
    loop = (original / "agent.py").read_bytes()
    config = """from dataclasses import dataclass

@dataclass
class AgentConfig:
    system_prompt: str = "生成可追溯的发布检查清单"
    max_history_messages: int = 2
    max_iterations: int = 3
    max_retries: int = 0
    stream: bool = False
    reflect: bool = False
    auto_approve: bool = False
    guardrails: object = None
"""
    guardrails = """def check_exfiltration(name, args, config):
    if name not in {"get_changes", "read_policy"}:
        return "Blocked by fixture"
    return None

def is_destructive(name, args, config):
    return False

def guard_output(name, result, config):
    return result
"""
    if bfcl:
        config = config.replace('生成可追溯的发布检查清单',
                                'You are a helpful assistant. Use the available tools when the user asks you to interact with the environment.')
        config = config.replace('max_iterations: int = 3', 'max_iterations: int = 10')
        guardrails = guardrails.replace('    if name not in {"get_changes", "read_policy"}:\n        return "Blocked by fixture"\n', '')
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as package:
        script = entry.read_text(encoding="utf-8")
        if compact:
            script = script.replace("COMPACT_TOOL_RESULTS = False", "COMPACT_TOOL_RESULTS = True", 1)
        package.writestr("agent.py", script)
        package.writestr("pi_agent/agent.py", loop)
        package.writestr("pi_agent/__init__.py", "")
        package.writestr("pi_agent/config.py", config)
        package.writestr("pi_agent/guardrails.py", guardrails)
        package.writestr("pi_agent/llm.py", message_types((original / "llm.py").read_text(encoding="utf-8"), bfcl))
        package.writestr("pi_agent/sandbox.py", "class Sandbox:\n    pass\n")
        package.writestr("pi_agent/tools/__init__.py", "")
        package.writestr("pi_agent/tools/registry.py", "class ToolRegistry:\n    pass\n")
        license_file = pi_repo / "LICENSE"
        if license_file.is_file():
            package.write(license_file, "LICENSE.txt")
    print(f"Agent loop SHA-256: {hashlib.sha256(loop).hexdigest()}")


if __name__ == "__main__":
    make_package(Path(sys.argv[1]), Path(sys.argv[2]), "--compact-results" in sys.argv[3:], "--bfcl" in sys.argv[3:])
