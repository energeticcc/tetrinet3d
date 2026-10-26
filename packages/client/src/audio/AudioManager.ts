/**
 * AudioManager: synthisierte Sound-Effekte über WebAudio (keine Assets).
 * Events: movement, lock, clear, special, game_over, win.
 *
 * Wichtig: WebAudio muss nach einer User-Geste entserrt werden
 * (Browser-Autoplay-Policy) — `unlock()` wird bei jedem Keydown aufgerufen.
 */
export class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private enabled = true;

  /** Muss einmalig nach User-Input aufgerufen werden. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    try {
      const Ctx = window.AudioContext ?? (window as any).webkitAudioContext;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.35;
      this.master.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
    }
  }

  toggle(): boolean {
    this.enabled = !this.enabled;
    return this.enabled;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /* ---------------------------------------------------------------- */
  /* Basis-Bausteine                                                   */
  /* ---------------------------------------------------------------- */

  private tone(
    freq: number,
    opts: { type?: OscillatorType; dur?: number; at?: number; vol?: number; slideTo?: number } = {},
  ): void {
    if (!this.ctx || !this.master || !this.enabled) return;
    const { type = "square", dur = 0.08, at = 0, vol = 1, slideTo } = opts;
    const t0 = this.ctx.currentTime + at;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  private noise(opts: { dur?: number; at?: number; vol?: number; hp?: number; lp?: number } = {}): void {
    if (!this.ctx || !this.master || !this.enabled) return;
    const { dur = 0.2, at = 0, vol = 0.5, hp = 400, lp = 8000 } = opts;
    const t0 = this.ctx.currentTime + at;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const hi = this.ctx.createBiquadFilter();
    hi.type = "highpass";
    hi.frequency.value = hp;
    const lo = this.ctx.createBiquadFilter();
    lo.type = "lowpass";
    lo.frequency.value = lp;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(hi).connect(lo).connect(gain).connect(this.master);
    src.start(t0);
  }

  /* ---------------------------------------------------------------- */
  /* Spiel-Events                                                      */
  /* ---------------------------------------------------------------- */

  move(): void {
    this.tone(340, { type: "square", dur: 0.035, vol: 0.35 });
  }

  rotate(): void {
    this.tone(520, { type: "square", dur: 0.045, vol: 0.35, slideTo: 640 });
  }

  softDrop(): void {
    this.tone(240, { type: "square", dur: 0.03, vol: 0.3 });
  }

  /** Block wird fest. */
  lock(): void {
    this.tone(140, { type: "square", dur: 0.07, vol: 0.5, slideTo: 70 });
    this.noise({ dur: 0.06, vol: 0.25, hp: 800, lp: 4000 });
  }

  /** Zeilen-Clear (1–4). */
  clear(lines: number): void {
    const base = [0, 660, 784, 988, 1319][lines] ?? 880;
    this.tone(base, { type: "square", dur: 0.09, vol: 0.5 });
    this.tone(base * 1.25, { type: "square", dur: 0.1, at: 0.05, vol: 0.45 });
    this.noise({ dur: 0.18, vol: 0.4, hp: 500, lp: 6000 });
  }

  /** Special feuert. */
  special(): void {
    this.tone(220, { type: "sawtooth", dur: 0.12, vol: 0.4, slideTo: 880 });
    this.noise({ dur: 0.1, at: 0.05, vol: 0.3 });
  }

  /** Special trifft. */
  specialHit(): void {
    this.noise({ dur: 0.35, vol: 0.55, hp: 200, lp: 5000 });
    this.tone(90, { type: "sine", dur: 0.3, vol: 0.6, slideTo: 40 });
  }

  gameOver(): void {
    const notes = [392, 330, 262, 196];
    notes.forEach((f, i) => this.tone(f, { type: "triangle", dur: 0.18, at: i * 0.14, vol: 0.5 }));
  }

  win(): void {
    const notes = [523, 659, 784, 1047, 1319];
    notes.forEach((f, i) => this.tone(f, { type: "square", dur: 0.12, at: i * 0.09, vol: 0.4 }));
    this.noise({ dur: 0.5, at: 0.4, vol: 0.3, hp: 1000, lp: 12000 });
  }

  /** Special im Inventory erhalten (kleine Belohnung). */
  specialGained(): void {
    this.tone(880, { type: "sine", dur: 0.07, vol: 0.35 });
    this.tone(1175, { type: "sine", dur: 0.1, at: 0.06, vol: 0.3 });
  }
}
