#include "tabview.h"




wifi_mode_change_cb g_wifi_mode_change_cb;

enum
{
    LV_MENU_ITEM_BUILDER_VARIANT_1,
    LV_MENU_ITEM_BUILDER_VARIANT_2
};
typedef uint8_t lv_menu_builder_variant_t;

lv_obj_t *label_wifi_sta_ip;
lv_obj_t *label_wifi_ap_ip;
lv_obj_t *label_wifi_sta_ssid;
lv_obj_t *label_wifi_sta_pass;
lv_obj_t *label_wifi_ap_ssid;
lv_obj_t *label_wifi_ap_pass;
lv_obj_t *sw_wifi_sta;
lv_obj_t *sw_wifi_ap;

static lv_obj_t *create_text(lv_obj_t *parent, const char *icon, const char *txt,
                             lv_menu_builder_variant_t builder_variant)
{
    lv_obj_t *obj = lv_menu_cont_create(parent);

    lv_obj_t *img = NULL;
    lv_obj_t *label = NULL;

    if (icon)
    {
        img = lv_img_create(obj);
        lv_img_set_src(img, icon);
    }

    if (txt)
    {
        label = lv_label_create(obj);
        lv_label_set_text(label, txt);
        lv_label_set_long_mode(label, LV_LABEL_LONG_SCROLL_CIRCULAR);
        lv_obj_set_flex_grow(label, 1);
    }

    if (builder_variant == LV_MENU_ITEM_BUILDER_VARIANT_2 && icon && txt)
    {
        lv_obj_add_flag(img, LV_OBJ_FLAG_FLEX_IN_NEW_TRACK);
        lv_obj_swap(img, label);
    }

    return obj;
}



static lv_obj_t *create_switch(lv_obj_t *parent, const char *icon, const char *txt, bool chk)
{
    lv_obj_t *obj = create_text(parent, icon, txt, LV_MENU_ITEM_BUILDER_VARIANT_1);

    lv_obj_t *sw = lv_switch_create(obj);
    lv_obj_add_state(sw, chk ? LV_STATE_CHECKED : 0);

    return obj;
}

static void sw_event_handler(lv_event_t *e)
{
    lv_event_code_t code = lv_event_get_code(e);
    lv_obj_t *obj = lv_event_get_target(e);
    uint8_t wifi_mode = 0; // 0--关闭  1--sta模式 2--ap模式 3--STA+AP模式
    if (code == LV_EVENT_VALUE_CHANGED)
    {
        if (lv_obj_has_state(obj, LV_STATE_CHECKED))
            wifi_mode = 1;
        else
            wifi_mode = 0;
        if (g_wifi_mode_change_cb)
        {
            g_wifi_mode_change_cb(wifi_mode);
        }
        LV_LOG_USER("mode: %d\n", wifi_mode);
    }
}

void wifi_set_mode_change_cb(wifi_mode_change_cb cb)
{
    g_wifi_mode_change_cb = cb;
}

void wifi_tab_create(lv_obj_t *tab)
{
    lv_obj_t *section;
    lv_obj_t *menu = lv_menu_create(tab);

    lv_color_t bg_color = lv_obj_get_style_bg_color(menu, 0);
    if (lv_color_brightness(bg_color) > 127)
    {
        lv_obj_set_style_bg_color(menu, lv_color_darken(lv_obj_get_style_bg_color(menu, 0), 10), 0);
    }
    else
    {
        lv_obj_set_style_bg_color(menu, lv_color_darken(lv_obj_get_style_bg_color(menu, 0), 50), 0);
    }

    lv_obj_set_size(menu, lv_pct(100), lv_pct(100));
    lv_obj_center(menu);

    lv_obj_t *cont;
    lv_obj_t *label;

    /*Create a main page*/
    lv_obj_t *main_page = lv_menu_page_create(menu, NULL);
    // lv_obj_set_style_pad_left(main_page, 10, _LV_STYLE_STATE_CMP_SAME);
    // lv_obj_set_style_pad_right(main_page, 5, _LV_STYLE_STATE_CMP_SAME);
    lv_obj_set_style_bg_opa(main_page, LV_OPA_0, LV_PART_SCROLLBAR | LV_STATE_DEFAULT);
    lv_obj_set_style_bg_opa(main_page, LV_OPA_0, LV_PART_SCROLLBAR | LV_STATE_SCROLLED);
    // lv_obj_set_size(main_page, lv_pct(80), lv_pct(100));

    

    create_text(main_page, NULL, "WiFi STA Setting", LV_MENU_ITEM_BUILDER_VARIANT_1);
    section = lv_menu_section_create(main_page);
    lv_obj_t *obj = create_text(section, NULL, "IP", LV_MENU_ITEM_BUILDER_VARIANT_1);
    label_wifi_sta_ip = lv_label_create(obj);
    lv_label_set_text(label_wifi_sta_ip, "0.0.0.0");

    obj = create_text(section, NULL, "SSID", LV_MENU_ITEM_BUILDER_VARIANT_1);
    label_wifi_sta_ssid = lv_label_create(obj);
    lv_label_set_text(label_wifi_sta_ssid, "---");

    obj = create_text(section, NULL, "PASS", LV_MENU_ITEM_BUILDER_VARIANT_1);
    label_wifi_sta_pass = lv_label_create(obj);
    lv_label_set_text(label_wifi_sta_pass, "---");

    obj = create_text(section, NULL, "WiFi STA", LV_MENU_ITEM_BUILDER_VARIANT_1);
    sw_wifi_sta = lv_switch_create(obj);
    lv_obj_add_state(sw_wifi_sta, LV_STATE_CHECKED);
    lv_obj_add_event_cb(sw_wifi_sta, sw_event_handler, LV_EVENT_ALL, NULL);


    // create_text(main_page, NULL, "WiFi AP Setting", LV_MENU_ITEM_BUILDER_VARIANT_1);
    // section = lv_menu_section_create(main_page);
    // obj = create_text(section, NULL, "IP", LV_MENU_ITEM_BUILDER_VARIANT_1);
    // label_wifi_ap_ip = lv_label_create(obj);
    // lv_label_set_text(label_wifi_ap_ip, "192.168.4.1");

    // obj = create_text(section, NULL, "SSID", LV_MENU_ITEM_BUILDER_VARIANT_1);
    // label_wifi_ap_ssid = lv_label_create(obj);
    // lv_label_set_text(label_wifi_ap_ssid, "---");

    // obj = create_text(section, NULL, "PASS", LV_MENU_ITEM_BUILDER_VARIANT_1);
    // label_wifi_ap_pass = lv_label_create(obj);
    // lv_label_set_text(label_wifi_ap_pass, "---");

    // obj = create_text(section, NULL, "WiFi AP", LV_MENU_ITEM_BUILDER_VARIANT_1);
    // sw_wifi_ap = lv_switch_create(obj);
    // lv_obj_add_state(sw_wifi_ap, LV_STATE_DEFAULT);
    // lv_obj_add_event_cb(sw_wifi_ap, sw_event_handler, LV_EVENT_ALL, NULL);

    lv_menu_set_page(menu, main_page);
}