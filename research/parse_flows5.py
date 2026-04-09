import re

file_path = "/Users/rvbcrs/GitHub/Novabot/research/blutter_output_v2.4.0/asm/flutter_novabot/pages/build_map/build_map_page/logic.dart"

with open(file_path, "r", encoding="utf-8") as f:
    lines = f.readlines()

current_func = None
func_commands = {}
commands_of_interest = ["start_scan_map", "stop_scan_map", "add_scan_map", "save_map", "reset_map", "delete_map", "start_erase_map", "stop_erase_map", "boundaries", "obstacle", "start_assistant_build_map", "quit_mapping_mode", "auto_recharge", "save_recharge_pos", "go_to_charge", "start_navigation", "pause_navigation", "resume_navigation", "stop_navigation"]

for line in lines:
    if "(/* No info */) {" in line:
        parts = line.split("(/* No info */) {")
        if len(parts) > 0:
            name_part = parts[0].strip().split(" ")
            current_func = name_part[-1]
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

