import os
import re
from collections import defaultdict

asm_dir = "/Users/rvbcrs/GitHub/Novabot/research/blutter_output_v2.4.0/asm/flutter_novabot"

functions_with_commands = []

for root, _, files in os.walk(asm_dir):
    for f in files:
        if f.endswith(".dart"):
            filepath = os.path.join(root, f)
            with open(filepath, "r", encoding="utf-8") as file:
                content = file.read()
                
                # Split by EnterFrame
                frames = content.split("EnterFrame")
                for frame in frames:
                    if "_writeDataToDevice" in frame or "publishMessage" in frame or "cmd_num" in frame or "_sendCommand" in frame:
                        # Extract all strings assigned to registers
                        strings = re.findall(r'r\d+\w* = "([^"]+)"', frame)
                        
                        # filter out boring strings
                        strings = [s for s in strings if s not in ["", "OK", "Cancel", "Yes", "No", "GET", "POST", "cmd_num", "type"] and " " not in s and len(s) > 1]
                        
                        # Unique them but preserve order roughly
                        seen = set()
                        unique_strings = []
                        for s in strings:
                            if s not in seen:
                                seen.add(s)
                                unique_strings.append(s)
                        
                        if unique_strings:
                            func_name_match = re.search(r'\[package:[^\]]+\] ([^\s(]+)', frame)
                            func_name = func_name_match.group(1) if func_name_match else "unknown_function"
                            functions_with_commands.append((func_name, unique_strings))

for func, strings in functions_with_commands:
    if len(strings) > 0:
        print(f"Function: {func}")
        print(f"  Strings (likely command + payload keys): {strings}")

