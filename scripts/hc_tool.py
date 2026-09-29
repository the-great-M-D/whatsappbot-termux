#!/usr/bin/env python3
import base64
import hashlib
import sys
from Crypto.Cipher import AES

XOR_LIST = ['。','〃','〄','々','〆','〇','〈','〉','《','》','「','」','『','』','【','】','〒','〓','〔','〕']

KEYS = [
(True,'hc_reborn_tester'),(True,'hc_reborn_tester_9'),(True,'hc_reborn_tester_8'),
(True,'hc_reborn_tester_7'),(True,'hc_reborn_tester_6'),(True,'hc_reborn_tester_5'),
(True,'hc_reborn_tester_4'),(True,'hc_reborn_tester_3'),(True,'hc_reborn_tester_2'),
(True,'hc_reborn_tester_1'),(True,'hc_reborn_for_you'),(True,'hc_reborn_7'),
(True,'hc_reborn_6'),(True,'hc_reborn_5'),(True,'hc_reborn_4'),(True,'hc_reborn_3'),
(True,'hc_reborn_2'),(True,'hc_reborn_1'),(True,'hc_reborn___7'),
(False,'hc_reborn10'),(False,'hc_reborn9'),(False,'hc_reborn8'),(False,'hc_reborn7'),
(False,'keY_secReaT_hc'),(False,'keY_secReaT_hc1'),(False,'keY_secReaT_hc2'),
(False,'keY_secReaT_hc_reborn'),(False,'keY_secReaT_hc_reborn1'),(False,'keY_secReaT_hc_2'),
(False,'keY_secReaT_hc_reborn3'),(False,'keY_secReaT_hc_reborn4'),
(False,'keY_secReaT_hc_reborn5'),(False,'keY_secReaT_hc_reborn6'),
(False,'keY_secReaT_te4Z9'),(False,'keY_secReaT_te4Z10'),(False,'keY_secReaT_te4Z11'),
(False,'keY_secReaT_e')
]

def aes_ecb(data, key):
    return AES.new(hashlib.sha1(key.encode()).digest()[:16], AES.MODE_ECB).decrypt(data)

def deobfuscate(data):
    text = data.decode('utf-8')
    out = bytearray()
    for i, char in enumerate(text):
        value = ord(char) ^ ord(XOR_LIST[i % len(XOR_LIST)])
        if value > 255:
            raise ValueError('unsupported HC obfuscation format')
        out.append(value)
    return base64.b64decode(bytes(out), validate=True)

def main():
    if len(sys.argv) != 4 or sys.argv[1] != 'decrypt':
        print('usage: hc_tool.py decrypt INPUT OUTPUT', file=sys.stderr)
        return 2

    input_file, output_file = sys.argv[2], sys.argv[3]
    encrypted = open(input_file, 'rb').read()

    candidates = []
    try:
        candidates.append(('deobfuscated', deobfuscate(encrypted)))
    except Exception:
        pass
    candidates.append(('raw', encrypted))

    for use_deob, key in KEYS:
        for source_name, source in candidates:
            if source_name == 'deobfuscated' and not use_deob:
                continue
            if source_name == 'raw' and use_deob:
                continue
            if len(source) % 16:
                continue
            try:
                text = aes_ecb(source, key).decode('utf-8').rstrip('\x00')
            except Exception:
                continue
            if 'splitConfig' in text:
                with open(output_file, 'w', encoding='utf-8') as out:
                    out.write(text)
                print(f'Successfully decrypted with key {key}')
                return 0

    print('HC decryption failed: unsupported format or key', file=sys.stderr)
    return 1

if __name__ == '__main__':
    raise SystemExit(main())
