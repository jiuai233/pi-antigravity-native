"""Read-only Go function-table and PE inspection for the installed AGY binary."""
import argparse
from pathlib import Path
import hashlib
import json
import re
import struct
import pefile
from capstone import Cs, CS_ARCH_X86, CS_MODE_64

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--binary', type=Path, required=True)
parser.add_argument('--out', type=Path, required=True)
parser.add_argument('--pattern', default=r'Store\).*ContextWindow', help='Regex over Go function names')
parser.add_argument('--names-only', action='store_true')
args = parser.parse_args()
binary = args.binary
data = binary.read_bytes()
pe = pefile.PE(data=data, fast_load=True)
image_base = pe.OPTIONAL_HEADER.ImageBase
headers = []
for magic in (b'\xf1\xff\xff\xff\x00\x00\x01\x08', b'\xf0\xff\xff\xff\x00\x00\x01\x08'):
    start = 0
    while True:
        at = data.find(magic, start)
        if at < 0:
            break
        start = at + 1
        nfunc, nfiles, text, names, cu, files, pctab, pcln = struct.unpack_from('<8Q', data, at + 8)
        section = pe.get_section_by_rva(pe.get_rva_from_offset(at))
        if 0 < nfunc < 500000 and at + pcln + nfunc * 8 < len(data) and section.Name.rstrip(b'\x00') == b'.rdata':
            headers.append((at, nfunc, text, names, pcln))
if len(headers) != 1:
    raise RuntimeError(f'Expected one valid Go pcHeader; found {headers}')
base, nfunc, text, names, pcln = headers[0]
module_data = None
if text == 0:
    header_va = image_base + pe.get_rva_from_offset(base)
    names_va = image_base + pe.get_rva_from_offset(base + names)
    needle = struct.pack('<QQ', header_va, names_va)
    matches = []
    cursor = 0
    while True:
        pos = data.find(needle, cursor)
        if pos < 0:
            break
        cursor = pos + 1
        values = struct.unpack_from('<24Q', data, pos)
        if values[20] == values[22] and image_base <= values[22] < values[23] < image_base + pe.OPTIONAL_HEADER.SizeOfImage:
            matches.append((pos, values[22]))
    if len(matches) != 1:
        raise RuntimeError(f'Cannot uniquely bind pcHeader to moduledata.text: {matches}')
    module_data, text = matches[0]
symbol_names = {}
for i in range(nfunc):
    entry, offset = struct.unpack_from('<II', data, base + pcln + i * 8)
    name_offset = struct.unpack_from('<i', data, base + pcln + offset + 4)[0]
    pos = base + names + name_offset
    symbol_names[text + entry] = data[pos:data.find(b'\x00', pos)].decode('utf-8', 'strict')
functions = []
for i in range(nfunc):
    entry, offset = struct.unpack_from('<II', data, base + pcln + i * 8)
    name_offset = struct.unpack_from('<i', data, base + pcln + offset + 4)[0]
    pos = base + names + name_offset
    end = data.find(b'\x00', pos)
    name = data[pos:end].decode('utf-8', 'strict')
    if not re.search(args.pattern, name):
        continue
    next_entry = struct.unpack_from('<I', data, base + pcln + (i + 1) * 8)[0]
    address = text + entry
    offset_file = pe.get_offset_from_rva(address - image_base)
    code = data[offset_file:offset_file + next_entry - entry]
    instructions = [] if args.names_only else [
        {'address': hex(x.address), 'bytes': x.bytes.hex(), 'mnemonic': x.mnemonic, 'operands': x.op_str}
        for x in Cs(CS_ARCH_X86, CS_MODE_64).disasm(code, address)]
    for instruction in instructions:
        if instruction['mnemonic'] == 'call' and instruction['operands'].startswith('0x'):
            instruction['symbol'] = symbol_names.get(int(instruction['operands'], 16))
        if instruction['mnemonic'] == 'lea' and '[rip ' in instruction['operands']:
            match = re.search(r'\[rip ([+-]) (0x[0-9a-f]+)\]', instruction['operands'])
            if match:
                displacement = int(match[2], 16) * (1 if match[1] == '+' else -1)
                reference = int(instruction['address'], 16) + len(bytes.fromhex(instruction['bytes'])) + displacement
                try:
                    at = pe.get_offset_from_rva(reference - image_base)
                    instruction['static_reference'] = repr(data[at:at + 80])
                except pefile.PEFormatError:
                    pass
    functions.append({'name': name, 'address': hex(address), 'file_offset': offset_file, 'size': len(code),
                      'code_hex': '' if args.names_only else code.hex(), 'instructions': instructions})
result = {'binary': str(binary), 'sha256': hashlib.sha256(data).hexdigest(), 'image_base': hex(image_base),
          'pclntab_offset': base, 'module_data_offset': module_data, 'resolved_text': hex(text), 'functions': functions, 'writes_to_binary': 0}
args.out.parent.mkdir(parents=True, exist_ok=True)
args.out.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
