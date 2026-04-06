#pragma once

/**
 * FontAwesome 6 Solid icons for LVGL 8.
 * Generated with lv_font_conv from fa-solid-900.ttf.
 * Available in sizes 20, 28, and 40.
 */

#include "lvgl.h"

// Font declarations (defined in .c files)
LV_FONT_DECLARE(fa_icons_20);
LV_FONT_DECLARE(fa_icons_28);
LV_FONT_DECLARE(fa_icons_40);

// Icon UTF-8 string defines
#define FA_ROBOT     "\xEF\x95\x84"   // U+F544 — robot head (mower)
#define FA_LEAF      "\xEF\x81\xAC"   // U+F06C — leaf (grass/garden)
#define FA_BOLT      "\xEF\x83\xA7"   // U+F0E7 — lightning bolt (charger)
#define FA_SIGNAL    "\xEF\x80\x92"   // U+F012 — signal bars (connectivity)
#define FA_DOWNLOAD  "\xEF\x80\x99"   // U+F019 — download arrow (firmware)
#define FA_WRENCH    "\xEF\x82\xAD"   // U+F0AD — wrench (provisioning)
#define FA_HOUSE     "\xEF\x80\x95"   // U+F015 — house (home network)
#define FA_GEAR      "\xEF\x80\x93"   // U+F013 — gear (settings)
