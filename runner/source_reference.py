import ast
import io
import tokenize
from pathlib import Path
from types import FunctionType, MethodType


STRUCTURAL_STRINGS = {repr(value) for value in (
    'role', 'user', 'assistant', 'system', 'tool', 'content', 'messages', 'tool_calls', 'tool_call_id',
    'results', 'compression', 'input', 'output', 'error', 'ok', 'id', 'name', 'arguments', 'status'
)}
STRUCTURAL_STRINGS |= {value.replace("'", '"') for value in STRUCTURAL_STRINGS}


def mask_literals(text):
    lines = text.splitlines(keepends=True)
    offsets = [0]
    for line in lines:
        offsets.append(offsets[-1] + len(line))
    replacements = []
    for token in tokenize.generate_tokens(io.StringIO(text).readline):
        if token.type == tokenize.COMMENT:
            replacement = '# …'
        elif token.type == tokenize.STRING and token.string not in STRUCTURAL_STRINGS:
            replacement = '"…"' + '\n' * (token.end[0] - token.start[0])
        elif tokenize.tok_name.get(token.type) in {'FSTRING_MIDDLE', 'TSTRING_MIDDLE'}:
            replacement = '…' + '\n' * (token.end[0] - token.start[0])
        else:
            continue
        start = offsets[token.start[0] - 1] + token.start[1]
        end = offsets[token.end[0] - 1] + token.end[1]
        replacements.append((start, end, replacement))
    parts = []
    cursor = 0
    for start, end, replacement in replacements:
        parts.extend((text[cursor:start], replacement))
        cursor = end
    parts.append(text[cursor:])
    return ''.join(parts).splitlines()


class SourceReference:
    def __init__(self, root, files, emit):
        self.root = root
        self.files = set(files)
        self.emit = emit
        self.index = {}
        self.references = {}

    def _path(self, code):
        path = Path(code.co_filename)
        return path.relative_to(self.root).as_posix() if path.is_relative_to(self.root) else None

    def _load(self, file):
        if file not in self.index:
            try:
                text = (self.root / file).read_text(encoding='utf-8-sig')
                functions = {(node.name, min(item.lineno for item in [node, *node.decorator_list])): node.end_lineno
                             for node in ast.walk(ast.parse(text)) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
                self.index[file] = (mask_literals(text), functions)
            except (OSError, ValueError, SyntaxError, tokenize.TokenError, RecursionError):
                self.index[file] = ([], {})
        return self.index[file]

    def capture(self, frame, source=None):
        if isinstance(source, (FunctionType, MethodType)) and self._path(source.__code__) in self.files:
            code = source.__code__
            line = code.co_firstlineno
        else:
            while frame and self._path(frame.f_code) not in self.files:
                frame = frame.f_back
            if not frame:
                return None
            code, line = frame.f_code, frame.f_lineno
        file = self._path(code)
        lines, functions = self._load(file)
        if not lines:
            return None
        first = code.co_firstlineno
        end = functions.get((code.co_name, first), min(len(lines), max(first, line) + 4))
        start = max(first, min(line - 9, end - 28))
        key = (file, first, start)
        if key not in self.references:
            if len(self.references) >= 96:
                return None
            code_lines = []
            byte_limit = 3800
            for source_line in lines[start - 1:min(end, start + 35)]:
                safe_line = source_line[:420]
                size = len(safe_line.encode('utf-8')) + 1
                if size > byte_limit:
                    break
                code_lines.append(safe_line)
                byte_limit -= size
            identifier = str(len(self.references) + 1)
            self.references[key] = identifier
            self.emit({'type': 'source', 'source': {
                'id': identifier, 'file': file, 'function': getattr(code, 'co_qualname', code.co_name),
                'startLine': start, 'endLine': start + len(code_lines) - 1, 'code': '\n'.join(code_lines)
            }})
        return {'id': self.references[key], 'line': line}
