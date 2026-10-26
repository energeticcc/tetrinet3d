import * as THREE from "three";
import { Arena } from "./Arena";
import { SPECIALS } from "@tetrinet3d/shared";
import type { SpecialType } from "@tetrinet3d/shared";

/**
 * 3D-Partikel- & Animations-Effekte für die Tetrinet-Specials.
 * (Vorlage: md/Effencts.ts)
 */
export class EffectsManager {
  private scene: THREE.Scene;
  private arena: Arena;
  /** Läuft solange true zurückgibt; `dt` = Delta-Time (Sekunden). */
  private activeAnimations: Array<(dt: number) => boolean> = [];

  constructor(scene: THREE.Scene, arena: Arena) {
    this.scene = scene;
    this.arena = arena;
  }

  /**
   * Haupt-Tick, in der Render-Schleife (main.ts) aufzurufen.
   */
  public tick(deltaTime: number): void {
    this.activeAnimations = this.activeAnimations.filter((t) => t(deltaTime));
  }

  /**
   * Führt die passende Animation für ein Special aus.
   */
  public animateSpecial(type: SpecialType, targetPlayerId: string): void {
    switch (type) {
      case "S":
        this.animateSwitchFields(targetPlayerId);
        break;
      case "O":
        this.animateBlockBomb(targetPlayerId);
        break;
      case "A":
        this.animateAddLine(targetPlayerId);
        break;
      case "C":
      case "N":
        this.animateClearFlash(targetPlayerId);
        break;
      case "B":
        this.animateLightning(targetPlayerId);
        break;
      case "R":
        this.animatePoof(targetPlayerId);
        break;
      case "G":
        this.animateGravityShake(targetPlayerId);
        break;
      case "Q":
        this.animateQuake(targetPlayerId);
        break;
    }
  }

  /* ---------------------------------------------------------------- */
  /* I – Invert Matrix                                                 */
  /* S — Switch Fields (beide Felder tauschen — Flash)             */
  public animateSwitchFields(targetPlayerId: string): void {
    this.animateClearFlash(targetPlayerId); // Gleicher White-Flash wie C/N
  }

  /* ---------------------------------------------------------------- */
  /* O – Block Bomb                                                    */
  /* ---------------------------------------------------------------- */
  public animateBlockBomb(targetPlayerId: string): void {
    const group = this.arena.getGroup(targetPlayerId);
    if (!group) return;

    const particleCount = 80;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    const velocities: THREE.Vector3[] = [];

    const center = new THREE.Vector3();
    group.getWorldPosition(center);

    for (let i = 0; i < particleCount; i++) {
      positions[i * 3] = center.x;
      positions[i * 3 + 1] = center.y;
      positions[i * 3 + 2] = center.z;
      velocities.push(
        new THREE.Vector3(
          (Math.random() - 0.5) * 15,
          (Math.random() - 0.5) * 15,
          (Math.random() - 0.5) * 15,
        ),
      );
    }

    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color: 0xff3300,
      size: 0.4,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
    });
    const particles = new THREE.Points(geometry, material);
    this.scene.add(particles);

    let life = 0;
    const maxLife = 0.9;
    this.activeAnimations.push((dt) => {
      life += dt;
      if (life >= maxLife) {
        this.scene.remove(particles);
        geometry.dispose();
        material.dispose();
        return false;
      }
      const pos = geometry.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < particleCount; i++) {
        pos.setX(i, pos.getX(i) + velocities[i].x * dt);
        pos.setY(i, pos.getY(i) + velocities[i].y * dt);
        pos.setZ(i, pos.getZ(i) + velocities[i].z * dt);
      }
      pos.needsUpdate = true;
      material.opacity = 1 - life / maxLife;
      return true;
    });
  }

  /* ---------------------------------------------------------------- */
  /* A – Add Line (Block "schießt" von unten ins Feld)                 */
  /* ---------------------------------------------------------------- */
  public animateAddLine(targetPlayerId: string): void {
    const group = this.arena.getGroup(targetPlayerId);
    if (!group) return;

    let t = 0;
    const duration = 0.4;
    // NIGHT 17.7 (Bug-Fix „Gegnerische Felder verrutschen"):
    // Vorher wurde position.y ABISOLAT auf 0 gesetzt (Vibration um 0,
    // Reset auf 0) — das riss jedes Gegner-Feld aus seiner Slot-Position
    // (Slot 1/2 bei y=-8.48, Slot 5 bei y=+8.48) und stapelte alle Felder
    // bei y=0 übereinander, während die Labels an der alten Stelle
    // verblieben (Symptom: „Label schwebt, Feld fehlt/liegt falsch").
    // Jetzt: Basis-Position wie bei G/Q (baseY) — vibrieren UM die
    // Slot-Position, danach DORTHIN zurück.
    const baseY = group.position.y;
    this.activeAnimations.push((dt) => {
      t += dt;
      if (t >= duration) {
        group.position.y = baseY;
        return false;
      }
      // Kurzes Vibrieren UM die Slot-Position
      group.position.y = baseY + Math.sin(t * 30) * 0.15 * (1 - t / duration);
      return true;
    });
  }

  /* ---------------------------------------------------------------- */
  /* C / N – Clear / Nuke (Flash)                                      */
  /* ---------------------------------------------------------------- */
  public animateClearFlash(targetPlayerId: string): void {
    const group = this.arena.getGroup(targetPlayerId);
    if (!group) return;

    const light = new THREE.PointLight(0xffffff, 20, 40);
    const center = new THREE.Vector3();
    group.getWorldPosition(center);
    light.position.copy(center);
    this.scene.add(light);

    let t = 0;
    const duration = 0.35;
    this.activeAnimations.push((dt) => {
      t += dt;
      if (t >= duration) {
        this.scene.remove(light);
        light.dispose?.();
        return false;
      }
      light.intensity = 20 * (1 - t / duration);
      return true;
    });
  }

  /* ---------------------------------------------------------------- */
  /* B – Clear Specials (Blitz über dem Raster)                        */
  /* ---------------------------------------------------------------- */
  public animateLightning(targetPlayerId: string): void {
    const group = this.arena.getGroup(targetPlayerId);
    if (!group) return;

    const light = new THREE.PointLight(0x88ffaa, 15, 30);
    const center = new THREE.Vector3();
    group.getWorldPosition(center);
    light.position.copy(center);
    this.scene.add(light);

    let t = 0;
    const duration = 0.25;
    this.activeAnimations.push((dt) => {
      t += dt;
      if (t >= duration) {
        this.scene.remove(light);
        return false;
      }
      light.intensity = 15 * (1 - t / duration) * (Math.random() > 0.5 ? 1 : 0.3);
      return true;
    });
  }

  /* ---------------------------------------------------------------- */
  /* R – Random Blocks Clear (Poof)                                    */
  /* ---------------------------------------------------------------- */
  public animatePoof(targetPlayerId: string): void {
    const group = this.arena.getGroup(targetPlayerId);
    if (!group) return;

    const particleCount = 40;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    const velocities: THREE.Vector3[] = [];

    const center = new THREE.Vector3();
    group.getWorldPosition(center);

    for (let i = 0; i < particleCount; i++) {
      positions[i * 3] = center.x;
      positions[i * 3 + 1] = center.y;
      positions[i * 3 + 2] = center.z;
      velocities.push(
        new THREE.Vector3(
          (Math.random() - 0.5) * 6,
          (Math.random() - 0.5) * 6,
          (Math.random() - 0.5) * 6,
        ),
      );
    }
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color: 0xaaaaaa,
      size: 0.3,
      transparent: true,
      opacity: 1,
    });
    const particles = new THREE.Points(geometry, material);
    this.scene.add(particles);

    let t = 0;
    const max = 0.6;
    this.activeAnimations.push((dt) => {
      t += dt;
      if (t >= max) {
        this.scene.remove(particles);
        geometry.dispose();
        material.dispose();
        return false;
      }
      const pos = geometry.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < particleCount; i++) {
        pos.setX(i, pos.getX(i) + velocities[i].x * dt);
        pos.setY(i, pos.getY(i) + velocities[i].y * dt);
        pos.setZ(i, pos.getZ(i) + velocities[i].z * dt);
      }
      pos.needsUpdate = true;
      material.opacity = 1 - t / max;
      return true;
    });
  }

  /* ---------------------------------------------------------------- */
  /* G – Block Gravity (Kurzes Fallen/Shake)                           */
  /* ---------------------------------------------------------------- */
  public animateGravityShake(targetPlayerId: string): void {
    const group = this.arena.getGroup(targetPlayerId);
    if (!group) return;

    let t = 0;
    const duration = 0.5;
    const baseY = group.position.y;
    this.activeAnimations.push((dt) => {
      t += dt;
      if (t >= duration) {
        group.position.y = baseY;
        return false;
      }
      // Schnelles Absinken mit Abfederung
      const p = t / duration;
      group.position.y = baseY - Math.sin(p * Math.PI) * 0.4;
      return true;
    });
  }

  /* ---------------------------------------------------------------- */
  /* Q – Quake (Feld schlingert)                                       */
  /* ---------------------------------------------------------------- */
  public animateQuake(targetPlayerId: string): void {
    const group = this.arena.getGroup(targetPlayerId);
    if (!group) return;

    let t = 0;
    const duration = 0.6;
    const baseZ = group.position.z;
    this.activeAnimations.push((dt) => {
      t += dt;
      if (t >= duration) {
        group.position.z = baseZ;
        return false;
      }
      group.position.z = baseZ + Math.sin(t * 25) * 0.3 * (1 - t / duration);
      return true;
    });
  }

  /** Kleine Hilfs-Methode, um die SPECIALS-Map zu nutzen (z.B. UI). */
  public getSpecialName(type: SpecialType): string {
    return SPECIALS[type]?.name ?? type;
  }
}
