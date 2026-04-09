import re

file_path = "/Users/rvbcrs/GitHub/Novabot/research/blutter_output_v2.4.0/asm/flutter_novabot/pages/build_map/build_map_page/logic.dart"

with open(file_path, "r", encoding="utf-8") as f:
    text = f.read()

# splitting by lines
lines = text.split('\n')

current_func = None

func_commands = {}

commands_of_interest = ["start_scan_map", "stop_scan_map", "add_scan_map", "save_map", "reset_map", "delete_map", "start_erase_map", "stop_erase_map", "boundaries", "obstacle", "start_assistant_build_map", "quit_mapping_mode", "auto_recharge", "save_recharge_pos", "go_to_charge", "start_navigation", "pause_navigation", "resume_navigation", "stop_navigation", "generate_preview_cover_path"]

for line in lines:
    if line.startswith("  _ ") and "(/* No info */) {" in line:
        current_func = line.split("  _ ")[1].split("(")[0].strip()
        func_commands[current_func] = []
    elif current_func:
        # find string literals
        for c in commands_of_interest:
            if f'"{c}"' in line:
                if c not in func_commands[current_func]:
                    func_commands[current_func].append(c)

for k, v in func_commands.items():
    if v:
        print(f"Function: {k}")
        for cmd in v:
            print(f"  -> {cmd}")

