"""Read-only exact-build check: Go-symbol positions, jump, result and inverse."""
from pathlib import Path
import argparse
import hashlib
import json
import struct


def verify(original, recipe, analysis):
    target = recipe['targets'][0]
    pins = target['files']['agy.exe']
    def sha(data):
        return hashlib.sha256(data).hexdigest()
    assert sha(original) == pins['base'] == analysis['sha256'], 'Wrong original build'
    functions = {item['name'].rsplit('.', 1)[-1]: item for item in analysis['functions']}
    origin, destination = functions['ContextWindow'], functions['ContextWindowChoice']
    assert origin['name'].endswith('store.(*Store).ContextWindow')
    assert destination['name'].endswith('store.(*Store).ContextWindowChoice')
    assert len(target['byte_replacements']) == 1
    edit = target['byte_replacements'][0]
    offset = edit['offset']
    before, after = bytes.fromhex(edit['before']), bytes.fromhex(edit['after'])
    assert offset == origin['file_offset'], 'Recipe does not use this build\'s Go symbol'
    assert before == original[offset:offset + 5] == bytes.fromhex(origin['code_hex'])[:5]
    expected = b'\xe9' + struct.pack('<i', int(destination['address'], 16) - int(origin['address'], 16) - 5)
    assert after == expected and len(before) == len(after) == 5
    patched = original[:offset] + after + original[offset + 5:]
    assert sha(patched) == pins['result'], 'Wrong full result fingerprint'
    restored = patched[:offset] + before + patched[offset + 5:]
    assert restored == original
    assert patched[:offset] == original[:offset] and patched[offset + 5:] == original[offset + 5:]
    return {'base':sha(original), 'result':sha(patched), 'rollback':sha(restored),
            'version':target['version'], 'offset':offset, 'before':before.hex(), 'after':after.hex(),
            'origin':origin['address'], 'destination':destination['address'],
            'only_declared_bytes_changed':True, 'inverse_exact':True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True, help='Private unmodified exact-build executable')
    parser.add_argument('--analysis', type=Path, required=True, help='Fresh inspect-getters.py JSON for that build')
    parser.add_argument('--recipe', type=Path, required=True, help='Recipe JSON (same shape as recipes/*.json)')
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    recipe = json.loads(args.recipe.read_text(encoding='utf-8'))
    original = args.binary.read_bytes()
    analysis = json.loads(args.analysis.read_text())
    result = verify(original, recipe, analysis)
    # Protect the manager's whole-file identity contract, not just five bytes.
    mutated = bytes([original[0] ^ 1]) + original[1:]
    try:
        verify(mutated, recipe, analysis)
    except AssertionError:
        result['unrelated_drift_rejected'] = True
    else:
        raise AssertionError('Unrelated byte drift accepted')
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
