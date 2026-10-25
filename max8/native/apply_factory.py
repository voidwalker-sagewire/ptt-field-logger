#!/usr/bin/env python3
"""Patch a pinned Waveshare factory checkout without modifying its upstream repo."""
from pathlib import Path
import shutil
import sys

factory = Path(sys.argv[1]).resolve()
ours = Path(sys.argv[2]).resolve()
target = factory / "components" / "Max8"
target.mkdir(parents=True, exist_ok=True)
for filename in ("Max8.hpp", "Max8.cpp", "Max8Config.hpp", "Max8Config.cpp", "CMakeLists.txt"):
    shutil.copyfile(ours / filename, target / filename)

def replace(path, old, new):
    p = factory / path
    txt = p.read_text(encoding="utf-8")
    if txt.count(old) != 1:
        raise SystemExit(f"Patch marker expected once: {path} [{old}] count={txt.count(old)}")
    p.write_text(txt.replace(old,new),encoding="utf-8")

replace("main/main.cpp", '#include "MusicPlayer.hpp"', '#include "MusicPlayer.hpp"\n#include "Max8.hpp"')
replace("main/main.cpp",
        'install_app(phone, apps::MusicPlayer::requestInstance(), "MusicPlayer"),',
        'install_app(phone, apps::MusicPlayer::requestInstance(), "MusicPlayer"),')
# Add MAX-8 next to MusicPlayer in the regular native app launcher.
marker = '''    ESP_UTILS_CHECK_FALSE_EXIT(
        install_app(phone, apps::MusicPlayer::requestInstance(), "MusicPlayer"),
        "Install MusicPlayer failed"
    );'''
replace("main/main.cpp", marker, marker+'''
    ESP_UTILS_CHECK_FALSE_EXIT(
        install_app(phone, apps::Max8::requestInstance(), "MAX-8"),
        "Install MAX-8 failed"
    );''')
replace("main/CMakeLists.txt", "        MusicPlayer\n", "        MusicPlayer\n        Max8\n")
replace("components/bsp_extra/include/bsp_board_extra.h",
        "    BSP_EXTRA_AUDIO_OWNER_XIAOZHI,\n",
        "    BSP_EXTRA_AUDIO_OWNER_XIAOZHI,\n    BSP_EXTRA_AUDIO_OWNER_MAX8,\n")
replace("components/bsp_extra/src/bsp_board_extra.c",
        '    case BSP_EXTRA_AUDIO_OWNER_XIAOZHI:\n        return "Xiaozhi";',
        '    case BSP_EXTRA_AUDIO_OWNER_XIAOZHI:\n        return "Xiaozhi";\n    case BSP_EXTRA_AUDIO_OWNER_MAX8:\n        return "MAX-8";')
print("Integrated native MAX-8 app, vendor Recorder + MusicPlayer, owner token and build requirements")
