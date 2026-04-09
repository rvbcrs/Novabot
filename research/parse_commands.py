import os
import re

asm_dir = "/Users/rvbcrs/GitHub/Novabot/research/blutter_output_v2.4.0/asm/flutter_novabot"

def extract_commands():
    command_patterns = {}
    
    for root, dirs, files in os.walk(asm_dir):
        for file in files:
            if file.endswith('.dart'):
                filepath = os.path.join(root, file)
                with open(filepath, 'r', encoding='utf-8') as f:
                    content = f.readlines()
                
                # Look for 'bl ... _writeDataToDevice' or 'publishMessage'
                for i, line in enumerate(content):
                    if '_writeDataToDevice' in line or 'MqttClient::publishMessage' in line or 'sendCmd' in line:
                        # Scan backwards up to 100 lines for string literals
                        strings_found = []
                        for j in range(i-1, max(-1, i-100), -1):
                            prev = content[j]
                            # Match strings like: r16 = "cmd_name"
                            m = re.search(r'r\d+\w* = "([^"]+)"', prev)
                            if m:
                                s = m.group(1)
                                if s not in ["cmd_num", "type", "true", "false"]:
                                    strings_found.append((s, j))
                            # Stop scanning back if we hit a LeaveFrame or EnterFrame
                            if 'EnterFrame' in prev:
                                break
                        
                        if strings_found:
                            # Reversing so they are in order of definition
                            strings_found.reverse()
                            # We keep track of the file and the group of strings
                            if filepath not in command_patterns:
                                command_patterns[filepath] = []
                            command_patterns[filepath].append(strings_found)

    for filepath, string_groups in command_patterns.items():
        print(f"File: {os.path.relpath(filepath, asm_dir)}")
        for group in string_groups:
            strings_only = [s[0] for s in group]
            print(f"  -> {strings_only}")

extract_commands()
