import re

file_path = "/Users/rvbcrs/GitHub/Novabot/research/blutter_output_v2.4.0/asm/flutter_novabot/pages/build_map/build_map_page/logic.dart"

with open(file_path, "r", encoding="utf-8") as f:
    text = f.read()

funcs = re.split(r'  _ (.*?)\(\/\* No info \*\/\) \{', text)

# The first element is before any function.
for i in range(1, len(funcs), 2):
    func_name = funcs[i].strip()
    func_body = funcs[i+1]
    
    # find all string literals "..."
    strs = re.findall(r'"([^"]+)"', func_body)
    
    commands = [s for s in strs if s in ["start_scan_map", "stop_scan_map", "add_scan_map", "save_map", "reset_map", "delete_map", "start_erase_map", "stop_erase_map", "boundaries", "obstacle", "start_assistant_build_map", "quit_mapping_mode", "auto_recharge", "save_recharge_pos", "go_to_charge"]]
    
    if commands:
        # unique order preserving
        seen = set()
        cmd_unique = []
        for x in commands:
            if x not in seen:
                seen.add(x)
                cmd_unique.append(x)
                
        print(f"Function: {func_name}")
        print(f"  Commands found: {cmd_unique}")

