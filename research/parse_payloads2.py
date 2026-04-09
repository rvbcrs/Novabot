import os
import re

asm_dir = "/Users/rvbcrs/GitHub/Novabot/research/blutter_output_v2.4.0/asm/flutter_novabot"

for root, _, files in os.walk(asm_dir):
    for f in files:
        if f.endswith(".dart"):
            filepath = os.path.join(root, f)
            with open(filepath, "r", encoding="utf-8") as file:
                content = file.read()
                
                frames = content.split("EnterFrame")
                for i, frame in enumerate(frames):
                    if "cmd_num" in frame or "type" in frame or "topic" in frame or "payload" in frame:
                        strings = re.findall(r'r\d+\w* = "([^"]+)"', frame)
                        strings = [s for s in strings if s not in ["", "OK", "Cancel", "Yes", "No", "cmd_num"] and len(s) > 1]
                        
                        seen = set()
                        unique_strings = []
                        for s in strings:
                            if s not in seen:
                                seen.add(s)
                                unique_strings.append(s)
                                
                        if unique_strings:
                            print(f"File: {f}, Frame: {i}")
                            print(f"Strings: {unique_strings}")
