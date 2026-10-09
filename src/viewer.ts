import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { BinResult, PlacedItem } from './types';

// Unit cube edges, reused for every item outline.
const EDGES = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)).getAttribute('position').array as Float32Array;

/**
 * Renders one bin. Items are a single InstancedMesh and their outlines a
 * single LineSegments buffer, so a few thousand items stay cheap. Y is up,
 * matching the library (height axis vertical).
 */
export class Viewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100_000);
  private controls: OrbitControls;
  private root = new THREE.Group();
  private mesh: THREE.InstancedMesh | null = null;
  private outlines: THREE.LineSegments | null = null;
  private highlight: THREE.LineSegments;
  private raycaster = new THREE.Raycaster();
  private bin: BinResult | null = null;
  private visible = 0;
  private frame = 0;

  onHover: (item: PlacedItem | null, x: number, y: number) => void = () => {};

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x30302e, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(0.6, 1, 0.8);
    this.scene.add(sun, this.root);

    const hl = new THREE.BufferGeometry();
    hl.setAttribute('position', new THREE.BufferAttribute(EDGES, 3));
    this.highlight = new THREE.LineSegments(hl, new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true }));
    this.highlight.renderOrder = 10;
    this.highlight.visible = false;
    this.root.add(this.highlight);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener('change', () => this.render());

    new ResizeObserver(() => this.resize()).observe(host);
    this.renderer.domElement.addEventListener('pointermove', (e) => this.pick(e));
    this.renderer.domElement.addEventListener('pointerleave', () => this.hover(null, 0, 0));
    this.resize();
  }

  show(bin: BinResult | null, color: (it: PlacedItem) => string, keepCamera = false): void {
    this.clear();
    this.bin = bin;
    this.visible = bin?.items.length ?? 0;
    if (!bin) return this.render();

    const { w, h, d } = bin;
    this.root.position.set(-w / 2, 0, -d / 2);

    // Container: outline and a faint floor.
    const box = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)),
      new THREE.LineBasicMaterial({ color: 0x8a8984, transparent: true, opacity: 0.7 }),
    );
    box.position.set(w / 2, h / 2, d / 2);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(w, d),
      new THREE.MeshBasicMaterial({ color: 0x3a3a37, transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(w / 2, -0.001 * Math.max(w, h, d), d / 2);
    box.userData.container = floor.userData.container = true;
    this.root.add(box, floor);

    // Items, shrunk by a hair so neighbours read as separate boxes.
    const n = bin.items.length;
    const gap = Math.max(w, h, d) * 0.0015;
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshLambertMaterial({ polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
      Math.max(n, 1),
    );
    const edges = new Float32Array(n * EDGES.length);
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    bin.items.forEach((it, i) => {
      const sx = Math.max(it.w - 2 * gap, it.w * 0.5);
      const sy = Math.max(it.h - 2 * gap, it.h * 0.5);
      const sz = Math.max(it.d - 2 * gap, it.d * 0.5);
      const cx = it.x + it.w / 2;
      const cy = it.y + it.h / 2;
      const cz = it.z + it.d / 2;
      m.makeScale(sx, sy, sz).setPosition(cx, cy, cz);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, c.set(color(it)));
      for (let k = 0; k < EDGES.length; k += 3) {
        edges[i * EDGES.length + k] = cx + EDGES[k] * sx;
        edges[i * EDGES.length + k + 1] = cy + EDGES[k + 1] * sy;
        edges[i * EDGES.length + k + 2] = cz + EDGES[k + 2] * sz;
      }
    });
    mesh.count = n;
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.BufferAttribute(edges, 3));
    this.outlines = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0x141413, transparent: true, opacity: 0.55 }));
    this.mesh = mesh;
    this.root.add(mesh, this.outlines);

    if (!keepCamera) this.fit();
    this.render();
  }

  recolor(color: (it: PlacedItem) => string): void {
    if (!this.mesh || !this.bin) return;
    const c = new THREE.Color();
    this.bin.items.forEach((it, i) => this.mesh!.setColorAt(i, c.set(color(it))));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.render();
  }

  /** Shows only the first n items, in placement order. */
  setVisible(n: number): void {
    if (!this.mesh || !this.outlines || !this.bin) return;
    this.visible = Math.max(0, Math.min(n, this.bin.items.length));
    this.mesh.count = this.visible;
    this.outlines.geometry.setDrawRange(0, this.visible * (EDGES.length / 3));
    this.highlight.visible = false;
    this.render();
  }

  fit(): void {
    if (!this.bin) return;
    const { w, h, d } = this.bin;
    const radius = Math.hypot(w, h, d) / 2;
    const dist = (radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 1.05;
    const dir = new THREE.Vector3(0.95, 0.75, 1.25).normalize();
    this.controls.target.set(0, h / 2, 0);
    this.camera.position.copy(dir.multiplyScalar(dist)).add(this.controls.target);
    this.camera.near = dist / 100;
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.render();
  }

  private pick(e: PointerEvent): void {
    if (!this.mesh || !this.bin || e.buttons) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const p = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(p, this.camera);
    const hit = this.raycaster.intersectObject(this.mesh, false)[0];
    const it = hit?.instanceId !== undefined && hit.instanceId < this.visible ? this.bin.items[hit.instanceId] : null;
    this.hover(it, e.clientX - rect.left, e.clientY - rect.top);
  }

  private hover(it: PlacedItem | null, x: number, y: number): void {
    if (it) {
      this.highlight.scale.set(it.w, it.h, it.d);
      this.highlight.position.set(it.x + it.w / 2, it.y + it.h / 2, it.z + it.d / 2);
    }
    if (this.highlight.visible !== !!it || it) {
      this.highlight.visible = !!it;
      this.render();
    }
    this.onHover(it, x, y);
  }

  private clear(): void {
    this.highlight.visible = false;
    for (const child of [...this.root.children]) {
      if (child === this.highlight) continue;
      this.root.remove(child);
      const o = child as THREE.Mesh;
      o.geometry?.dispose();
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((mat) => mat?.dispose());
    }
    this.mesh?.dispose();
    this.mesh = null;
    this.outlines = null;
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  private render(): void {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.renderer.render(this.scene, this.camera));
  }
}
