/**
 * The Novabot 3D model (the one the Terrain view shows), drawn onto a small
 * canvas from the angled render's camera: south of the plot, 55° above it,
 * looking north (see tiltCamera in server/src/services/gardenRender.ts). So the
 * mower on the render is seen from the same side as the garden around it.
 *
 * Imported dynamically: three.js and the 3.8 MB model only load once someone
 * opens an angled render.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/** Same elevation as the server's tiltCamera. */
const ELEVATION = (55 * Math.PI) / 180;
/** The GLB's nose points along -X; Terrain uses the same correction. */
const YAW_OFFSET = Math.PI;
/** Real mower length, and how much of the canvas's width that takes. */
const LENGTH_M = 0.66;
const HALF_VIEW_M = LENGTH_M * 0.9;

let model: Promise<THREE.Object3D> | null = null;

/** The model Z-up, 0.66 m long, centred on the origin with its wheels on z=0. */
function loadModel(): Promise<THREE.Object3D> {
  model ??= new Promise<THREE.Object3D>((resolve, reject) => {
    new GLTFLoader().load('/models/novabot.glb', gltf => {
      const zUp = new THREE.Group();
      zUp.rotation.x = Math.PI / 2;
      zUp.add(gltf.scene);
      const holder = new THREE.Group();
      holder.add(zUp);
      const size = new THREE.Box3().setFromObject(holder).getSize(new THREE.Vector3());
      holder.scale.setScalar(LENGTH_M / Math.max(size.x, 1e-6));
      holder.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(holder);
      const c = box.getCenter(new THREE.Vector3());
      holder.position.set(-c.x, -c.y, -box.min.z);
      const out = new THREE.Group();
      out.add(holder);
      resolve(out);
    }, undefined, reject);
  });
  return model;
}

export interface MowerSprite {
  /** Redraw facing `heading` (ENU radians, 0 = east). */
  draw(heading: number): void;
  dispose(): void;
}

export async function createMowerSprite(canvas: HTMLCanvasElement, night: boolean): Promise<MowerSprite> {
  const mower = (await loadModel()).clone(true);
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  // Fixed drawing buffer; CSS scales the canvas with the picture's zoom.
  renderer.setSize(canvas.width, canvas.height, false);

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445544, night ? 1.4 : 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, night ? 0.8 : 1.6);
  sun.position.set(-1, -2, 4);
  scene.add(sun);
  const yaw = new THREE.Group();
  yaw.add(mower);
  scene.add(yaw);

  const camera = new THREE.OrthographicCamera(-HALF_VIEW_M, HALF_VIEW_M, HALF_VIEW_M, -HALF_VIEW_M, 0.1, 20);
  camera.up.set(0, 0, 1);
  camera.position.set(0, -5 * Math.cos(ELEVATION), 5 * Math.sin(ELEVATION));
  camera.lookAt(0, 0, 0);

  return {
    draw(heading) {
      yaw.rotation.z = heading + YAW_OFFSET;
      renderer.render(scene, camera);
    },
    dispose() {
      renderer.dispose();
    },
  };
}
