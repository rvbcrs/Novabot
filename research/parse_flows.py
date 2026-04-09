import re

file_path = "/Users/rvbcrs/GitHub/Novabot/research/blutter_output_v2.4.0/asm/flutter_novabot/pages/build_map/build_map_page/logic.dart"

with open(file_path, "r", encoding="utf-8") as f:
    lines = f.readlines()

current_func = None
func_start = 0

functions = {}

for i, line in enumerate(lines):
    m = re.match(r'^  _ (.*?)\/\* No info \*\/', line)
    if m:
        func = m.group(1).strip()
        current_func = func
        functions[current_func] = []
        continue
        
    m2 = re.match(r'^\s*([0-9a-zA-Z_]+)\(\/\* No info \*\/', line)
    if m2:
        func = m2.group(1).strip()
        current_func = func
        functions[current_func] = []
        continue
        
    if current_func is not None:
        if line.startswith("  _ "):
            continue
            
        # extract strings
        str_m = re.findall(r'"([^"]+)"', line)
        for s in str_m:
            if s not in functions[current_func] and len(s)>2 and not s.startswith("package:") and not s.startswith("dart:"):
                functions[current_func].append(s)

for k, v in functions.items():
    if len(v) > 0:
        relevant = [s for s in v if s in ["start_scan_map", "stop_scan_map", "add_scan_map", "save_map", "reset_map", "delete_map", "start_erase_map", "stop_erase_map", "boundaries", "obstacle", "start_assistant_build_map", "quit_mapping_mode", "auto_recharge", "save_recharge_pos", "go_to_charge"]]
        if relevant:
            print(f"Function: {k}")
            print(f"  Commands found: {relevant}")
