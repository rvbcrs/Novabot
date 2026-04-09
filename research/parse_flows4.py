import re

file_path = "/Users/rvbcrs/GitHub/Novabot/research/blutter_output_v2.4.0/asm/flutter_novabot/pages/build_map/build_map_page/logic.dart"

with open(file_path, "r", encoding="utf-8") as f:
    lines = f.readlines()

current_func = None

func_commands = {}

commands_of_interest = ["start_scan_map", "stop_scan_map", "add_scan_map", "save_map", "reset_map", "delete_map", "start_erase_map", "stop_erase_map", "boundaries", "obstacle", "start_assistant_build_map", "quit_mapping_mode", "auto_recharge", "save_recharge_pos", "go_to_charge", "start_navigation", "pause_navigation", "resume_navigation", "stop_navigation"]

for line in lines:
    m = re.match(r'^  _ (.*?)\/\* No info \*\/', line)
    if m:
        current_func = m.group(1).strip()
        func_commands[current_func] = []
        continue
        
    m2 = re.match(r'^\s*([0-9a-zA-Z_]+)\(\/\* No info \*\/', line)
    if m2:
        current_func = m2.group(1).strip()
        func_commands[current_func] = []
        continue

    # wait, blutter methods are often like `  _ _writeSaveMap(/* No info */) {`
    m3 = re.match(r'^\s*_?\s+([0-9a-zA-Z_]+)\(\/\* No info \*\/\) \{', line)
    if m3:
        current_func = m3.group(1).strip()
        func_commands[current_func] = []
        continue

    if current_func:
        for c in commands_of_interest:
            if f'"{c}"' in line:
                if c not in func_commands[current_func]:
                    func_commands[current_func].append(c)

for k, v in func_commands.items():
    if v:
        print(f"Function: {k}")
        for cmd in v:
            print(f"  -> {cmd}")

