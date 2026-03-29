
#include "tabview.h"

lv_obj_t *label_accel_x;
lv_obj_t *label_accel_y;
lv_obj_t *label_accel_z;
lv_obj_t *label_gyro_x;
lv_obj_t *label_gyro_y;
lv_obj_t *label_gyro_z;

void qmi8658_tab_create(lv_obj_t * tab)
{
    lv_obj_t *list = lv_list_create(tab);
    lv_obj_set_size(list, lv_pct(100), lv_pct(100));  // 设置列表大小

    lv_obj_t *list_item = lv_list_add_btn(list, NULL, "accel_x");
    label_accel_x = lv_label_create(list_item);
    lv_label_set_text(label_accel_x, "0.00");  // 初始值

    list_item = lv_list_add_btn(list, NULL, "accel_y");
    label_accel_y = lv_label_create(list_item);
    lv_label_set_text(label_accel_y, "0.00");  // 初始值

    list_item = lv_list_add_btn(list, NULL, "accel_z");
    label_accel_z = lv_label_create(list_item);
    lv_label_set_text(label_accel_z, "0.00");  // 初始值

    list_item = lv_list_add_btn(list, NULL, "gyro_x");
    label_gyro_x = lv_label_create(list_item);
    lv_label_set_text(label_gyro_x, "0.00");  // 初始值

    list_item = lv_list_add_btn(list, NULL, "gyro_y");
    label_gyro_y = lv_label_create(list_item);
    lv_label_set_text(label_gyro_y, "0.00");  // 初始值

    list_item = lv_list_add_btn(list, NULL, "gyro_z");
    label_gyro_z = lv_label_create(list_item);
    lv_label_set_text(label_gyro_z, "0.00");  // 初始值
}
