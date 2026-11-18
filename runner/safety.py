import ast
import importlib
import os
import sys
from pathlib import Path


SAFE_MODULES = {
    "__future__", "collections", "dataclasses", "datetime", "decimal", "enum",
    "functools", "hashlib", "itertools", "json", "math", "random", "re",
    "statistics", "string", "textwrap", "time", "typing",
}
BLOCKED_MODULES = {
    "asyncio", "builtins", "ctypes", "glob", "http", "importlib", "marshal",
    "multiprocessing", "os", "pathlib", "pickle", "requests", "shutil", "socket",
    "subprocess", "sys", "tempfile", "threading", "urllib", "winreg",
}
BLOCKED_NAMES = {
    "open", "exec", "eval", "compile", "breakpoint", "input", "vars", "globals",
    "locals", "setattr", "delattr", "getattr", "help", "format_map", "get_type_hints",
}
PACKAGE_METADATA = {"__version__", "__all__"}


def inspect_project(root):
    packages = {item.stem for item in root.glob("*.py")}
    packages.update(item.name for item in root.iterdir() if item.is_dir())
    report = {"approved": False, "files": [], "findings": []}
    has_entry = False

    def finding(path, line, rule, message):
        if len(report["findings"]) < 60:
            report["findings"].append({"file": path, "line": line, "rule": rule, "message": message})

    for path in sorted(root.rglob("*.py")):
        relative = path.relative_to(root).as_posix()
        report["files"].append(relative)
        try:
            tree = ast.parse(path.read_text(encoding="utf-8-sig"), filename=relative)
        except (SyntaxError, UnicodeError, RecursionError) as exc:
            finding(relative, getattr(exc, "lineno", None), "syntax", "Python 源码无法解析")
            continue
        if relative == "agent.py":
            has_entry = any(
                isinstance(node, ast.FunctionDef) and node.name == "run"
                and [argument.arg for argument in (node.args.posonlyargs + node.args.args)][:2] == ["task", "ctx"]
                and len(node.args.posonlyargs + node.args.args) == 2
                and not node.args.kwonlyargs
                for node in tree.body
            )
        nodes = list(ast.walk(tree))
        static_member_reads = {
            id(node.func) for node in nodes if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name) and node.func.id == "getattr"
            and len(node.args) in (2, 3) and isinstance(node.args[1], ast.Constant)
            and isinstance(node.args[1].value, str) and not node.args[1].value.startswith("_")
            and node.args[1].value not in BLOCKED_NAMES
        }
        for node in nodes:
            if isinstance(node, ast.Import):
                imported = [alias.name.split(".")[0] for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                imported = [node.module.split(".")[0]] if node.module and not node.level else []
                if any(alias.name == "*" or alias.name in BLOCKED_NAMES or
                       (alias.name.startswith("__") and alias.name not in PACKAGE_METADATA)
                       for alias in node.names):
                    finding(relative, node.lineno, "import", "使用显式、受支持的导入名称")
            else:
                imported = []
            for module in imported:
                if module in BLOCKED_MODULES or module not in SAFE_MODULES | packages:
                    finding(relative, node.lineno, "import", f"本地执行策略不允许导入 {module}")
            if isinstance(node, ast.Name) and id(node) not in static_member_reads and (
                node.id in BLOCKED_NAMES or (node.id.startswith("__") and node.id not in PACKAGE_METADATA)
            ):
                finding(relative, node.lineno, "operation", f"本地执行策略不允许使用 {node.id}")
            type_name = isinstance(node, ast.Attribute) and node.attr == "__name__" and (
                isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name)
                and node.value.func.id == "type"
            )
            if isinstance(node, ast.Attribute) and (
                (node.attr.startswith("__") and node.attr not in PACKAGE_METADATA and not type_name) or
                node.attr in BLOCKED_NAMES or
                (isinstance(node.value, ast.Name) and node.value.id == "ctx" and node.attr.startswith("_"))
            ):
                finding(relative, node.lineno, "attribute", f"本地执行策略不允许访问 {node.attr}")
    if not has_entry:
        finding("agent.py", None, "entrypoint", "需要同步入口 def run(task, ctx)")
    report["approved"] = not report["findings"]
    return report


def protect_local_execution(root):
    for name in sorted(SAFE_MODULES):
        importlib.import_module(name)
    allowed_root = os.path.normcase(os.path.abspath(root))
    active = True
    write_flags = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND

    def check(event, args):
        if not active:
            return
        if event == "open":
            path, mode, flags = args
            if not isinstance(path, (bytes, str)) or flags & write_flags:
                raise PermissionError("本地执行限制文件访问")
            target = os.path.normcase(os.path.abspath(os.fsdecode(path)))
            if not target.startswith(allowed_root + os.sep):
                raise PermissionError("本地执行限制读取项目外文件")
        if event.startswith(("socket.", "subprocess.", "ctypes.", "winreg.", "shutil.")) or (
            event.startswith("os.") and event not in {"os.listdir", "os.scandir"}
        ):
            raise PermissionError(f"本地执行限制调用 {event}")

    def stop():
        nonlocal active
        active = False

    sys.addaudithook(check)
    return stop
