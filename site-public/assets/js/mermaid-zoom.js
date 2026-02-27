/**
 * Mermaid Diagram Zoom
 *
 * Click any Mermaid diagram to open it fullscreen with pan & zoom.
 *
 * After rendering, Material for MkDocs replaces <pre class="mermaid">
 * with <div class="mermaid"> and puts the SVG inside a shadow root
 * on that div. The head script (overrides/main.html) forces shadow
 * roots to "open" mode so we can grab the SVG.
 */
(function () {
  "use strict";

  var overlay, scale, panX, panY, isPanning, startX, startY;

  // ── CSS ──
  // Target both pre.mermaid (before render) and div.mermaid (after render)
  var css = document.createElement("style");
  css.textContent = [
    ".mermaid{cursor:zoom-in !important;position:relative}",
    ".mermaid::after{content:'Click to zoom';position:absolute;top:6px;right:8px;font-size:11px;opacity:0;padding:2px 8px;border-radius:4px;background:rgba(0,0,0,.55);color:rgba(255,255,255,.85);font-family:system-ui,sans-serif;pointer-events:none;transition:opacity .2s;z-index:1}",
    ".mermaid:hover::after{opacity:1}",
    "#mz-overlay{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.93);display:flex;flex-direction:column;animation:mz-in .15s ease-out}",
    "@keyframes mz-in{from{opacity:0}to{opacity:1}}",
    ".mz-bar{display:flex;align-items:center;gap:8px;padding:10px 16px;background:rgba(0,0,0,.5);user-select:none;flex-shrink:0}",
    ".mz-hint{color:rgba(255,255,255,.45);font-size:13px;margin-right:auto;font-family:system-ui,sans-serif}",
    ".mz-btn{background:rgba(255,255,255,.12);border:none;color:#fff;min-width:36px;height:36px;border-radius:6px;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s;font-family:system-ui,sans-serif;padding:0 10px}",
    ".mz-btn:hover{background:rgba(255,255,255,.28)}",
    ".mz-wrap{flex:1;overflow:hidden;cursor:grab;display:flex;align-items:center;justify-content:center}",
    ".mz-wrap.grabbing{cursor:grabbing}",
    ".mz-inner{transform-origin:center center}",
    ".mz-inner svg{display:block;max-height:85vh;max-width:95vw}",
  ].join("\n");
  document.head.appendChild(css);

  // ── Find SVG inside a .mermaid element ──
  function findSvg(el) {
    // 1. Check the element itself for a shadow root (Material puts SVG here)
    if (el.shadowRoot) {
      var svg = el.shadowRoot.querySelector("svg");
      if (svg) return svg;
    }
    // 2. Check direct children for shadow roots
    for (var i = 0; i < el.children.length; i++) {
      var child = el.children[i];
      if (child.shadowRoot) {
        var svg = child.shadowRoot.querySelector("svg");
        if (svg) return svg;
      }
    }
    // 3. Fallback: check for SVG directly in the element
    var svg = el.querySelector("svg");
    if (svg) return svg;
    return null;
  }

  // ── Attach click handlers ──
  function attach() {
    // Match both pre.mermaid (before render) and div.mermaid (after render)
    document.querySelectorAll(".mermaid").forEach(function (el) {
      if (el.dataset.mzBound) return;
      el.dataset.mzBound = "1";

      el.addEventListener("click", function (e) {
        if (window.getSelection().toString()) return;
        var svg = findSvg(el);
        if (svg) {
          e.stopPropagation();
          openOverlay(svg.outerHTML);
        }
      });
    });
  }

  // Retry until mermaid has finished rendering
  [1000, 2000, 4000, 6000].forEach(function (ms) { setTimeout(attach, ms); });
  new MutationObserver(function () { setTimeout(attach, 500); })
    .observe(document.documentElement, { childList: true, subtree: true });

  // ── Overlay ──
  function openOverlay(svgHtml) {
    overlay = document.createElement("div");
    overlay.id = "mz-overlay";
    overlay.innerHTML =
      '<div class="mz-bar">' +
      '  <span class="mz-hint">Scroll = zoom · Drag = pan · Double-click = reset</span>' +
      '  <button class="mz-btn mz-fit">Fit</button>' +
      '  <button class="mz-btn mz-close">&times;</button>' +
      '</div>' +
      '<div class="mz-wrap"><div class="mz-inner"></div></div>';

    var inner = overlay.querySelector(".mz-inner");
    inner.innerHTML = svgHtml;

    // Make SVG responsive
    var svg = inner.querySelector("svg");
    if (svg) {
      svg.removeAttribute("style");
      svg.removeAttribute("width");
      svg.removeAttribute("height");
      svg.setAttribute("width", "100%");
      svg.style.maxHeight = "85vh";
      svg.style.maxWidth = "95vw";
    }

    document.body.appendChild(overlay);
    document.body.style.overflow = "hidden";
    scale = 1; panX = 0; panY = 0;

    var wrap = overlay.querySelector(".mz-wrap");

    // Zoom toward cursor
    wrap.addEventListener("wheel", function (e) {
      e.preventDefault();
      var r = wrap.getBoundingClientRect();
      var mx = e.clientX - r.left - r.width / 2;
      var my = e.clientY - r.top - r.height / 2;
      var old = scale;
      scale = clamp(scale * (e.deltaY > 0 ? 0.9 : 1.1), 0.1, 20);
      panX = mx - (mx - panX) * (scale / old);
      panY = my - (my - panY) * (scale / old);
      xf(inner);
    }, { passive: false });

    // Pan
    wrap.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return;
      isPanning = true;
      startX = e.clientX - panX;
      startY = e.clientY - panY;
      wrap.classList.add("grabbing");
      e.preventDefault();
    });
    document.addEventListener("mousemove", mm);
    document.addEventListener("mouseup", mu);

    // Double-click reset
    wrap.addEventListener("dblclick", function () { anim(inner); });

    // Touch
    var ld = 0;
    wrap.addEventListener("touchstart", function (e) {
      if (e.touches.length === 1) { isPanning = true; startX = e.touches[0].clientX - panX; startY = e.touches[0].clientY - panY; }
      else if (e.touches.length === 2) ld = td(e.touches);
      e.preventDefault();
    }, { passive: false });
    wrap.addEventListener("touchmove", function (e) {
      if (e.touches.length === 1 && isPanning) { panX = e.touches[0].clientX - startX; panY = e.touches[0].clientY - startY; xf(inner); }
      else if (e.touches.length === 2) { var d = td(e.touches); if (ld) { scale = clamp(scale * d / ld, 0.1, 20); xf(inner); } ld = d; }
      e.preventDefault();
    }, { passive: false });
    wrap.addEventListener("touchend", function () { isPanning = false; ld = 0; });

    // Buttons
    overlay.querySelector(".mz-close").addEventListener("click", cls);
    overlay.querySelector(".mz-fit").addEventListener("click", function () { anim(inner); });
    overlay.addEventListener("click", function (e) { if (e.target === overlay || e.target === wrap) cls(); });
    document.addEventListener("keydown", kd);
  }

  function xf(el) { el.style.transform = "translate(" + panX + "px," + panY + "px) scale(" + scale + ")"; }
  function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }
  function td(t) { var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY; return Math.sqrt(dx * dx + dy * dy); }
  function anim(el) { scale = 1; panX = 0; panY = 0; el.style.transition = "transform .3s ease"; xf(el); setTimeout(function () { el.style.transition = ""; }, 300); }
  function mm(e) { if (!isPanning || !overlay) return; panX = e.clientX - startX; panY = e.clientY - startY; xf(overlay.querySelector(".mz-inner")); }
  function mu() { isPanning = false; if (overlay) { var w = overlay.querySelector(".mz-wrap"); if (w) w.classList.remove("grabbing"); } }
  function kd(e) { if (e.key === "Escape") cls(); }
  function cls() {
    if (!overlay) return;
    document.removeEventListener("mousemove", mm);
    document.removeEventListener("mouseup", mu);
    document.removeEventListener("keydown", kd);
    overlay.remove(); overlay = null;
    document.body.style.overflow = "";
  }
})();
