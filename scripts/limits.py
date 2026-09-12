import argparse
import ast
from fnmatch import fnmatchcase
import io
import json
from pathlib import Path
import re
import subprocess
import sys
import tokenize


def command(args, cwd):
    return subprocess.check_output(args, cwd=cwd, text=True, stderr=subprocess.PIPE)


def checked_prose(text):
    output = []
    fence = None
    comment = False
    for line in text.splitlines():
        stripped = line.lstrip(' ')
        if len(line) - len(stripped) <= 3:
            if comment:
                if '-->' in stripped:
                    comment = False
                continue
            if stripped.startswith('<!--'):
                comment = '-->' not in stripped
                continue
            match = re.match(r'(`{3,}|~{3,})', stripped)
            if match:
                marker = match.group(1)
                if fence is None:
                    fence = marker
                elif marker[0] == fence[0] and len(marker) >= len(fence):
                    fence = None
                continue
        if fence is None:
            output.append(line)
    return '\n'.join(output)


DENIED_DIRECTORIES = {'atlas', 'data', 'state', 'intake', 'graph', 'plans', 'runs', 'secrets', '.claude', '.codex', '.agents'}
DENIED_FILES = {'*.sqlite*', '*.db*', '*.jsonl', '.env', '.env.*', 'engine.pin', 'copies-manifest', 'delivery-registry'}
REQUIRED_IGNORES = {name + '/' for name in DENIED_DIRECTORIES} | DENIED_FILES


def hygiene(root, tracked):
    errors = []
    def published(name):
        if name in tracked:
            return subprocess.check_output(['git', 'show', ':' + name], cwd=root)
        return (root / name).read_bytes()
    if '.gitignore' not in tracked:
        errors.append('.gitignore must be tracked')
    else:
        lines = set(published('.gitignore').decode().splitlines())
        for pattern in sorted(REQUIRED_IGNORES - lines):
            errors.append(f'.gitignore missing required pattern: {pattern}')
        if any(line.startswith('!') for line in lines):
            errors.append('.gitignore must not negate private-data ignores')
    candidates = tracked | set(filter(None, command(['git', 'ls-files', '--others', '--exclude-standard', '-z'], root).split('\0')))
    for name in sorted(candidates):
        if (root / name).is_symlink():
            errors.append(f"{name}: symlink visible to public Git layer")
            continue
        if any(part in DENIED_DIRECTORIES or any(fnmatchcase(part, pattern) for pattern in DENIED_FILES) for part in Path(name).parts):
            errors.append(f'private path visible to public Git layer: {name}')
        if name.startswith('fixtures/') and b'Vera Example' not in published(name):
            errors.append(f'{name}: fixture lacks Vera Example marker')
    return errors


def check(root):
    errors = []
    entries = command(['git', 'ls-files', '--stage', '-z'], root).split('\0')
    files = {}
    tracked = set()
    for entry in filter(None, entries):
        metadata, name = entry.split('\t', 1)
        mode, _, stage = metadata.split()
        tracked.add(name)
        if stage != '0':
            errors.append(f'{name}: unresolved index entry')
        if mode == '120000' or (root / name).is_symlink():
            errors.append(f'{name}: tracked symlink is forbidden')
            continue
        if mode == '160000':
            continue
        try:
            files[name] = (root / name).read_bytes()
        except OSError as error:
            errors.append(f'{name}: {error}')
    errors.extend(hygiene(root, tracked))
    budget = sum(len(data) for name, data in files.items() if name != 'LICENSE' and Path(name).name != 'Cargo.lock') / 4
    if budget > 70_000:
        errors.append(f'budget exceeded: {budget:g} > 70000 tokens')
    directories = set()
    for name in files:
        parts = Path(name).parts
        if not any(part.startswith('.') for part in parts):
            directories.update('/'.join(parts[:i]) + '/' for i in range(1, len(parts)))
        if name.lower().endswith('.md') and name not in {'README.md', 'AGENTS.md', 'GOALS.md', 'CLAUDE.md'}:
            errors.append(f'{name}: Markdown is not allowed')
    readme = files.get('README.md', b'').decode()
    section = re.search(r'^## Map\s*\n(.*?)(?=^#|\Z)', readme, re.M | re.S)
    mapped = []
    if section is None:
        errors.append('README.md: missing ## Map')
    else:
        for line in section.group(1).splitlines():
            if not line.strip():
                continue
            match = re.fullmatch(r'- `([^`]+/)`: .+', line)
            if match is None or len(line) > 250:
                errors.append(f'README.md: invalid Map line: {line}')
            else:
                mapped.append(match.group(1))
        if sorted(mapped) != sorted(directories):
            errors.append(f'README.md: Map must list each visible directory exactly once: {sorted(directories)}')
    metadata = json.loads(command(['cargo', 'metadata', '--offline', '--no-deps', '--format-version', '1', '--manifest-path', str(root / 'Cargo.toml')], root))
    package = next(p for p in metadata['packages'] if Path(p['manifest_path']).resolve() == (root / 'Cargo.toml').resolve())
    target_names = {str(Path(t['src_path']).relative_to(root)): t['name'] for t in package['targets'] if 'test' in t['kind']}
    targets = set(target_names)
    if any(Path(name).parent != Path('tests') or not name.endswith('.rs') for name in targets):
        errors.append('Rust integration tests must live in tests/*.rs')
    checker = Path(__file__).resolve().parents[1] / 'Cargo.toml'
    sources = [{'path': name, 'text': data.decode(), 'test_target': name in targets} for name, data in files.items() if name.endswith('.rs')]
    result = subprocess.run(['cargo', 'run', '--quiet', '--locked', '--manifest-path', str(checker), '--example', 'check_limits'], input=json.dumps(sources), text=True, capture_output=True, check=True)
    rust = json.loads(result.stdout)
    errors.extend(rust['errors'])
    if set(rust['test_files']) != targets:
        errors.append('Rust test targets must all be tracked')
    goals = checked_prose(files.get('GOALS.md', b'').decode())
    bindings = []
    for paragraph in re.split(r'\n\s*\n', goals):
        for match in re.finditer(r'^\d+\. .*(?:\n[ \t]+.*)*', paragraph, re.M):
            names = re.findall(r'`([^`]+\.rs)`', match.group())
            if len(names) != 1:
                errors.append('GOALS.md: each numbered goal must name exactly one Rust test file')
            bindings.extend(names)
    if sorted(bindings) != sorted(targets):
        errors.append(f'GOALS.md: bind each Rust test target exactly once: {sorted(targets)}')
    for name, data in files.items():
        if not name.endswith('.py'):
            continue
        try:
            source = data.decode()
            for token in tokenize.generate_tokens(io.StringIO(source).readline):
                if token.type == tokenize.COMMENT and not (token.start[0] == 1 and token.string.startswith('#!')):
                    errors.append(f'{name}:{token.start[0]}: Python comments are forbidden')
            for node in ast.walk(ast.parse(source)):
                if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and ast.get_docstring(node) is not None:
                    errors.append(f'{name}: Python docstrings are forbidden')
        except (SyntaxError, tokenize.TokenError) as error:
            errors.append(f'{name}: invalid Python: {error}')
    if not errors:
        for path, name in target_names.items():
            listing = command(['cargo', 'test', '--offline', '--locked', '--manifest-path', str(root / 'Cargo.toml'), '--test', name, '--', '--list'], root)
            if not re.search(r'^.+: test$', listing, re.M):
                errors.append(f'{path}: Cargo discovered no runnable tests')
    print(f'Budget: {budget:g}/70000 tokens (tracked bytes / 4; LICENSE and Cargo.lock excluded)')
    print('\n'.join(errors) if errors else 'Limits: OK')
    return bool(errors)


def main():
    parser = argparse.ArgumentParser(description='Atlas limits, with Cargo target discovery and Rust syntax checks')
    parser.add_argument('--root', type=Path, default=Path.cwd())
    args = parser.parse_args()
    try:
        return check(args.root.resolve())
    except (OSError, ValueError, StopIteration, subprocess.CalledProcessError) as error:
        print(f'limits failed: {error}', file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError):
            print(error.stderr, file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
