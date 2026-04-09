import re

file_path = "/Users/rvbcrs/GitHub/Novabot/research/blutter_output_v2.4.0/asm/flutter_novabot/pages/build_map/build_map_page/logic.dart"

with open(file_path, "r", encoding="utf-8") as f:
    text = f.read()

# split the text into blocks by function or closure
pattern = re.compile(r'^(?:\s*_?\s*(?:[0-9a-zA-Z_\$]+)?\s*([0-9a-zA-Z_\$]+)\(\/\* No info \*\/\) \{|\s*\[closure\] .*? \{)', re.MULTILINE)

parts = pattern.split(text)

commands_of_interest = ["start_scan_map", "stop_scan_map", "add_scan_map", "save_map", "reset_map", "delete_map", "start_erase_map", "stop_erase_map", "boundaries", "obstacle", "start_assistant_build_map", "quit_mapping_mode", "auto_recharge", "save_recharge_pos", "go_to_charge", "start_navigation", "pause_navigation", "resume_navigation", "stop_navigation"]

for i in range(1, len(parts)-1, 2):
    func_name = parts[i]
    if func_name is None:
        func_name = "Closure"
    body = parts[i+1]
    
    found = []
    for c in commands_of_interest:
        if f'"{c}"' in body:
            found.append(c)
            
    if found:
        print(f"Scope: {func_name}")
        for fcmd in found:
            print(f"  -> {fcmd}")

