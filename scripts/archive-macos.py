"""Cross-build zip preserving app-bundle symlinks and Unix executable permissions."""
import os
import stat
import sys
import zipfile
from pathlib import Path
source = Path(sys.argv[1]).resolve()
target = Path(sys.argv[2]).resolve()
with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for directory, folders, files in os.walk(source, followlinks=False):
        for name in folders + files:
            file = Path(directory) / name
            relative = file.relative_to(source.parent).as_posix()
            if file.is_symlink():
                info = zipfile.ZipInfo(relative)
                info.create_system = 3
                info.external_attr = (stat.S_IFLNK | 0o777) << 16
                archive.writestr(info, os.readlink(file).encode())
            else:
                archive.write(file, relative)
