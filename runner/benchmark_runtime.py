import ast
import contextlib
import json
import os
import re
import sys
from pathlib import Path


BFCL_GROUPS = ('base', 'miss_func', 'miss_param', 'long_context', 'composite')



def emit(**message):
    print(json.dumps(message, ensure_ascii=False, allow_nan=False), file=PROTOCOL, flush=True)


def receive():
    line = sys.stdin.readline(25_000_000)
    if not line:
        raise EOFError('Workbench closed the benchmark connection')
    return json.loads(line)


def jsonl(file):
    with file.open(encoding='utf-8-sig') as source:
        return [json.loads(line) for line in source if line.strip()]


def upstream_function(filename, name, namespace):
    # Load a pure upstream routine without importing the model-specific CLI.
    tree = ast.parse(filename.read_text(encoding='utf-8'), filename=str(filename))
    function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == name)
    exec(compile(ast.Module(body=[function], type_ignores=[]), str(filename), 'exec'), namespace)
    return namespace[name]


def bfcl_files(root, group):
    data = root / 'bfcl_eval' / 'data'
    filename = f'BFCL_v3_multi_turn_{group}.json'
    if group == 'composite':
        data = data / 'unused_datasets'
        return data / 'question' / filename, data / 'possible_answer' / filename
    return data / filename, data / 'possible_answer' / filename


def bfcl_catalog(root):
    tasks = []
    for group in BFCL_GROUPS:
        questions, references = bfcl_files(root, group)
        entries, answers = jsonl(questions), jsonl(references)
        if [entry['id'] for entry in entries] != [entry['id'] for entry in answers]:
            raise ValueError(f'BFCL tasks and answers are not aligned for {group}')
        for entry in entries:
            first = next((msg['content'] for turn in entry['question'] for msg in turn if msg['role'] == 'user'), '')
            tasks.append({'key': entry['id'], 'group': group, 'title': first})
    return tasks


def python_literal(value):
    # The official checker executes strings. Encode every character in string
    # values so neither Python syntax nor upstream name rewriting can interpret them.
    if isinstance(value, str):
        return "'" + ''.join(f'\\U{ord(char):08x}' for char in value) + "'"
    if isinstance(value, list):
        return '[' + ','.join(map(python_literal, value)) + ']'
    if isinstance(value, dict):
        return '{' + ','.join(python_literal(key) + ':' + python_literal(item) for key, item in value.items()) + '}'
    return repr(value)


def score_details(verdict, truth):
    reason = verdict.get('error_type', '')
    match = re.search(r'\bfor turn (\d+)\b', verdict.get('error_message', ''))
    failed_round = int(match.group(1)) + 1 if match else None
    if reason == 'multi_turn:instance_state_mismatch' and verdict.get('execution_result'):
        failed_round = len(verdict['execution_result'])
    details = verdict.get('details', {})
    missing = details.get('missing_items', [])
    outstanding = list(missing)
    fields = set()
    reference_tools = []
    for entry in missing:
        try:
            value = json.loads(entry) if isinstance(entry, str) else entry
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            fields.update(key for key in value if isinstance(key, str) and re.fullmatch(r'[A-Za-z_]\w{0,59}', key))
    if outstanding and failed_round and failed_round <= len(truth):
        for call, result in zip(truth[failed_round - 1], details.get('ground_truth_response (only the current turn)', [])):
            if result in outstanding:
                outstanding.remove(result)
                tool = re.match(r'([A-Za-z_]\w*)\(', call)
                if tool and tool.group(1) not in reference_tools:
                    reference_tools.append(tool.group(1))
    return {'passed': verdict['valid'], 'method': 'BFCL 官方状态与返回检查', 'reason': reason,
            'failedRound': failed_round, 'differingFields': list(details.get('differences', {})),
            'missingResultCount': len(missing), 'missingResultFields': sorted(fields)[:12],
            'missingResultReferenceTools': reference_tools[:12]}


def bfcl_run(root, group, key):
    sys.path.insert(0, str(root))
    from bfcl_eval.constants.category_mapping import MULTI_TURN_FUNC_DOC_FILE_MAPPING
    from bfcl_eval.constants.default_prompts import DEFAULT_USER_PROMPT_FOR_ADDITIONAL_FUNCTION_FC
    from bfcl_eval.constants.eval_config import MULTI_TURN_FUNC_DOC_PATH
    from bfcl_eval.eval_checker.multi_turn_eval.multi_turn_checker import multi_turn_checker, multi_turn_irrelevance_checker
    from bfcl_eval.eval_checker.multi_turn_eval.multi_turn_utils import execute_multi_turn_func_call
    from bfcl_eval.utils import is_multi_turn, load_file

    questions, references = bfcl_files(root, group)
    case = next(item for item in jsonl(questions) if item['id'] == key)
    truth = next(item['ground_truth'] for item in jsonl(references) if item['id'] == key)
    prepare = upstream_function(root / 'bfcl_eval' / '_llm_response_generation.py', 'process_multi_turn_test_case', {
        'is_multi_turn': is_multi_turn, 'load_file': load_file, 'MULTI_TURN_FUNC_DOC_PATH': MULTI_TURN_FUNC_DOC_PATH,
        'MULTI_TURN_FUNC_DOC_FILE_MAPPING': MULTI_TURN_FUNC_DOC_FILE_MAPPING,
    })
    prepare([case])
    schemas = {}
    turns = case['question']
    calls = [[] for _ in turns]
    index = -1
    model_name = 'workbench'
    category = key.rsplit('_', 1)[0]
    emit(type='ready')
    while True:
        request = receive()
        name, args = request['name'], request['arguments']
        if name == 'next_turn':
            index += 1
            if index >= len(turns):
                emit(type='reply', output={'done': True})
                continue
            additions = case.get('missed_function', {}).get(str(index), [])
            for schema in (case['function'] if index == 0 else []) + additions:
                schemas[schema['name']] = schema
            messages = turns[index]
            if str(index) in case.get('missed_function', {}):
                messages = [{'role': 'user', 'content': DEFAULT_USER_PROMPT_FOR_ADDITIONAL_FUNCTION_FC}]
            output = {'round': index + 1, 'messages': messages, 'tools': list(schemas.values()),
                      'addedTools': [schema['name'] for schema in additions], 'availableToolCount': len(schemas)}
        elif name == 'score':
            verdict = multi_turn_irrelevance_checker(calls, truth)
            if verdict['valid']:
                verdict = multi_turn_checker(calls, truth, case, category, model_name)
            emit(type='score', **score_details(verdict, truth))
            return
        elif index < 0 or index >= len(turns) or name not in schemas or not re.fullmatch(r'[A-Za-z_]\w*', name):
            emit(type='reply', error='当前 BFCL 轮次未提供该工具', decision='deny')
            continue
        else:
            # **dict preserves invalid parameter names as ordinary data, letting
            # the official simulator return its normal argument error.
            expression = name + '(**' + python_literal(args) + ')'
            result, _ = execute_multi_turn_func_call([expression], case.get('initial_config', {}),
                case['involved_classes'], model_name, key, group in ('long_context', 'composite'))
            calls[index].append([expression])
            output = result[0]
        emit(type='reply', output=output)


def main():
    action, root, *args = sys.argv[1:]
    root = Path(root).resolve()
    if action == 'bfcl-list':
        emit(type='catalog', tasks=bfcl_catalog(root))
    elif action == 'bfcl-run':
        bfcl_run(root, *args)
    else:
        raise ValueError('Unknown benchmark runtime operation')


if __name__ == '__main__':
    PROTOCOL = os.fdopen(os.dup(sys.stdout.fileno()), 'w', encoding='utf-8')
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    with contextlib.redirect_stdout(sys.stderr):
        try:
            main()
        except Exception as error:
            emit(type='error', error=f'{type(error).__name__}: {error}'[:600])
            sys.exit(1)
