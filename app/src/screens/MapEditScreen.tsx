import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { GestureDetector, Gesture, GestureHandlerRootView } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import Svg, { Circle, Polygon, Polyline } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRoute, useNavigation } from '@react-navigation/native';
import { useI18n } from '../i18n';
import { useTheme } from '../theme';
import { ApiClient, isUnsupportedFirmwareError, type MapEditEntryDto } from '../services/api';
import { getServerUrl } from '../services/auth';
import { useMowerState } from '../hooks/useMowerState';
import { isOpenNovaFirmware } from '../utils/firmwareCapability';
import {
  applyBrush,
  densifyPolygon,
  hitTestEdge,
  hitTestVertex,
  pointInPolygon,
  type XY,
} from '../utils/mapEditGeometry';

type Tool = 'vertex' | 'brush' | 'draw';

interface EditPoly {
  localId: string;
  canonical: string | null;
  mapType: string;
  parentMap: string | null;
  original: XY[];
  points: XY[];
  deleted: boolean;
  isNew: boolean;
}

const PADDING = 24;

// Reserve vertical space for the header (~56), toolbar (~56), status (~26) and
// bottom action bar (~70). The rest is the drawing canvas.
const CHROME_HEIGHT = 220;

export default function MapEditScreen() {
  const route = useRoute();
  const navigation = useNavigation();
  const { t } = useI18n();
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();

  const params = route.params as { sn?: string } | undefined;
  const sn = params?.sn ?? '';
  // Apply pushes the edited bundle through extended_commands.py, which only
  // exists on OpenNova custom firmware. Drafting stays possible on stock.
  const { devices } = useMowerState();
  const mowerDev = devices.get(sn);
  const stockFw = !!mowerDev && !isOpenNovaFirmware(mowerDev.firmwareVersion);

  const { width: winW, height: winH } = useWindowDimensions();
  const viewW = winW;
  const viewH = Math.max(240, winH - CHROME_HEIGHT - insets.top - insets.bottom);

  const [polys, setPolys] = useState<EditPoly[]>([]);
  // Mirror of polys for reading inside async save chains (canonical backfill).
  const polysRef = useRef<EditPoly[]>([]);
  const [tool, setTool] = useState<Tool>('vertex');
  const [selected, setSelected] = useState(-1);
  const [brushRadius, setBrushRadius] = useState(0.8);
  const [drawPoints, setDrawPoints] = useState<XY[]>([]);
  const [unicoms, setUnicoms] = useState<XY[][]>([]);
  const [status, setStatus] = useState('');
  const [pendingSync, setPendingSync] = useState(false);
  const [hasVersions, setHasVersions] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // user pinch/pan on top of the fit transform
  const [view, setView] = useState({ scale: 1, tx: 0, ty: 0 });
  const dragRef = useRef<{
    vertex: number;
    brushAnchor: XY | null;
    brushBase: XY[] | null;
    startView: { scale: number; tx: number; ty: number };
  }>({ vertex: -1, brushAnchor: null, brushBase: null, startView: view });
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep a ref to the last save promise so apply/reset can await in-flight saves.
  const lastSaveRef = useRef<Promise<unknown>>(Promise.resolve());
  // The not-yet-fired debounced edit. flushSaves fires this immediately so an
  // edit followed by Apply within the debounce window is never dropped.
  const pendingSaveRef = useRef<EditPoly | null>(null);
  // localIds of polys whose create PUT is in flight, so a delete/edit chains
  // behind the create (reads the backfilled canonical) instead of re-creating.
  const inFlightCreateRef = useRef<Set<string>>(new Set());
  // localId → canonical, backfilled synchronously when a create resolves. Read
  // inside chained saves because polysRef (driven by a useEffect) may lag a tick.
  const canonicalByLocalId = useRef<Map<string, string>>(new Map());
  // Monotonic counter for stable local ids (avoids Date.now() collisions).
  const localIdCounter = useRef(0);
  const nextLocalId = useCallback(() => `lp_${++localIdCounter.current}_${Date.now()}`, []);

  // Construct an ApiClient fresh each call (mirrors MapScreen — there is no
  // useApi() context).
  const getApi = useCallback(async () => new ApiClient((await getServerUrl()) ?? ''), []);

  const load = useCallback(async () => {
    if (!sn) { setStatus(t('mapEditOffline')); setLoading(false); return; }
    const api = await getApi();
    const g = await api.getMapEditGeometry(sn);
    setPolys(
      g.maps
        .filter((m: MapEditEntryDto) => m.mapType !== 'unicom')
        .map((m: MapEditEntryDto) => ({
          localId: nextLocalId(),
          canonical: m.canonical,
          mapType: m.mapType,
          parentMap: m.parentMap,
          original: m.points,
          points: m.draft && !m.draft.deleted ? [...m.draft.points] : [...m.points],
          deleted: !!m.draft?.deleted,
          isNew: !!m.draft?.isNew,
        })),
    );
    // Faint, read-only unicom polygons for context (not editable).
    setUnicoms(
      g.maps
        .filter((m: MapEditEntryDto) => m.mapType === 'unicom' && m.points.length >= 2)
        .map((m: MapEditEntryDto) => m.points),
    );
    setPendingSync(g.pendingSync);
    setHasVersions(g.hasVersions);
    setSelected(-1);
    setDrawPoints([]);
    setLoading(false);
  }, [getApi, sn, t, nextLocalId]);

  useEffect(() => {
    load().catch((e) => {
      setStatus(e instanceof Error ? e.message : String(e));
      setLoading(false);
    });
  }, [load]);

  // Keep polysRef current so async save chains read the latest canonical/points.
  useEffect(() => {
    polysRef.current = polys;
  }, [polys]);

  // ── Projection: meters → screen (fit + user view), and back ──
  const fit = useMemo(() => {
    const all = polys
      .flatMap((p) => (p.deleted ? [] : p.points))
      .concat(polys.flatMap((p) => p.original))
      .concat(unicoms.flat());
    if (all.length === 0) return { minX: 0, maxY: 0, scale: 1 };
    const minX = Math.min(...all.map((p) => p.x));
    const maxX = Math.max(...all.map((p) => p.x));
    const minY = Math.min(...all.map((p) => p.y));
    const maxY = Math.max(...all.map((p) => p.y));
    const scale = Math.min(
      (viewW - 2 * PADDING) / Math.max(maxX - minX, 1),
      (viewH - 2 * PADDING) / Math.max(maxY - minY, 1),
    );
    return { minX, maxY, scale };
  }, [polys, unicoms, viewW, viewH]);

  const toPx = useCallback(
    (p: XY) => ({
      x: (PADDING + (p.x - fit.minX) * fit.scale) * view.scale + view.tx,
      y: (PADDING + (fit.maxY - p.y) * fit.scale) * view.scale + view.ty,
    }),
    [fit, view],
  );
  const toM = useCallback(
    (px: number, py: number): XY => ({
      x: fit.minX + ((px - view.tx) / view.scale - PADDING) / fit.scale,
      y: fit.maxY - ((py - view.ty) / view.scale - PADDING) / fit.scale,
    }),
    [fit, view],
  );
  // 22pt touch tolerance, converted to meters at current zoom.
  const hitTolM = 22 / (fit.scale * view.scale);

  // ── Draft persistence (debounced + serialized) ──
  // Run the actual save, chained onto lastSaveRef so saves never overlap. The
  // request body is built INSIDE the chained .then() and the poly is re-read by
  // localId from polysRef, so it always picks up a canonical that an earlier
  // (chained) create backfilled into state — preventing duplicate creates and
  // orphan deletes.
  const runSave = useCallback(
    (target: EditPoly): Promise<void> => {
      const localId = target.localId;
      const alreadyCanonical = !!(target.canonical || canonicalByLocalId.current.get(localId));
      const isCreate = !alreadyCanonical && !target.deleted;
      if (isCreate) inFlightCreateRef.current.add(localId);
      const p = lastSaveRef.current
        .catch(() => {})
        .then(async () => {
          // Re-read the latest poly state so we use the backfilled canonical.
          const cur = polysRef.current.find((q) => q.localId === localId) ?? target;
          // A canonical backfilled by an earlier chained create may not have
          // reached polysRef yet (useEffect lag) — prefer the synchronous map.
          const canonical = cur.canonical ?? canonicalByLocalId.current.get(localId) ?? null;
          // Deleted-before-created and never persisted → nothing to do on server.
          if (cur.deleted && !canonical) return;
          try {
            const api = await getApi();
            const body = cur.deleted
              ? { canonical: canonical!, deleted: true }
              : canonical
                ? { canonical, points: cur.points }
                : {
                    mapType: 'obstacle' as const,
                    parentMap: cur.parentMap ?? 'map0',
                    points: cur.points,
                  };
            const r = await api.saveMapEditDraft(sn, body);
            // Backfill canonical for a freshly-created obstacle into React state
            // (by localId) so subsequent edits/deletes target the real id.
            if (r.canonical && !canonical) {
              const newCanonical: string = r.canonical;
              canonicalByLocalId.current.set(localId, newCanonical);
              setPolys((prev) =>
                prev.map((q) => (q.localId === localId ? { ...q, canonical: newCanonical } : q)),
              );
              setStatus(`✓ ${newCanonical}`.trim());
            } else {
              setStatus(`✓ ${canonical ?? ''}`.trim());
            }
          } catch (e) {
            setStatus(e instanceof Error ? e.message : String(e));
          } finally {
            if (isCreate) inFlightCreateRef.current.delete(localId);
          }
        });
      lastSaveRef.current = p;
      return p;
    },
    [getApi, sn],
  );

  const persistDraft = useCallback(
    (poly: EditPoly) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      // Remember the not-yet-fired edit so flushSaves can fire it immediately.
      pendingSaveRef.current = poly;
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        const pending = pendingSaveRef.current;
        pendingSaveRef.current = null;
        if (pending) runSave(pending);
      }, 800);
    },
    [runSave],
  );

  // Fire any pending (debounced) save immediately, then await BOTH it and any
  // in-flight save before a destructive/network op.
  const flushSaves = useCallback(async (): Promise<void> => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const pending = pendingSaveRef.current;
    pendingSaveRef.current = null;
    if (pending) runSave(pending);
    await (lastSaveRef.current || Promise.resolve()).catch(() => {});
  }, [runSave]);

  // Cancel the pending (not-yet-fired) edit WITHOUT firing it, but still await
  // any already-in-flight save so it can't land after a subsequent DELETE.
  const cancelPendingSave = useCallback(async (): Promise<void> => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    pendingSaveRef.current = null;
    await (lastSaveRef.current || Promise.resolve()).catch(() => {});
  }, []);

  // Select a polygon at point m: prefer an edge hit (tight tol), else fall back
  // to an interior hit so tapping inside a polygon selects it too.
  const findPolyAt = useCallback(
    (m: XY): number => {
      const edge = polys.findIndex((p) => !p.deleted && hitTestEdge(p.points, m, hitTolM));
      if (edge >= 0) return edge;
      return polys.findIndex((p) => !p.deleted && p.points.length >= 3 && pointInPolygon(m, p.points));
    },
    [polys, hitTolM],
  );

  // ── Touch handlers (JS side, driven by gestures via runOnJS) ──
  const onTouchStart = useCallback(
    (px: number, py: number) => {
      const m = toM(px, py);
      if (tool === 'vertex') {
        if (selected >= 0) {
          const vi = hitTestVertex(polys[selected].points, m, hitTolM);
          if (vi >= 0) {
            dragRef.current.vertex = vi;
            return;
          }
        }
        setSelected(findPolyAt(m));
      } else if (tool === 'brush') {
        const idx = polys.findIndex(
          (p) => !p.deleted && hitTestEdge(p.points, m, brushRadius * 2),
        );
        if (idx >= 0) {
          setSelected(idx);
          dragRef.current.brushAnchor = m;
          dragRef.current.brushBase = densifyPolygon(polys[idx].points, brushRadius / 4);
        }
      }
    },
    [tool, selected, polys, toM, hitTolM, brushRadius, findPolyAt],
  );

  const onTouchMove = useCallback(
    (px: number, py: number) => {
      const m = toM(px, py);
      const d = dragRef.current;
      if (tool === 'vertex' && d.vertex >= 0 && selected >= 0) {
        setPolys((prev) =>
          prev.map((p, i) =>
            i === selected
              ? { ...p, points: p.points.map((q, qi) => (qi === d.vertex ? m : q)) }
              : p,
          ),
        );
      } else if (tool === 'brush' && d.brushAnchor && d.brushBase && selected >= 0) {
        const delta = { x: m.x - d.brushAnchor.x, y: m.y - d.brushAnchor.y };
        const moved = applyBrush(d.brushBase, d.brushAnchor, delta, brushRadius);
        setPolys((prev) => prev.map((p, i) => (i === selected ? { ...p, points: moved } : p)));
      }
    },
    [tool, selected, toM, brushRadius],
  );

  const onTouchEnd = useCallback(() => {
    const d = dragRef.current;
    const wasEditing =
      (tool === 'vertex' && d.vertex >= 0) || (tool === 'brush' && d.brushAnchor);
    d.vertex = -1;
    d.brushAnchor = null;
    d.brushBase = null;
    if (wasEditing && selected >= 0) {
      // Read current points from state by selecting on the next tick — but we
      // already mutate via setPolys, so persist using a functional read.
      setPolys((prev) => {
        if (selected >= 0 && prev[selected]) persistDraft(prev[selected]);
        return prev;
      });
    }
  }, [tool, selected, persistDraft]);

  const onLongPressDeleteVertex = useCallback(
    (px: number, py: number) => {
      if (tool !== 'vertex' || selected < 0) return;
      const m = toM(px, py);
      const vi = hitTestVertex(polys[selected].points, m, hitTolM);
      if (vi < 0) return;
      if (polys[selected].points.length <= 3) return; // keep at least a triangle
      const next = {
        ...polys[selected],
        points: polys[selected].points.filter((_, qi) => qi !== vi),
      };
      setPolys((prev) => prev.map((p, i) => (i === selected ? next : p)));
      persistDraft(next);
    },
    [tool, selected, polys, toM, hitTolM, persistDraft],
  );

  const onTap = useCallback(
    (px: number, py: number) => {
      const m = toM(px, py);
      if (tool === 'draw') {
        setDrawPoints((prev) => [...prev, m]);
        return;
      }
      if (tool === 'vertex' && selected >= 0) {
        // Tap on an edge inserts a vertex there.
        const hit = hitTestEdge(polys[selected].points, m, hitTolM);
        if (hit) {
          const pts = polys[selected].points.slice();
          pts.splice(hit.insertIndex, 0, hit.point);
          const next = { ...polys[selected], points: pts };
          setPolys((prev) => prev.map((p, i) => (i === selected ? next : p)));
          persistDraft(next);
          return;
        }
      }
      // Otherwise treat the tap as a selection change (edge or interior hit).
      setSelected(findPolyAt(m));
    },
    [tool, selected, polys, toM, hitTolM, persistDraft, findPolyAt],
  );

  const closeDrawnObstacle = useCallback(() => {
    if (drawPoints.length < 3) {
      setStatus(t('mapEditDrawHint'));
      return;
    }
    const parent = polys.find((p) => p.mapType === 'work' && !p.deleted);
    const poly: EditPoly = {
      localId: nextLocalId(),
      canonical: null,
      mapType: 'obstacle',
      parentMap: parent?.canonical ?? 'map0',
      original: [],
      points: drawPoints,
      deleted: false,
      isNew: true,
    };
    setPolys((prev) => [...prev, poly]);
    setDrawPoints([]);
    setTool('vertex');
    persistDraft(poly);
  }, [drawPoints, polys, persistDraft, t, nextLocalId]);

  // ── Gestures ──
  // Single-finger pan drives vertex/brush editing; tap selects / places points;
  // long-press deletes a vertex. Two-finger pinch + pan drive the view.
  const pan = Gesture.Pan()
    .minPointers(1)
    .maxPointers(1)
    .onBegin((e) => {
      runOnJS(onTouchStart)(e.x, e.y);
    })
    .onUpdate((e) => {
      runOnJS(onTouchMove)(e.x, e.y);
    })
    .onEnd(() => {
      runOnJS(onTouchEnd)();
    });
  const tap = Gesture.Tap().maxDuration(250).onEnd((e) => {
    runOnJS(onTap)(e.x, e.y);
  });
  const longPress = Gesture.LongPress()
    .minDuration(450)
    .onStart((e) => {
      runOnJS(onLongPressDeleteVertex)(e.x, e.y);
    });
  const pinch = Gesture.Pinch()
    .onBegin(() => {
      dragRef.current.startView = view;
    })
    .onUpdate((e) => {
      const sv = dragRef.current.startView;
      runOnJS(setView)({
        scale: Math.max(0.5, Math.min(8, sv.scale * e.scale)),
        tx: sv.tx,
        ty: sv.ty,
      });
    });
  const twoFingerPan = Gesture.Pan()
    .minPointers(2)
    .onBegin(() => {
      dragRef.current.startView = view;
    })
    .onUpdate((e) => {
      const sv = dragRef.current.startView;
      runOnJS(setView)({ scale: sv.scale, tx: sv.tx + e.translationX, ty: sv.ty + e.translationY });
    });
  const gestures = Gesture.Race(
    Gesture.Simultaneous(pinch, twoFingerPan),
    Gesture.Exclusive(longPress, tap, pan),
  );

  // ── Actions ──
  const doApply = useCallback(() => {
    Alert.alert(t('mapEditTitle'), t('mapEditConfirmApply'), [
      { text: t('cancel') || 'Cancel', style: 'cancel' },
      {
        text: 'OK',
        onPress: async () => {
          setBusy(true);
          setStatus('…');
          try {
            await flushSaves();
            const api = await getApi();
            const r = await api.applyMapEdits(sn);
            if (r.ok) {
              const warns = (r.validation?.warnings ?? [])
                .map((w) => `⚠ ${w.message}`)
                .join('\n');
              setStatus(warns ? `${t('mapEditApplied')}\n${warns}` : t('mapEditApplied'));
              await load();
            } else if (r.reason === 'busy') setStatus(t('mapEditBusy'));
            else if (r.reason === 'offline') setStatus(t('mapEditOffline'));
            else if (r.reason === 'locked') setStatus(t('mapEditLocked'));
            else if (r.reason === 'no_changes') setStatus(t('mapEditNoChanges'));
            else if (r.reason === 'validation') {
              setStatus(
                (r.validation?.errors ?? [])
                  .map((e) => `${e.canonical}: ${e.message}`)
                  .join('\n') || 'Validation failed',
              );
            } else if (r.reason === 'push_failed' || r.reason === 'bundle_failed') {
              setStatus(t('mapEditPushFailed'));
              setPendingSync(true);
            } else if (r.reason === 'unsupported_firmware') setStatus(t('requiresOpenNovaFirmware'));
            else setStatus(r.reason ?? 'error');
          } catch (e) {
            if (isUnsupportedFirmwareError(e)) setStatus(t('requiresOpenNovaFirmware'));
            else setStatus(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  }, [getApi, sn, t, load, flushSaves]);

  const doRevert = useCallback(() => {
    Alert.alert(t('mapEditRevert'), t('mapEditConfirmRevert'), [
      { text: t('cancel') || 'Cancel', style: 'cancel' },
      {
        text: 'OK',
        onPress: async () => {
          setBusy(true);
          try {
            await flushSaves();
            const api = await getApi();
            const r = await api.revertMapEdits(sn);
            if (r.ok) {
              setStatus(t('mapEditApplied'));
              await load();
            } else if (r.reason === 'busy') setStatus(t('mapEditBusy'));
            else if (r.reason === 'offline') setStatus(t('mapEditOffline'));
            else if (r.reason === 'locked') setStatus(t('mapEditLocked'));
            else if (r.reason === 'no_version') setStatus(t('mapEditNoVersion'));
            else if (r.reason === 'push_failed' || r.reason === 'bundle_failed') {
              setStatus(t('mapEditPushFailed'));
              setPendingSync(true);
            } else if (r.reason === 'unsupported_firmware') setStatus(t('requiresOpenNovaFirmware'));
            else setStatus(r.reason ?? 'error');
          } catch (e) {
            if (isUnsupportedFirmwareError(e)) setStatus(t('requiresOpenNovaFirmware'));
            else setStatus(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  }, [getApi, sn, t, load, flushSaves]);

  const doReset = useCallback(() => {
    Alert.alert(t('mapEditReset'), t('mapEditConfirmRevert'), [
      { text: t('cancel') || 'Cancel', style: 'cancel' },
      {
        text: 'OK',
        onPress: async () => {
          setBusy(true);
          try {
            // Reset means "throw away edits": cancel the pending (unfired) save
            // instead of flushing it, but await any already-in-flight save so it
            // can't land on the server after the discard wipes drafts.
            await cancelPendingSave();
            const api = await getApi();
            await api.discardMapEditDrafts(sn);
            canonicalByLocalId.current.clear();
            inFlightCreateRef.current.clear();
            await load();
          } catch (e) {
            setStatus(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  }, [getApi, sn, load, cancelPendingSave, t]);

  const obstacleSelected = selected >= 0 && polys[selected]?.mapType === 'obstacle' && !polys[selected]?.deleted;

  const doDeleteObstacle = useCallback(() => {
    if (selected < 0 || polys[selected]?.mapType !== 'obstacle') return;
    Alert.alert(t('mapEditDeleteObstacle'), t('mapEditDeleteObstacle'), [
      { text: t('cancel') || 'Cancel', style: 'cancel' },
      {
        text: 'OK',
        style: 'destructive',
        onPress: () => {
          const target = polys[selected];
          const localId = target.localId;
          // Resolve canonical from every source — state may lag a backfill that
          // already landed in the synchronous map.
          const knownCanonical = target.canonical ?? canonicalByLocalId.current.get(localId) ?? null;
          const createInFlight = inFlightCreateRef.current.has(localId);
          const createDebounced =
            pendingSaveRef.current?.localId === localId && !pendingSaveRef.current.canonical;

          // Case 1 — only a debounced create is pending (never fired): cancel it
          // and drop the obstacle locally. No create, no delete, no orphan.
          if (!knownCanonical && !createInFlight && createDebounced) {
            if (saveTimer.current) {
              clearTimeout(saveTimer.current);
              saveTimer.current = null;
            }
            pendingSaveRef.current = null;
            setPolys((prev) => prev.filter((p) => p.localId !== localId));
            setSelected(-1);
            return;
          }

          // Case 2 — never created at all on the server (no canonical anywhere,
          // nothing in flight, nothing debounced): pure local removal.
          if (!knownCanonical && !createInFlight && !createDebounced) {
            setPolys((prev) => prev.filter((p) => p.localId !== localId));
            setSelected(-1);
            return;
          }

          // Case 3 — create already in flight, or obstacle already has a
          // canonical: mark deleted and chain the delete. runSave re-reads the
          // backfilled canonical so the DELETE always carries the real id.
          const poly = { ...target, deleted: true };
          setPolys((prev) => prev.map((p) => (p.localId === localId ? poly : p)));
          setSelected(-1);
          persistDraft(poly);
        },
      },
    ]);
  }, [selected, polys, persistDraft, t]);

  const svgPts = (pts: XY[]) =>
    pts
      .map((p) => {
        const q = toPx(p);
        return `${q.x},${q.y}`;
      })
      .join(' ');

  const btn = (bg: string) => ({
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: bg,
  });

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: c.bg }}>
      {/* Header */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          paddingTop: insets.top + 8,
          paddingBottom: 8,
          paddingHorizontal: 12,
        }}
      >
        <TouchableOpacity onPress={() => navigation.goBack()} testID="mapedit-back" hitSlop={8}>
          <Ionicons name="chevron-back" size={24} color={c.text} />
        </TouchableOpacity>
        <Text style={{ color: c.text, fontSize: 18, fontWeight: '700' }}>{t('mapEditTitle')}</Text>
        {busy && <ActivityIndicator size="small" color={c.emerald} />}
      </View>

      {/* Toolbar */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 12, paddingBottom: 8 }}>
        {(['vertex', 'brush', 'draw'] as Tool[]).map((tl) => (
          <TouchableOpacity
            key={tl}
            testID={`mapedit-tool-${tl}`}
            onPress={() => {
              setTool(tl);
              if (tl !== 'draw') setDrawPoints([]);
            }}
            style={{
              paddingHorizontal: 14,
              paddingVertical: 9,
              borderRadius: 10,
              backgroundColor: tool === tl ? c.emerald : c.card,
              borderWidth: 1,
              borderColor: c.cardBorder,
            }}
          >
            <Text style={{ color: tool === tl ? c.white : c.text, fontWeight: '600' }}>
              {t(tl === 'vertex' ? 'mapEditVertex' : tl === 'brush' ? 'mapEditBrush' : 'mapEditDraw')}
            </Text>
          </TouchableOpacity>
        ))}
        {tool === 'brush' && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <TouchableOpacity
              onPress={() => setBrushRadius((r) => Math.max(0.3, +(r - 0.1).toFixed(1)))}
              style={btn(c.card)}
            >
              <Text style={{ color: c.text, fontSize: 16, fontWeight: '700' }}>−</Text>
            </TouchableOpacity>
            <Text style={{ color: c.text, minWidth: 44, textAlign: 'center' }}>
              {brushRadius.toFixed(1)} m
            </Text>
            <TouchableOpacity
              onPress={() => setBrushRadius((r) => Math.min(2, +(r + 0.1).toFixed(1)))}
              style={btn(c.card)}
            >
              <Text style={{ color: c.text, fontSize: 16, fontWeight: '700' }}>+</Text>
            </TouchableOpacity>
          </View>
        )}
        {tool === 'draw' && (
          <TouchableOpacity
            testID="mapedit-close-obstacle"
            onPress={closeDrawnObstacle}
            style={btn('#16a34a')}
          >
            <Text style={{ color: '#fff', fontWeight: '700' }}>{t('mapEditCloseObstacle')}</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Canvas */}
      <GestureDetector gesture={gestures}>
        <View style={{ width: viewW, height: viewH }}>
          {loading ? (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
              <ActivityIndicator size="large" color={c.emerald} />
            </View>
          ) : (
            <Svg width={viewW} height={viewH}>
              {/* Read-only unicom polygons (faint, for context). */}
              {unicoms.map((pts, i) => (
                <Polygon
                  key={`uni-${i}`}
                  points={svgPts(pts)}
                  fill="rgba(148,163,184,0.08)"
                  stroke="rgba(148,163,184,0.4)"
                  strokeWidth={1}
                />
              ))}
              {polys.map((p, i) =>
                p.deleted ? null : (
                  <React.Fragment key={p.canonical ?? `new${i}`}>
                    {/* Ghost original when a draft diverges. */}
                    {!p.isNew && p.original.length >= 3 && (
                      <Polygon
                        points={svgPts(p.original)}
                        fill="none"
                        stroke="rgba(255,255,255,0.35)"
                        strokeDasharray="6 4"
                        strokeWidth={1}
                      />
                    )}
                    <Polygon
                      points={svgPts(p.points)}
                      fill={p.mapType === 'obstacle' ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.10)'}
                      stroke={
                        i === selected ? '#facc15' : p.mapType === 'obstacle' ? '#ef4444' : '#22c55e'
                      }
                      strokeWidth={i === selected ? 3 : 2}
                    />
                    {/* Vertex handles when the vertex tool is active and this poly is selected. */}
                    {tool === 'vertex' &&
                      i === selected &&
                      p.points.map((q, qi) => {
                        const s = toPx(q);
                        return (
                          <React.Fragment key={qi}>
                            {/* Large transparent hit target (≥44pt). */}
                            <Circle cx={s.x} cy={s.y} r={22} fill="rgba(0,0,0,0.001)" />
                            <Circle cx={s.x} cy={s.y} r={8} fill="#fde047" stroke="#000" strokeWidth={1} />
                          </React.Fragment>
                        );
                      })}
                  </React.Fragment>
                ),
              )}
              {/* Draw-in-progress polyline. */}
              {drawPoints.length > 0 && (
                <>
                  <Polyline points={svgPts(drawPoints)} fill="none" stroke="#f87171" strokeWidth={2} />
                  {drawPoints.map((q, qi) => {
                    const s = toPx(q);
                    return <Circle key={`dp-${qi}`} cx={s.x} cy={s.y} r={5} fill="#f87171" />;
                  })}
                </>
              )}
            </Svg>
          )}
        </View>
      </GestureDetector>

      {/* Status line */}
      <Text
        style={{ color: c.textDim, paddingHorizontal: 12, paddingTop: 6, fontSize: 12, minHeight: 26 }}
        numberOfLines={3}
      >
        {tool === 'draw' && drawPoints.length === 0
          ? t('mapEditDrawHint')
          : status || (stockFw ? t('requiresOpenNovaFirmware') : '')}
      </Text>

      {/* Bottom action bar */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8, padding: 12, paddingBottom: insets.bottom + 12 }}
      >
        <TouchableOpacity
          testID="mapedit-delete"
          onPress={doDeleteObstacle}
          disabled={!obstacleSelected || busy}
          style={[btn(c.card), { opacity: obstacleSelected && !busy ? 1 : 0.4, borderWidth: 1, borderColor: c.cardBorder }]}
        >
          <Text style={{ color: '#ef4444', fontWeight: '600' }}>{t('mapEditDeleteObstacle')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="mapedit-reset"
          onPress={doReset}
          disabled={busy}
          style={[btn(c.card), { borderWidth: 1, borderColor: c.cardBorder }]}
        >
          <Text style={{ color: c.text, fontWeight: '600' }}>{t('mapEditReset')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="mapedit-apply"
          onPress={doApply}
          disabled={busy || stockFw}
          style={[btn('#16a34a'), stockFw && { opacity: 0.4 }]}
        >
          <Text style={{ color: '#fff', fontWeight: '700' }}>
            {pendingSync ? t('mapEditResync') : t('mapEditApply')}
          </Text>
        </TouchableOpacity>
        {hasVersions && (
          <TouchableOpacity
            testID="mapedit-revert"
            onPress={doRevert}
            disabled={busy}
            style={[btn(c.card), { borderWidth: 1, borderColor: c.cardBorder }]}
          >
            <Text style={{ color: c.text, fontWeight: '600' }}>{t('mapEditRevert')}</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </GestureHandlerRootView>
  );
}
