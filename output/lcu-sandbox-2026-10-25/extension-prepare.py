"""Acquire the official Chrome extension for an empty disposable Chromium profile.

The CRX header/key handling follows amontlabs/lcu tests/browser_extension.py (MIT).
Only the unpacked manifest key is added; executable extension code stays unchanged.
"""
import base64,hashlib,json,struct,urllib.request,zipfile
from pathlib import Path

root=Path('/home/user/lcu-trial')
extension_id='hehggadaopoacecdllhhajmbjkdcmajg'
url='https://clients2.google.com/service/update2/crx?response=redirect&prodversion=143.0.7499.4&acceptformat=crx3&x=id%3D'+extension_id+'%26uc'
with urllib.request.urlopen(url,timeout=60) as response:
    raw=response.read()
archive=root/'official-extension.crx'; archive.write_bytes(raw)
if raw[:8]!=b'Cr24\x03\x00\x00\x00': raise ValueError('Expected CRX3')

def fields(data):
    offset=0
    def varint():
        nonlocal offset
        value=shift=0
        while True:
            byte=data[offset]; offset+=1; value|=(byte&127)<<shift
            if byte<128:return value
            shift+=7
    while offset<len(data):
        tag=varint()
        if tag&7==2:
            length=varint(); value=data[offset:offset+length]; offset+=length
        elif tag&7==0:value=varint()
        else:raise ValueError('Unsupported CRX field')
        yield tag>>3,value

header_size=struct.unpack('<I',raw[8:12])[0]
key=None
for number,value in fields(raw[12:12+header_size]):
    if number in (2,3):
        candidate=dict(fields(value))[1]
        identity=''.join(chr(int(digit,16)+97) for digit in hashlib.sha256(candidate).hexdigest()[:32])
        if identity==extension_id:key=candidate
if key is None:raise ValueError('Official extension public key missing')
destination=root/'extension'
with zipfile.ZipFile(archive) as source:
    for item in source.infolist():
        if item.filename.startswith('/') or '..' in Path(item.filename).parts:raise ValueError('Unsafe path')
    source.extractall(destination)
manifest_path=destination/'manifest.json'
manifest=json.loads(manifest_path.read_text())
manifest['key']=base64.b64encode(key).decode()
manifest_path.write_text(json.dumps(manifest,indent=2))
print(json.dumps({'extensionId':extension_id,'version':manifest['version'],'sha256':hashlib.sha256(raw).hexdigest(),'permissions':manifest.get('permissions'),'hostPermissions':manifest.get('host_permissions')},indent=2))
