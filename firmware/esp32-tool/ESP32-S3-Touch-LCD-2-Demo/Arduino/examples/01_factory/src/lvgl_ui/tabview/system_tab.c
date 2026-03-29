#include "tabview.h"

lv_obj_t *label_sd;
lv_obj_t *label_chip_temp;
lv_obj_t *label_chip_name;
lv_obj_t *label_battery;
lv_obj_t *label_psram;
lv_obj_t *label_flash;
lv_obj_t *label_ip_address;

void system_tab_create(lv_obj_t * tab)
{
    // 创建一个列表
    lv_obj_t *list = lv_list_create(tab);
    lv_obj_set_size(list, lv_pct(100), lv_pct(100));  // 设置列表大小
    
    lv_obj_t *list_item = lv_list_add_btn(list, NULL, "Chip");
    label_chip_name = lv_label_create(list_item);
    lv_label_set_text(label_chip_name, "ESP32-S3");  // 初始值

    list_item = lv_list_add_btn(list, NULL, "ChipTemp");
    label_chip_temp = lv_label_create(list_item);
    lv_label_set_text(label_chip_temp, "0.0C");  // 初始值

    list_item = lv_list_add_btn(list, NULL, "PSRAM");
    label_psram = lv_label_create(list_item);
    lv_label_set_text(label_psram, "0M");  // 初始值

    list_item = lv_list_add_btn(list, NULL, "FLASH");
    label_flash = lv_label_create(list_item);
    lv_label_set_text(label_flash, "0M");  // 初始值

    list_item = lv_list_add_btn(list, NULL, "SD");
    label_sd = lv_label_create(list_item);
    lv_label_set_text(label_sd, "0M");  // 初始值

    list_item = lv_list_add_btn(list, NULL, "Battery");
    label_battery = lv_label_create(list_item);
    lv_label_set_text(label_battery, "0.0V");  // 初始值

    // list_item = lv_list_add_btn(list, NULL, "IP");
    // label_ip_address = lv_label_create(list_item);
    // lv_label_set_text(label_ip_address, "0.0.0.0");  // 初始值
}

