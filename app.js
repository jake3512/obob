(() => {
  'use strict';

  const TRACK_COUNT = 6;
  const TRACK_COLORS = ['#6c8cff', '#ff6c9c', '#47e0a4', '#ffc857', '#b48cff', '#4fd6e8'];
  const SCHEDULE_AHEAD = 0.12;
  const SCHEDULER_INTERVAL_MS = 25;

  const $ = (id) => document.getElementById(id);

  const el = {
    bpmInput: $('bpmInput'),
    beatsInput: $('beatsInput'),
    loopLengthDisplay: $('loopLengthDisplay'),
    tapTempoBtn: $('tapTempoBtn'),
    startSessionBtn: $('startSessionBtn'),
    resetSessionBtn: $('resetSessionBtn'),
    setupHint: $('setupHint'),
    transport: $('transport'),
    playheadFill: $('playheadFill'),
    loopCounter: $('loopCounter'),
    playAllBtn: $('playAllBtn'),
    stopAllBtn: $('stopAllBtn'),
    metronomeToggle: $('metronomeToggle'),
    mixerToggleBtn: $('mixerToggleBtn'),
    micMeterFill: $('micMeterFill'),
    tracksGrid: $('tracksGrid'),
    trackTemplate: $('trackTemplate'),
    instrumentsPanel: $('instrumentsPanel'),
    instSpeed: $('instSpeed'),
    instSpeedVal: $('instSpeedVal'),
    instPitch: $('instPitch'),
    instPitchVal: $('instPitchVal'),
    instTabs: $('instTabs'),
    drumKit: $('drumKit'),
    voiceSelect: $('voiceSelect'),
    octDownBtn: $('octDownBtn'),
    octUpBtn: $('octUpBtn'),
    octaveLabel: $('octaveLabel'),
    pianoKeys: $('pianoKeys'),
    mixerPanel: $('mixerPanel'),
    mixerStrips: $('mixerStrips'),
  };

  // Positioned like a real kit viewed from the drummer's seat: hats/tom/crash
  // up top, snare front-center, kick largest and lowest. Pads with startVoice
  // ring for as long as they're held (release fades them out); clap has no
  // natural sustain so it stays a fixed one-shot hit via `trigger`.
  const DRUM_PADS = [
    { id: 'hatC', name: '하이햇C', icon: '🎩', color: '#ffc857', size: 'sm', top: 14, left: 14, startVoice: (t) => startHatVoice(t, false) },
    { id: 'hatO', name: '하이햇O', icon: '👒', color: '#ffd97d', size: 'sm', top: 14, left: 30, startVoice: (t) => startHatVoice(t, true) },
    { id: 'tom', name: '탐', icon: '🔔', color: '#4fd6e8', size: 'md', top: 12, left: 54, startVoice: (t) => startTomVoice(t) },
    { id: 'cowbell', name: '카우벨', icon: '🛎️', color: '#ff9d4d', size: 'sm', top: 14, left: 80, startVoice: (t) => startCowbellVoice(t) },
    { id: 'tambourine', name: '탬버린', icon: '🔘', color: '#a8e063', size: 'sm', top: 46, left: 14, startVoice: (t) => startTambourineVoice(t) },
    { id: 'snare', name: '스네어', icon: '🪘', color: '#ff6c9c', size: 'md', top: 48, left: 38, startVoice: (t) => startSnareVoice(t) },
    { id: 'shaker', name: '셰이커', icon: '🪇', color: '#7fe0c0', size: 'sm', top: 46, left: 82, startVoice: (t) => startShakerVoice(t) },
    { id: 'clap', name: '클랩', icon: '👏', color: '#47e0a4', size: 'sm', top: 72, left: 16, trigger: (t) => playClap(t) },
    { id: 'kick', name: '킥', icon: '🥁', color: '#ff5470', size: 'lg', top: 72, left: 56, startVoice: (t) => startKickVoice(t) },
  ];

  const OCTAVE_WHITE_OFFSETS = [0, 2, 4, 5, 7, 9, 11];
  const OCTAVE_WHITE_NAMES = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
  const OCTAVE_BLACK_OFFSETS = [1, 3, 6, 8, 10];
  const OCTAVE_BLACK_AFTER_IDX = [0, 1, 3, 4, 5];
  const KEYBOARD_OCTAVES = 3;
  const KEYBOARD_DEFAULT_BASE_MIDI = {
    bass: 36,
    guitar: 48,
    lead: 60,
    epiano: 60,
    violin: 55,
    cello: 36,
    flute: 67,
    trumpet: 55,
    saxophone: 52,
    organ: 48,
    marimba: 48,
  };

  const state = {
    ctx: null,
    micStream: null,
    micSource: null,
    micAnalyser: null,
    meterBuf: null,
    masterGain: null,
    metronomeGain: null,
    bpm: 100,
    beatsPerLoop: 8,
    loopLength: 4.8,
    epoch: 0,
    started: false,
    metronomeOn: false,
    nextBeatTime: 0,
    beatIndex: 0,
    schedulerTimer: null,
    rafId: null,
    tracks: [],
    tapTimes: [],
    instrumentBus: null,
    instPanner: null,
    instSpeed: 1,
    instPitchSemis: 0,
    instVolume: 1,
    instPan: 0,
    instMuted: false,
    metronomeVolume: 0.4,
    metronomeMuted: false,
    noiseBuffer: null,
    activeVoices: new Map(),
    keyboardVoice: 'epiano',
    keyboardBaseMidi: 60,
    customSamples: [],
    sampleCounter: 0,
    soloSet: new Set(),
    mixerChannels: [],
    metronomeMeter: null,
    instMeter: null,
    masterMeter: null,
  };

  function nextBoundary(now, epoch, cycleLen, strict) {
    let rel = now - epoch;
    if (strict) rel += 1e-6;
    let k = Math.ceil(rel / cycleLen);
    if (k < 0) k = 0;
    return epoch + k * cycleLen;
  }

  function pickMimeType() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus',
    ];
    for (const c of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) {
        return c;
      }
    }
    return undefined;
  }

  function updateLoopLengthDisplay() {
    const bpm = Math.max(1, parseInt(el.bpmInput.value, 10) || 1);
    const beats = Math.max(1, parseInt(el.beatsInput.value, 10) || 1);
    const len = (beats * 60) / bpm;
    el.loopLengthDisplay.textContent = len.toFixed(2) + '초';
  }

  function wireStepper() {
    document.querySelectorAll('.stepper button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = $(btn.dataset.target);
        const step = parseInt(btn.dataset.step, 10);
        const min = parseInt(target.min, 10);
        const max = parseInt(target.max, 10);
        let val = (parseInt(target.value, 10) || 0) + step;
        val = Math.min(max, Math.max(min, val));
        target.value = val;
        updateLoopLengthDisplay();
      });
    });
    el.bpmInput.addEventListener('input', updateLoopLengthDisplay);
    el.beatsInput.addEventListener('input', updateLoopLengthDisplay);
  }

  function wireTapTempo() {
    el.tapTempoBtn.addEventListener('click', () => {
      const now = Date.now();
      if (state.tapTimes.length && now - state.tapTimes[state.tapTimes.length - 1] > 2000) {
        state.tapTimes = [];
      }
      state.tapTimes.push(now);
      if (state.tapTimes.length > 5) state.tapTimes.shift();
      if (state.tapTimes.length >= 2) {
        const intervals = [];
        for (let i = 1; i < state.tapTimes.length; i++) {
          intervals.push(state.tapTimes[i] - state.tapTimes[i - 1]);
        }
        const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        const bpm = Math.round(Math.min(240, Math.max(40, 60000 / avg)));
        el.bpmInput.value = bpm;
        updateLoopLengthDisplay();
      }
    });
  }

  // ---- Metronome scheduler ----
  function scheduleClick(time, accent) {
    const osc = state.ctx.createOscillator();
    const g = state.ctx.createGain();
    osc.frequency.value = accent ? 1500 : 950;
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(1, time + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.06);
    osc.connect(g);
    g.connect(state.metronomeGain);
    osc.start(time);
    osc.stop(time + 0.08);
  }

  function schedulerTick() {
    while (state.nextBeatTime < state.ctx.currentTime + SCHEDULE_AHEAD) {
      if (state.metronomeOn) {
        scheduleClick(state.nextBeatTime, state.beatIndex % state.beatsPerLoop === 0);
      }
      state.beatIndex++;
      state.nextBeatTime += 60 / state.bpm;
    }
  }

  // ---- Instrument synthesis (10 band instruments, no samples/external gear needed) ----
  function instMultiplier() {
    return state.instSpeed * Math.pow(2, state.instPitchSemis / 12);
  }
  function noteFreq(base) {
    return base * instMultiplier();
  }
  function envTime(t) {
    return t / state.instSpeed;
  }
  function ensureNoiseBuffer() {
    if (state.noiseBuffer) return state.noiseBuffer;
    const len = state.ctx.sampleRate * 2;
    const buf = state.ctx.createBuffer(1, len, state.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    state.noiseBuffer = buf;
    return buf;
  }

  // These return a {osc1, osc2, gain} voice compatible with
  // stopMelodicVoice/releaseVoiceForPointer: the attack+decay ramps down to
  // a sustain floor instead of silence, and the noise/oscillator sources are
  // left running (not stopped) so how long the pad is held controls how long
  // it rings - release fades it out early, or it just holds at the floor.
  function startKickVoice(time) {
    const ctx = state.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(noteFreq(150), time);
    osc.frequency.exponentialRampToValueAtTime(noteFreq(45), time + envTime(0.15));
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(1, time + 0.004);
    g.gain.exponentialRampToValueAtTime(0.22, time + envTime(0.35));
    osc.connect(g);
    g.connect(state.instrumentBus);
    osc.start(time);
    return { osc1: osc, osc2: null, gain: g };
  }

  function startSnareVoice(time) {
    const ctx = state.ctx;
    const noise = ctx.createBufferSource();
    noise.buffer = ensureNoiseBuffer();
    noise.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1000;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = noteFreq(180);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(1, time + 0.004);
    g.gain.exponentialRampToValueAtTime(0.18, time + envTime(0.2));
    noise.connect(hp);
    hp.connect(g);
    osc.connect(g);
    g.connect(state.instrumentBus);
    noise.start(time);
    osc.start(time);
    return { osc1: noise, osc2: osc, gain: g };
  }

  function startHatVoice(time, open) {
    const ctx = state.ctx;
    const noise = ctx.createBufferSource();
    noise.buffer = ensureNoiseBuffer();
    noise.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    const g = ctx.createGain();
    const decayT = open ? envTime(0.5) : envTime(0.08);
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(0.8, time + 0.003);
    g.gain.exponentialRampToValueAtTime(open ? 0.22 : 0.05, time + decayT);
    noise.connect(hp);
    hp.connect(g);
    g.connect(state.instrumentBus);
    noise.start(time);
    return { osc1: noise, osc2: null, gain: g };
  }

  function playClap(time) {
    const ctx = state.ctx;
    for (let i = 0; i < 3; i++) {
      const t = time + i * envTime(0.02);
      const noise = ctx.createBufferSource();
      noise.buffer = ensureNoiseBuffer();
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1500;
      bp.Q.value = 1.2;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.9, t);
      g.gain.exponentialRampToValueAtTime(0.01, t + envTime(0.08));
      noise.connect(bp);
      bp.connect(g);
      g.connect(state.instrumentBus);
      noise.start(t);
      noise.stop(t + envTime(0.1));
    }
  }

  function startTomVoice(time) {
    const ctx = state.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(noteFreq(200), time);
    osc.frequency.exponentialRampToValueAtTime(noteFreq(90), time + envTime(0.25));
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(1, time + 0.004);
    g.gain.exponentialRampToValueAtTime(0.2, time + envTime(0.3));
    osc.connect(g);
    g.connect(state.instrumentBus);
    osc.start(time);
    return { osc1: osc, osc2: null, gain: g };
  }

  function startTambourineVoice(time) {
    const ctx = state.ctx;
    const noise = ctx.createBufferSource();
    noise.buffer = ensureNoiseBuffer();
    noise.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 7000;
    bp.Q.value = 2.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(0.75, time + 0.003);
    g.gain.exponentialRampToValueAtTime(0.18, time + envTime(0.35));
    noise.connect(bp);
    bp.connect(g);
    g.connect(state.instrumentBus);
    noise.start(time);
    return { osc1: noise, osc2: null, gain: g };
  }

  function startCowbellVoice(time) {
    const ctx = state.ctx;
    const osc1 = ctx.createOscillator();
    osc1.type = 'square';
    osc1.frequency.value = noteFreq(800);
    const osc2 = ctx.createOscillator();
    osc2.type = 'square';
    osc2.frequency.value = noteFreq(540);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1400;
    bp.Q.value = 2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(0.7, time + 0.003);
    g.gain.exponentialRampToValueAtTime(0.15, time + envTime(0.4));
    osc1.connect(bp);
    osc2.connect(bp);
    bp.connect(g);
    g.connect(state.instrumentBus);
    osc1.start(time);
    osc2.start(time);
    return { osc1, osc2, gain: g };
  }

  function startShakerVoice(time) {
    const ctx = state.ctx;
    const noise = ctx.createBufferSource();
    noise.buffer = ensureNoiseBuffer();
    noise.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 4500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(0.6, time + 0.008);
    g.gain.exponentialRampToValueAtTime(0.12, time + envTime(0.15));
    noise.connect(hp);
    hp.connect(g);
    g.connect(state.instrumentBus);
    noise.start(time);
    return { osc1: noise, osc2: null, gain: g };
  }

  // A silent-carrier LFO wired into one or more detune AudioParams, for
  // instruments (violin, cello, flute, sax) that naturally waver in pitch
  // while a note is held. Returned so the caller can stop it on release.
  function addVibrato(ctx, now, detuneParams, rateHz, depthCents) {
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = rateHz;
    const depth = ctx.createGain();
    depth.gain.value = depthCents;
    lfo.connect(depth);
    detuneParams.forEach((p) => depth.connect(p));
    lfo.start(now);
    return lfo;
  }

  // Keyboard voices: held while the key is pressed, like any real keyboard
  // instrument (piano, or a bass/guitar/orchestral patch played from a
  // keyboard). Plucked/struck kinds (bass, guitar, marimba) decay toward a
  // soft sustain since even a held note keeps ringing down; bowed/blown
  // kinds (violin, cello, flute, trumpet, saxophone, organ) hold flat while
  // pressed, the way a bow or breath sustains a real note.
  function startMelodicVoice(kind, freq) {
    const ctx = state.ctx;
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    let osc1 = null;
    let osc2 = null;
    const extra = [];

    if (kind === 'bass') {
      osc1 = ctx.createOscillator();
      osc1.type = 'sawtooth';
      osc1.frequency.value = freq;
      filter.frequency.setValueAtTime(1400, now);
      filter.frequency.exponentialRampToValueAtTime(280, now + envTime(0.7));
      filter.Q.value = 0.8;
      osc1.connect(filter);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.95, now + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.35, now + envTime(0.7));
    } else if (kind === 'guitar') {
      osc1 = ctx.createOscillator();
      osc1.type = 'sawtooth';
      osc1.frequency.value = freq;
      osc2 = ctx.createOscillator();
      osc2.type = 'sawtooth';
      osc2.frequency.value = freq * 1.005;
      filter.frequency.setValueAtTime(4500, now);
      filter.frequency.exponentialRampToValueAtTime(700, now + envTime(0.6));
      filter.Q.value = 0.6;
      osc1.connect(filter);
      osc2.connect(filter);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.9, now + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.3, now + envTime(0.6));
    } else if (kind === 'marimba') {
      osc1 = ctx.createOscillator();
      osc1.type = 'sine';
      osc1.frequency.value = freq;
      osc2 = ctx.createOscillator();
      osc2.type = 'sine';
      osc2.frequency.value = freq * 3.98;
      const overtoneGain = ctx.createGain();
      overtoneGain.gain.value = 0.25;
      osc2.connect(overtoneGain);
      overtoneGain.connect(filter);
      osc1.connect(filter);
      filter.frequency.value = 3000;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(1, now + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.15, now + envTime(0.5));
    } else if (kind === 'lead') {
      osc1 = ctx.createOscillator();
      osc1.type = 'sawtooth';
      osc1.frequency.value = freq;
      osc2 = ctx.createOscillator();
      osc2.type = 'square';
      osc2.frequency.value = freq;
      filter.frequency.value = 2200;
      filter.Q.value = 3;
      osc1.connect(filter);
      osc2.connect(filter);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.9, now + 0.02);
    } else if (kind === 'violin') {
      osc1 = ctx.createOscillator();
      osc1.type = 'sawtooth';
      osc1.frequency.value = freq;
      osc2 = ctx.createOscillator();
      osc2.type = 'sawtooth';
      osc2.frequency.value = freq * 1.003;
      filter.frequency.value = 2600;
      filter.Q.value = 1;
      osc1.connect(filter);
      osc2.connect(filter);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.75, now + 0.09);
      extra.push(addVibrato(ctx, now, [osc1.detune, osc2.detune], 5.5, 9));
    } else if (kind === 'cello') {
      osc1 = ctx.createOscillator();
      osc1.type = 'sawtooth';
      osc1.frequency.value = freq;
      osc2 = ctx.createOscillator();
      osc2.type = 'triangle';
      osc2.frequency.value = freq * 1.002;
      filter.frequency.value = 1400;
      filter.Q.value = 0.8;
      osc1.connect(filter);
      osc2.connect(filter);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.8, now + 0.12);
      extra.push(addVibrato(ctx, now, [osc1.detune, osc2.detune], 4.8, 7));
    } else if (kind === 'flute') {
      osc1 = ctx.createOscillator();
      osc1.type = 'sine';
      osc1.frequency.value = freq;
      filter.frequency.value = 3500;
      osc1.connect(filter);
      const breath = ctx.createBufferSource();
      breath.buffer = ensureNoiseBuffer();
      breath.loop = true;
      const breathFilter = ctx.createBiquadFilter();
      breathFilter.type = 'bandpass';
      breathFilter.frequency.value = freq * 2;
      breathFilter.Q.value = 0.7;
      const breathGain = ctx.createGain();
      breathGain.gain.value = 0.05;
      breath.connect(breathFilter);
      breathFilter.connect(breathGain);
      breathGain.connect(gain);
      breath.start(now);
      extra.push(breath);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.7, now + 0.06);
      extra.push(addVibrato(ctx, now, [osc1.detune], 5.2, 6));
    } else if (kind === 'trumpet') {
      osc1 = ctx.createOscillator();
      osc1.type = 'sawtooth';
      osc1.frequency.value = freq;
      osc2 = ctx.createOscillator();
      osc2.type = 'square';
      osc2.frequency.value = freq * 1.004;
      filter.type = 'bandpass';
      filter.frequency.value = freq * 3;
      filter.Q.value = 2.5;
      osc1.connect(filter);
      osc2.connect(filter);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.85, now + 0.03);
    } else if (kind === 'saxophone') {
      osc1 = ctx.createOscillator();
      osc1.type = 'sawtooth';
      osc1.frequency.value = freq;
      filter.frequency.value = 1600;
      filter.Q.value = 4;
      osc1.connect(filter);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.8, now + 0.05);
      extra.push(addVibrato(ctx, now, [osc1.detune], 5.0, 5));
    } else if (kind === 'organ') {
      const ratios = [1, 2, 3, 4, 6];
      const amps = [0.5, 0.3, 0.18, 0.12, 0.08];
      osc1 = ctx.createOscillator();
      osc1.type = 'sine';
      osc1.frequency.value = freq * ratios[0];
      const drawbar0 = ctx.createGain();
      drawbar0.gain.value = amps[0];
      osc1.connect(drawbar0);
      drawbar0.connect(gain);
      for (let i = 1; i < ratios.length; i++) {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = freq * ratios[i];
        const og = ctx.createGain();
        og.gain.value = amps[i];
        o.connect(og);
        og.connect(gain);
        o.start(now);
        extra.push(o);
      }
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.9, now + 0.01);
    } else {
      osc1 = ctx.createOscillator();
      osc1.type = 'sine';
      osc1.frequency.value = freq;
      osc2 = ctx.createOscillator();
      osc2.type = 'sine';
      osc2.frequency.value = freq * 3.01;
      const overtoneGain = ctx.createGain();
      overtoneGain.gain.value = 0.15;
      osc2.connect(overtoneGain);
      overtoneGain.connect(filter);
      filter.frequency.value = 6000;
      osc1.connect(filter);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.9, now + 0.02);
    }

    filter.connect(gain);
    gain.connect(state.instrumentBus);
    osc1.start(now);
    if (osc2) osc2.start(now);
    return { osc1, osc2, gain, extra };
  }

  function stopMelodicVoice(voice) {
    const ctx = state.ctx;
    const now = ctx.currentTime;
    const release = 0.15;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    voice.gain.gain.linearRampToValueAtTime(0.0001, now + release);
    [voice.osc1, voice.osc2, ...(voice.extra || [])].forEach((o) => {
      if (o) { try { o.stop(now + release + 0.05); } catch (e) { /* noop */ } }
    });
  }

  function releaseVoiceForPointer(pointerId) {
    const rec = state.activeVoices.get(pointerId);
    if (!rec) return;
    stopMelodicVoice(rec.voice);
    rec.pad.classList.remove('active');
    state.activeVoices.delete(pointerId);
  }

  function darken(hex, factor) {
    const c = hex.replace('#', '');
    const r = Math.round(parseInt(c.substring(0, 2), 16) * factor);
    const g = Math.round(parseInt(c.substring(2, 4), 16) * factor);
    const b = Math.round(parseInt(c.substring(4, 6), 16) * factor);
    return `rgb(${r},${g},${b})`;
  }

  // ---- Drum kit: one assembled board (not a plain grid) so it reads and
  // plays like a real kit - each piece is tapped where it actually sits.
  function buildDrumPads() {
    el.drumKit.innerHTML = '';
    DRUM_PADS.forEach((inst) => {
      const pad = document.createElement('button');
      pad.type = 'button';
      pad.className = `pad kit-pad kit-pad-${inst.size}`;
      pad.style.setProperty('--pad-color', inst.color);
      pad.style.setProperty('--pad-color-dark', darken(inst.color, 0.4));
      pad.style.top = inst.top + '%';
      pad.style.left = inst.left + '%';
      pad.innerHTML = `<span class="pad-icon">${inst.icon}</span><span>${inst.name}</span>`;
      if (inst.startVoice) {
        pad.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          if (!state.started) return;
          pad.setPointerCapture(e.pointerId);
          const voice = inst.startVoice(state.ctx.currentTime + 0.005);
          state.activeVoices.set(e.pointerId, { voice, pad, startedAt: performance.now() });
          pad.classList.add('active');
        });
        pad.addEventListener('pointerup', (e) => releaseVoiceForPointer(e.pointerId));
        pad.addEventListener('pointercancel', (e) => releaseVoiceForPointer(e.pointerId));
        pad.addEventListener('lostpointercapture', (e) => releaseVoiceForPointer(e.pointerId));
      } else {
        pad.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          if (!state.started) return;
          inst.trigger(state.ctx.currentTime + 0.005);
          pad.classList.add('active');
          setTimeout(() => pad.classList.remove('active'), 120);
        });
      }
      el.drumKit.appendChild(pad);
    });
  }

  // ---- Piano keyboard (bass / guitar / lead / e-piano): real multi-touch keys, so several
  // fingers held down together play an actual chord, and octave buttons move
  // the playable range the way a keyboard's octave shift would.
  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function renderKeyboard() {
    const whiteRow = el.pianoKeys.querySelector('.piano-white-row');
    const blackRow = el.pianoKeys.querySelector('.piano-black-row');
    whiteRow.innerHTML = '';
    blackRow.innerHTML = '';
    const base = state.keyboardBaseMidi;

    const totalWhite = KEYBOARD_OCTAVES * OCTAVE_WHITE_OFFSETS.length + 1;
    for (let oct = 0; oct < KEYBOARD_OCTAVES; oct++) {
      OCTAVE_WHITE_OFFSETS.forEach((off, i) => {
        const key = document.createElement('div');
        key.className = 'key';
        key.textContent = OCTAVE_WHITE_NAMES[i];
        key.dataset.midi = base + oct * 12 + off;
        wireKey(key);
        whiteRow.appendChild(key);
      });
    }
    const topKey = document.createElement('div');
    topKey.className = 'key';
    topKey.textContent = 'C';
    topKey.dataset.midi = base + KEYBOARD_OCTAVES * 12;
    wireKey(topKey);
    whiteRow.appendChild(topKey);

    for (let oct = 0; oct < KEYBOARD_OCTAVES; oct++) {
      OCTAVE_BLACK_OFFSETS.forEach((off, i) => {
        const key = document.createElement('div');
        key.className = 'key';
        key.dataset.midi = base + oct * 12 + off;
        const whiteIdxGlobal = oct * OCTAVE_WHITE_OFFSETS.length + OCTAVE_BLACK_AFTER_IDX[i];
        key.style.left = ((whiteIdxGlobal + 1) / totalWhite) * 100 + '%';
        wireKey(key);
        blackRow.appendChild(key);
      });
    }

    const lowName = 'C' + (Math.floor(base / 12) - 1);
    const highName = 'C' + (Math.floor((base + KEYBOARD_OCTAVES * 12) / 12) - 1);
    el.octaveLabel.textContent = lowName + '–' + highName;
  }

  function wireKey(key) {
    key.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (!state.started) return;
      key.setPointerCapture(e.pointerId);
      const midi = parseInt(key.dataset.midi, 10);
      const sample = state.customSamples.find((s) => s.id === state.keyboardVoice);
      const voice = sample
        ? startSampleVoice(sample, midi)
        : startMelodicVoice(state.keyboardVoice, noteFreq(midiToFreq(midi)));
      state.activeVoices.set(e.pointerId, { voice, pad: key, startedAt: performance.now() });
      key.classList.add('active');
    });
    key.addEventListener('pointerup', (e) => releaseVoiceForPointer(e.pointerId));
    key.addEventListener('pointercancel', (e) => releaseVoiceForPointer(e.pointerId));
    key.addEventListener('lostpointercapture', (e) => releaseVoiceForPointer(e.pointerId));
  }

  function wireKeyboardControls() {
    el.voiceSelect.addEventListener('click', (e) => {
      const removeIcon = e.target.closest('.voice-remove');
      if (removeIcon) {
        const btn = removeIcon.closest('.voice-btn');
        const id = btn.dataset.voice;
        state.customSamples = state.customSamples.filter((s) => s.id !== id);
        if (state.keyboardVoice === id) {
          state.keyboardVoice = 'epiano';
          state.keyboardBaseMidi = KEYBOARD_DEFAULT_BASE_MIDI.epiano;
          el.voiceSelect.querySelectorAll('.voice-btn').forEach((b) => b.classList.toggle('active', b.dataset.voice === 'epiano'));
          renderKeyboard();
        }
        btn.remove();
        return;
      }
      const btn = e.target.closest('.voice-btn');
      if (!btn) return;
      state.keyboardVoice = btn.dataset.voice;
      state.keyboardBaseMidi = KEYBOARD_DEFAULT_BASE_MIDI[state.keyboardVoice] != null ? KEYBOARD_DEFAULT_BASE_MIDI[state.keyboardVoice] : 60;
      el.voiceSelect.querySelectorAll('.voice-btn').forEach((b) => b.classList.toggle('active', b === btn));
      renderKeyboard();
    });
    el.octDownBtn.addEventListener('click', () => {
      state.keyboardBaseMidi = Math.max(12, state.keyboardBaseMidi - 12);
      renderKeyboard();
    });
    el.octUpBtn.addEventListener('click', () => {
      state.keyboardBaseMidi = Math.min(72, state.keyboardBaseMidi + 12);
      renderKeyboard();
    });
  }

  // ---- Instrument tabs ----
  function wireInstrumentTabs() {
    el.instTabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.inst-tab');
      if (!btn) return;
      const cat = btn.dataset.cat;
      el.instTabs.querySelectorAll('.inst-tab').forEach((b) => b.classList.toggle('active', b === btn));
      el.instrumentsPanel.querySelectorAll('.inst-view').forEach((v) => {
        v.hidden = v.dataset.cat !== cat;
      });
    });
  }

  function wireInstrumentControls() {
    el.instSpeed.addEventListener('input', () => {
      state.instSpeed = parseFloat(el.instSpeed.value);
      el.instSpeedVal.textContent = state.instSpeed.toFixed(2) + 'x';
    });
    el.instPitch.addEventListener('input', () => {
      state.instPitchSemis = parseInt(el.instPitch.value, 10);
      el.instPitchVal.textContent = (state.instPitchSemis > 0 ? '+' : '') + state.instPitchSemis + 'st';
    });
  }

  // ---- Mixer: per-channel volume/pan/mute/solo + level metering ----
  function attachMeter(node) {
    const analyser = state.ctx.createAnalyser();
    analyser.fftSize = 256;
    node.connect(analyser);
    return { analyser, buf: new Uint8Array(analyser.fftSize) };
  }

  function meterLevel(meter) {
    meter.analyser.getByteTimeDomainData(meter.buf);
    let sumSq = 0;
    for (let i = 0; i < meter.buf.length; i++) {
      const v = (meter.buf[i] - 128) / 128;
      sumSq += v * v;
    }
    return Math.sqrt(sumSq / meter.buf.length);
  }

  function isSoloActive() {
    return state.soloSet.size > 0;
  }
  function isAudible(channelId, ownMuted) {
    if (ownMuted) return false;
    if (isSoloActive() && !state.soloSet.has(channelId)) return false;
    return true;
  }

  function refreshTrackGain(track) {
    track.gainNode.gain.value = isAudible('track' + track.id, track.isMuted) ? track.volume : 0;
  }
  function refreshMetronomeGain() {
    if (!state.metronomeGain) return;
    state.metronomeGain.gain.value = isAudible('metronome', state.metronomeMuted) ? state.metronomeVolume : 0;
  }
  function refreshInstrumentGain() {
    if (!state.instrumentBus) return;
    state.instrumentBus.gain.value = isAudible('instruments', state.instMuted) ? state.instVolume : 0;
  }
  function refreshAllGains() {
    state.tracks.forEach(refreshTrackGain);
    refreshMetronomeGain();
    refreshInstrumentGain();
  }

  function refreshAllMixerVisuals() {
    const active = isSoloActive();
    state.mixerChannels.forEach((ch) => {
      if (ch.soloBtn) ch.soloBtn.classList.toggle('active', state.soloSet.has(ch.id));
      ch.stripEl.classList.toggle('dimmed', active && !state.soloSet.has(ch.id));
    });
  }

  function toggleSolo(id) {
    if (state.soloSet.has(id)) state.soloSet.delete(id);
    else state.soloSet.add(id);
    refreshAllGains();
    refreshAllMixerVisuals();
  }

  function buildChannelStrip(opts) {
    const strip = document.createElement('div');
    strip.className = 'mixer-strip';
    strip.style.setProperty('--strip-color', opts.color || 'var(--accent)');

    let soloBtn = null;
    let muteBtn = null;
    let downloadBtn = null;
    if (opts.hasMuteSolo || opts.hasDownload) {
      const topRow = document.createElement('div');
      topRow.className = 'mixer-toprow';
      if (opts.hasMuteSolo) {
        soloBtn = document.createElement('button');
        soloBtn.type = 'button';
        soloBtn.className = 'mini-btn solo-btn';
        soloBtn.textContent = 'S';
        muteBtn = document.createElement('button');
        muteBtn.type = 'button';
        muteBtn.className = 'mini-btn mute-btn';
        muteBtn.textContent = 'M';
        topRow.appendChild(soloBtn);
        topRow.appendChild(muteBtn);
      }
      if (opts.hasDownload) {
        downloadBtn = document.createElement('button');
        downloadBtn.type = 'button';
        downloadBtn.className = 'mini-btn download-btn';
        downloadBtn.textContent = '⭳';
        downloadBtn.title = 'WAV 다운로드';
        downloadBtn.disabled = true;
        topRow.appendChild(downloadBtn);
      }
      strip.appendChild(topRow);
    }

    const meterBar = document.createElement('div');
    meterBar.className = 'mixer-meter';
    const meterFill = document.createElement('div');
    meterFill.className = 'mixer-meter-fill';
    meterBar.appendChild(meterFill);
    strip.appendChild(meterBar);

    const faderWrap = document.createElement('div');
    faderWrap.className = 'fader-wrap';
    const fader = document.createElement('input');
    fader.type = 'range';
    fader.className = 'fader';
    fader.min = opts.volumeMin;
    fader.max = opts.volumeMax;
    fader.step = opts.volumeStep;
    fader.value = opts.initialVolume;
    faderWrap.appendChild(fader);
    strip.appendChild(faderWrap);

    const valBadge = document.createElement('div');
    valBadge.className = 'mixer-val';
    valBadge.textContent = Math.round(opts.initialVolume * 100) + '%';
    strip.appendChild(valBadge);

    let panInput = null;
    if (opts.hasPan) {
      panInput = document.createElement('input');
      panInput.type = 'range';
      panInput.className = 'pan-knob';
      panInput.min = -1;
      panInput.max = 1;
      panInput.step = 0.05;
      panInput.value = opts.initialPan || 0;
      strip.appendChild(panInput);
    }

    const label = document.createElement('div');
    label.className = 'mixer-label';
    label.textContent = opts.name;
    strip.appendChild(label);

    fader.addEventListener('input', () => {
      const v = parseFloat(fader.value);
      valBadge.textContent = Math.round(v * 100) + '%';
      opts.onVolumeChange(v);
    });
    if (panInput) {
      panInput.addEventListener('input', () => opts.onPanChange(parseFloat(panInput.value)));
    }
    if (soloBtn) soloBtn.addEventListener('click', () => toggleSolo(opts.id));
    if (muteBtn) muteBtn.addEventListener('click', () => opts.onMuteToggle(muteBtn));
    if (downloadBtn) downloadBtn.addEventListener('click', () => opts.onDownloadClick());

    return { strip, fader, valBadge, panInput, muteBtn, soloBtn, downloadBtn, meterFill };
  }

  function buildMixer() {
    el.mixerStrips.innerHTML = '';
    state.mixerChannels = [];

    state.tracks.forEach((track) => {
      const id = 'track' + track.id;
      const s = buildChannelStrip({
        id,
        name: track.name,
        color: track.color,
        volumeMin: 0,
        volumeMax: 1.5,
        volumeStep: 0.01,
        initialVolume: track.volume,
        onVolumeChange: (v) => { track.volume = v; track.volInput.value = v; refreshTrackGain(track); },
        hasPan: true,
        initialPan: track.pan,
        onPanChange: (p) => { track.pan = p; track.panNode.pan.value = p; },
        hasMuteSolo: true,
        onMuteToggle: () => onMuteClick(track),
        hasDownload: true,
        onDownloadClick: () => onDownloadClick(track),
      });
      track.mixerFader = s.fader;
      track.mixerValEl = s.valBadge;
      track.mixerMuteBtn = s.muteBtn;
      track.mixerDownloadBtn = s.downloadBtn;
      track.mixerMeterFill = s.meterFill;
      el.mixerStrips.appendChild(s.strip);
      state.mixerChannels.push({ id, stripEl: s.strip, soloBtn: s.soloBtn });
    });

    const metStrip = buildChannelStrip({
      id: 'metronome',
      name: '메트로놈',
      color: '#ffc857',
      volumeMin: 0,
      volumeMax: 1,
      volumeStep: 0.01,
      initialVolume: state.metronomeVolume,
      onVolumeChange: (v) => { state.metronomeVolume = v; refreshMetronomeGain(); },
      hasPan: false,
      hasMuteSolo: true,
      onMuteToggle: (btn) => {
        state.metronomeMuted = !state.metronomeMuted;
        btn.classList.toggle('active', state.metronomeMuted);
        refreshMetronomeGain();
      },
    });
    el.mixerStrips.appendChild(metStrip.strip);
    state.metronomeMixerMeterFill = metStrip.meterFill;
    state.mixerChannels.push({ id: 'metronome', stripEl: metStrip.strip, soloBtn: metStrip.soloBtn });

    const instStrip = buildChannelStrip({
      id: 'instruments',
      name: '악기',
      color: '#6c8cff',
      volumeMin: 0,
      volumeMax: 1.5,
      volumeStep: 0.01,
      initialVolume: state.instVolume,
      onVolumeChange: (v) => { state.instVolume = v; refreshInstrumentGain(); },
      hasPan: true,
      initialPan: state.instPan,
      onPanChange: (p) => { state.instPan = p; state.instPanner.pan.value = p; },
      hasMuteSolo: true,
      onMuteToggle: (btn) => {
        state.instMuted = !state.instMuted;
        btn.classList.toggle('active', state.instMuted);
        refreshInstrumentGain();
      },
    });
    el.mixerStrips.appendChild(instStrip.strip);
    state.instMixerMeterFill = instStrip.meterFill;
    state.mixerChannels.push({ id: 'instruments', stripEl: instStrip.strip, soloBtn: instStrip.soloBtn });

    const masterStrip = buildChannelStrip({
      id: 'master',
      name: '마스터',
      color: '#47e0a4',
      volumeMin: 0,
      volumeMax: 1.5,
      volumeStep: 0.01,
      initialVolume: state.masterGain.gain.value,
      onVolumeChange: (v) => { state.masterGain.gain.value = v; },
      hasPan: false,
      hasMuteSolo: false,
    });
    el.mixerStrips.appendChild(masterStrip.strip);
    state.masterMixerMeterFill = masterStrip.meterFill;
  }

  // ---- Track lifecycle ----
  function makeTrack(index) {
    const frag = el.trackTemplate.content.cloneNode(true);
    const card = frag.querySelector('.track-card');
    const color = TRACK_COLORS[index % TRACK_COLORS.length];
    card.style.setProperty('--track-accent', color);

    const track = {
      id: index,
      name: `Track ${index + 1}`,
      color,
      card,
      nameEl: card.querySelector('.track-name'),
      statusEl: card.querySelector('.track-status'),
      progressFillEl: card.querySelector('.track-progress-fill'),
      recordBtn: card.querySelector('.track-record'),
      playBtn: card.querySelector('.track-play'),
      muteBtn: card.querySelector('.track-mute'),
      clearBtn: card.querySelector('.track-clear'),
      downloadBtn: card.querySelector('.track-download'),
      trimBtn: card.querySelector('.track-trim'),
      volInput: card.querySelector('.track-vol'),
      speedInput: card.querySelector('.track-speed'),
      speedValEl: card.querySelector('.track-speed-val'),
      pitchInput: card.querySelector('.track-pitch'),
      pitchValEl: card.querySelector('.track-pitch-val'),
      trimEditor: card.querySelector('.trim-editor'),
      trimWaveWrap: card.querySelector('.trim-wave-wrap'),
      trimCanvas: card.querySelector('.trim-canvas'),
      trimMaskLeft: card.querySelector('.trim-mask-left'),
      trimMaskRight: card.querySelector('.trim-mask-right'),
      trimHandleLeft: card.querySelector('.trim-handle-left'),
      trimHandleRight: card.querySelector('.trim-handle-right'),
      trimTimeEl: card.querySelector('.trim-time'),
      trimStart: 0,
      trimEnd: 0,
      gainNode: state.ctx.createGain(),
      panNode: state.ctx.createStereoPanner(),
      volume: 1,
      pan: 0,
      mixerFader: null,
      mixerValEl: null,
      mixerMuteBtn: null,
      mixerDownloadBtn: null,
      mixerMeterFill: null,
      state: 'empty',
      buffer: null,
      n: 0,
      speed: 1,
      pitchSemis: 0,
      startBoundary: 0,
      recordStartBoundary: 0,
      mediaRecorder: null,
      chunks: [],
      sourceNode: null,
      pendingOverdub: false,
      recordMixDest: null,
      isMuted: false,
      armTimeoutId: null,
      stopTimeoutId: null,
    };

    track.nameEl.textContent = track.name;
    track.volume = parseFloat(track.volInput.value);
    track.gainNode.gain.value = track.volume;
    track.gainNode.connect(track.panNode);
    track.panNode.connect(state.masterGain);
    track.meter = attachMeter(track.gainNode);

    track.recordBtn.addEventListener('click', () => onRecordClick(track));
    track.playBtn.addEventListener('click', () => onPlayClick(track));
    track.muteBtn.addEventListener('click', () => onMuteClick(track));
    track.clearBtn.addEventListener('click', () => onClearClick(track));
    track.downloadBtn.addEventListener('click', () => onDownloadClick(track));
    track.trimBtn.addEventListener('click', () => {
      if (track.trimEditor.hidden) openTrimEditor(track);
      else closeTrimEditor(track);
    });
    track.trimEditor.querySelector('.trim-preview').addEventListener('click', () => previewTrim(track));
    track.trimEditor.querySelector('.trim-apply-loop').addEventListener('click', () => applyTrimToLoop(track));
    track.trimEditor.querySelector('.trim-save-sample').addEventListener('click', () => saveTrimAsSample(track));
    track.trimEditor.querySelector('.trim-close').addEventListener('click', () => closeTrimEditor(track));
    wireTrimHandle(track.trimHandleLeft, track, true);
    wireTrimHandle(track.trimHandleRight, track, false);
    track.volInput.addEventListener('input', () => {
      track.volume = parseFloat(track.volInput.value);
      if (track.mixerFader) {
        track.mixerFader.value = track.volume;
        track.mixerValEl.textContent = Math.round(track.volume * 100) + '%';
      }
      refreshTrackGain(track);
    });
    track.speedInput.addEventListener('input', () => {
      track.speed = parseFloat(track.speedInput.value);
      track.speedValEl.textContent = track.speed.toFixed(2) + 'x';
      if (track.sourceNode) track.sourceNode.playbackRate.value = track.speed;
    });
    track.pitchInput.addEventListener('input', () => {
      track.pitchSemis = parseInt(track.pitchInput.value, 10);
      track.pitchValEl.textContent = (track.pitchSemis > 0 ? '+' : '') + track.pitchSemis + 'st';
      if (track.sourceNode) track.sourceNode.detune.value = track.pitchSemis * 100;
    });

    el.tracksGrid.appendChild(card);
    updateTrackUI(track);
    return track;
  }

  function buildTracks() {
    el.tracksGrid.innerHTML = '';
    state.tracks = [];
    for (let i = 0; i < TRACK_COUNT; i++) {
      state.tracks.push(makeTrack(i));
    }
  }

  function updateTrackUI(track) {
    track.card.classList.remove('armed', 'recording', 'playing');
    track.card.classList.toggle('muted', track.isMuted);

    const labels = {
      empty: 'Empty',
      armed: '대기 중… (클릭시 취소)',
      recording: '녹음 중',
      finishing: '마무리 중…',
      stopped: '정지됨',
      playing: '재생 중',
    };
    track.statusEl.textContent = labels[track.state] || track.state;

    if (track.state === 'armed') track.card.classList.add('armed');
    if (track.state === 'recording') track.card.classList.add('recording');
    if (track.state === 'playing') track.card.classList.add('playing');

    track.recordBtn.classList.remove('is-armed', 'is-recording');
    track.recordBtn.disabled = track.state === 'finishing';
    if (track.state === 'armed') {
      track.recordBtn.textContent = '⏳';
      track.recordBtn.classList.add('is-armed');
    } else if (track.state === 'recording') {
      track.recordBtn.textContent = '■';
      track.recordBtn.classList.add('is-recording');
    } else if (track.state === 'playing') {
      track.recordBtn.textContent = '+';
      track.recordBtn.title = '오버덥 (겹쳐 녹음)';
    } else {
      track.recordBtn.textContent = '●';
      track.recordBtn.title = '녹음';
    }

    const hasBuffer = !!track.buffer;
    track.playBtn.disabled = !hasBuffer || track.state === 'armed' || track.state === 'recording' || track.state === 'finishing';
    track.playBtn.textContent = track.state === 'playing' ? '■' : '▶';
    track.playBtn.classList.toggle('is-playing', track.state === 'playing');

    track.muteBtn.disabled = !hasBuffer;
    track.muteBtn.classList.toggle('is-muted', track.isMuted);
    if (track.mixerMuteBtn) track.mixerMuteBtn.classList.toggle('active', track.isMuted);

    track.clearBtn.disabled = track.state === 'empty';
    track.downloadBtn.disabled = !hasBuffer;
    if (track.mixerDownloadBtn) track.mixerDownloadBtn.disabled = !hasBuffer;
    track.trimBtn.disabled = !hasBuffer;
  }

  function onRecordClick(track) {
    if (!state.started) return;
    switch (track.state) {
      case 'empty':
      case 'stopped':
        armRecording(track, false);
        break;
      case 'playing':
        armRecording(track, true);
        break;
      case 'armed':
        cancelArm(track);
        break;
      case 'recording':
        requestStopRecording(track);
        break;
      default:
        break;
    }
  }

  function armRecording(track, overdub) {
    track.pendingOverdub = overdub;
    track.state = 'armed';
    updateTrackUI(track);
    const boundary = nextBoundary(state.ctx.currentTime, state.epoch, state.loopLength, false);
    const delay = Math.max(0, (boundary - state.ctx.currentTime) * 1000);
    track.armTimeoutId = setTimeout(() => beginRecording(track, boundary), delay);
  }

  function cancelArm(track) {
    clearTimeout(track.armTimeoutId);
    track.state = track.buffer ? 'stopped' : 'empty';
    updateTrackUI(track);
  }

  function beginRecording(track, boundary) {
    track.state = 'recording';
    track.recordStartBoundary = boundary;
    track.chunks = [];

    const mixDest = state.ctx.createMediaStreamDestination();
    state.micSource.connect(mixDest);
    state.instrumentBus.connect(mixDest);
    if (track.pendingOverdub && track.buffer && track.sourceNode) {
      track.sourceNode.connect(mixDest);
    }
    track.recordMixDest = mixDest;

    const mimeType = pickMimeType();
    try {
      track.mediaRecorder = mimeType
        ? new MediaRecorder(mixDest.stream, { mimeType })
        : new MediaRecorder(mixDest.stream);
    } catch (err) {
      console.error('MediaRecorder init failed', err);
      try { state.micSource.disconnect(mixDest); } catch (e) { /* noop */ }
      try { state.instrumentBus.disconnect(mixDest); } catch (e) { /* noop */ }
      if (track.pendingOverdub && track.sourceNode) {
        try { track.sourceNode.disconnect(mixDest); } catch (e) { /* noop */ }
      }
      track.recordMixDest = null;
      track.state = track.buffer ? 'stopped' : 'empty';
      updateTrackUI(track);
      return;
    }
    track.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) track.chunks.push(e.data);
    };
    track.mediaRecorder.onstop = () => finishRecording(track);
    track.mediaRecorder.start();
    updateTrackUI(track);
  }

  function requestStopRecording(track) {
    if (track.state !== 'recording') return;
    const boundary = nextBoundary(state.ctx.currentTime, state.epoch, state.loopLength, true);
    track.state = 'finishing';
    updateTrackUI(track);
    const delay = Math.max(0, (boundary - state.ctx.currentTime) * 1000);
    track.stopTimeoutId = setTimeout(() => {
      if (track.mediaRecorder && track.mediaRecorder.state === 'recording') {
        track.mediaRecorder.stop();
      }
    }, delay);
  }

  async function finishRecording(track) {
    if (track.recordMixDest) {
      try { state.micSource.disconnect(track.recordMixDest); } catch (e) { /* noop */ }
      try { state.instrumentBus.disconnect(track.recordMixDest); } catch (e) { /* noop */ }
      if (track.pendingOverdub && track.sourceNode) {
        try { track.sourceNode.disconnect(track.recordMixDest); } catch (e) { /* noop */ }
      }
      track.recordMixDest = null;
    }

    const mimeType = (track.mediaRecorder && track.mediaRecorder.mimeType) || 'audio/webm';
    const blob = new Blob(track.chunks, { type: mimeType });
    track.chunks = [];

    if (blob.size === 0) {
      track.state = track.buffer ? 'stopped' : 'empty';
      updateTrackUI(track);
      return;
    }

    let decoded;
    try {
      const arrBuf = await blob.arrayBuffer();
      decoded = await state.ctx.decodeAudioData(arrBuf);
    } catch (err) {
      console.error('decodeAudioData failed', err);
      track.state = track.buffer ? 'stopped' : 'empty';
      updateTrackUI(track);
      return;
    }

    const L = state.loopLength;
    const n = Math.max(1, Math.round(decoded.duration / L));
    const exactLen = Math.max(1, Math.round(n * L * state.ctx.sampleRate));
    const newBuffer = state.ctx.createBuffer(decoded.numberOfChannels, exactLen, state.ctx.sampleRate);
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      const src = decoded.getChannelData(ch);
      const dst = newBuffer.getChannelData(ch);
      dst.set(src.subarray(0, Math.min(src.length, dst.length)));
    }

    track.buffer = newBuffer;
    track.n = n;
    track.startBoundary = track.recordStartBoundary;
    closeTrimEditor(track);
    playTrack(track);
  }

  function stopTrackSource(track) {
    if (track.sourceNode) {
      try { track.sourceNode.stop(); } catch (e) { /* noop */ }
      try { track.sourceNode.disconnect(); } catch (e) { /* noop */ }
      track.sourceNode = null;
    }
  }

  function playTrack(track) {
    if (!track.buffer) return;
    stopTrackSource(track);
    const source = state.ctx.createBufferSource();
    source.buffer = track.buffer;
    source.loop = true;
    source.playbackRate.value = track.speed;
    source.detune.value = track.pitchSemis * 100;
    source.connect(track.gainNode);
    const cycleLen = track.n * state.loopLength;
    const startAt = nextBoundary(state.ctx.currentTime, track.startBoundary, cycleLen, false);
    source.start(startAt);
    track.sourceNode = source;
    track.state = 'playing';
    updateTrackUI(track);
  }

  function onPlayClick(track) {
    if (!track.buffer) return;
    if (track.state === 'playing') {
      stopTrackSource(track);
      track.state = 'stopped';
      updateTrackUI(track);
    } else if (track.state === 'stopped') {
      playTrack(track);
    }
  }

  function onMuteClick(track) {
    track.isMuted = !track.isMuted;
    refreshTrackGain(track);
    updateTrackUI(track);
  }

  function onClearClick(track) {
    clearTimeout(track.armTimeoutId);
    clearTimeout(track.stopTimeoutId);
    if (track.mediaRecorder && track.mediaRecorder.state === 'recording') {
      try { track.mediaRecorder.stop(); } catch (e) { /* noop */ }
    }
    if (track.recordMixDest) {
      try { state.micSource.disconnect(track.recordMixDest); } catch (e) { /* noop */ }
      try { state.instrumentBus.disconnect(track.recordMixDest); } catch (e) { /* noop */ }
      if (track.pendingOverdub && track.sourceNode) {
        try { track.sourceNode.disconnect(track.recordMixDest); } catch (e) { /* noop */ }
      }
      track.recordMixDest = null;
    }
    stopTrackSource(track);
    track.buffer = null;
    track.n = 0;
    track.chunks = [];
    track.state = 'empty';
    closeTrimEditor(track);
    updateTrackUI(track);
  }

  function onDownloadClick(track) {
    if (!track.buffer) return;
    const blob = audioBufferToWav(track.buffer);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${track.name.replace(/\s+/g, '_')}.wav`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // ---- Trim editor: cut the front/back of a recorded track, either to
  // shorten the loop itself or to lift out a clip to play from the keyboard.
  function drawWaveform(track) {
    const canvas = track.trimCanvas;
    const c2d = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    c2d.clearRect(0, 0, w, h);
    const data = track.buffer.getChannelData(0);
    const step = Math.max(1, Math.ceil(data.length / w));
    c2d.fillStyle = track.color;
    for (let x = 0; x < w; x++) {
      let min = 1;
      let max = -1;
      const start = x * step;
      for (let i = 0; i < step; i++) {
        const v = data[start + i];
        if (v === undefined) break;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (max < min) { max = 0; min = 0; }
      const y1 = (1 - max) * 0.5 * h;
      const y2 = (1 - min) * 0.5 * h;
      c2d.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
  }

  function updateTrimHandles(track) {
    const dur = track.buffer.duration;
    const leftPct = (track.trimStart / dur) * 100;
    const rightPct = (track.trimEnd / dur) * 100;
    track.trimHandleLeft.style.left = leftPct + '%';
    track.trimHandleRight.style.left = rightPct + '%';
    track.trimMaskLeft.style.width = leftPct + '%';
    track.trimMaskRight.style.width = (100 - rightPct) + '%';
    track.trimTimeEl.textContent = `${track.trimStart.toFixed(2)}s – ${track.trimEnd.toFixed(2)}s / ${dur.toFixed(2)}s`;
  }

  function wireTrimHandle(handle, track, isLeft) {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.dataset.dragging = '1';
    });
    handle.addEventListener('pointermove', (e) => {
      if (handle.dataset.dragging !== '1' || !track.buffer) return;
      const rect = track.trimWaveWrap.getBoundingClientRect();
      const relX = Math.min(rect.width, Math.max(0, e.clientX - rect.left));
      const t = (relX / rect.width) * track.buffer.duration;
      const minGap = Math.min(0.03, track.buffer.duration / 2);
      if (isLeft) track.trimStart = Math.max(0, Math.min(t, track.trimEnd - minGap));
      else track.trimEnd = Math.min(track.buffer.duration, Math.max(t, track.trimStart + minGap));
      updateTrimHandles(track);
    });
    const stopDrag = () => { handle.dataset.dragging = '0'; };
    handle.addEventListener('pointerup', stopDrag);
    handle.addEventListener('pointercancel', stopDrag);
    handle.addEventListener('lostpointercapture', stopDrag);
  }

  function openTrimEditor(track) {
    if (!track.buffer) return;
    track.trimStart = 0;
    track.trimEnd = track.buffer.duration;
    track.trimEditor.hidden = false;
    drawWaveform(track);
    updateTrimHandles(track);
  }

  function closeTrimEditor(track) {
    track.trimEditor.hidden = true;
  }

  function previewTrim(track) {
    if (!track.buffer) return;
    const source = state.ctx.createBufferSource();
    source.buffer = track.buffer;
    const g = state.ctx.createGain();
    source.connect(g);
    g.connect(track.panNode);
    source.start(state.ctx.currentTime, track.trimStart, Math.max(0.01, track.trimEnd - track.trimStart));
  }

  function applyTrimToLoop(track) {
    if (!track.buffer) return;
    const ctx = state.ctx;
    const L = state.loopLength;
    const trimmedDuration = Math.max(0.05, track.trimEnd - track.trimStart);
    const n = Math.max(1, Math.round(trimmedDuration / L));
    const exactLen = Math.max(1, Math.round(n * L * ctx.sampleRate));
    const newBuffer = ctx.createBuffer(track.buffer.numberOfChannels, exactLen, ctx.sampleRate);
    const startSample = Math.round(track.trimStart * track.buffer.sampleRate);
    for (let ch = 0; ch < track.buffer.numberOfChannels; ch++) {
      const src = track.buffer.getChannelData(ch);
      const dst = newBuffer.getChannelData(ch);
      const copyLen = Math.min(dst.length, Math.max(0, src.length - startSample));
      dst.set(src.subarray(startSample, startSample + copyLen));
    }
    track.buffer = newBuffer;
    track.n = n;
    track.startBoundary = nextBoundary(ctx.currentTime, state.epoch, L, false);
    closeTrimEditor(track);
    playTrack(track);
  }

  function startSampleVoice(sample, midi) {
    const ctx = state.ctx;
    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = sample.buffer;
    source.playbackRate.value = Math.pow(2, (midi - 60) / 12) * instMultiplier();
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(1, now + 0.005);
    source.connect(gain);
    gain.connect(state.instrumentBus);
    source.start(now);
    return { osc1: source, osc2: null, gain };
  }

  function addSampleVoiceButton(sample) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'voice-btn sample-voice-btn';
    btn.dataset.voice = sample.id;
    btn.innerHTML = `<span class="voice-name">${sample.name}</span><span class="voice-remove" title="삭제">✕</span>`;
    el.voiceSelect.appendChild(btn);
    KEYBOARD_DEFAULT_BASE_MIDI[sample.id] = 54;
  }

  function saveTrimAsSample(track) {
    if (!track.buffer) return;
    const ctx = state.ctx;
    const startSample = Math.round(track.trimStart * track.buffer.sampleRate);
    const endSample = Math.round(track.trimEnd * track.buffer.sampleRate);
    const len = Math.max(1, endSample - startSample);
    const newBuffer = ctx.createBuffer(track.buffer.numberOfChannels, len, track.buffer.sampleRate);
    for (let ch = 0; ch < track.buffer.numberOfChannels; ch++) {
      const src = track.buffer.getChannelData(ch);
      const dst = newBuffer.getChannelData(ch);
      dst.set(src.subarray(startSample, startSample + len));
    }
    state.sampleCounter += 1;
    const sample = { id: 'sample_' + state.sampleCounter, name: `샘플 ${state.sampleCounter}`, buffer: newBuffer, color: track.color };
    state.customSamples.push(sample);
    addSampleVoiceButton(sample);
    closeTrimEditor(track);
  }

  // ---- WAV encoding ----
  function audioBufferToWav(buffer) {
    const numCh = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const length = buffer.length * numCh * 2 + 44;
    const bufOut = new ArrayBuffer(length);
    const view = new DataView(bufOut);

    const writeStr = (offset, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + buffer.length * numCh * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numCh, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numCh * 2, true);
    view.setUint16(32, numCh * 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, buffer.length * numCh * 2, true);

    const channels = [];
    for (let ch = 0; ch < numCh; ch++) channels.push(buffer.getChannelData(ch));

    let offset = 44;
    for (let i = 0; i < buffer.length; i++) {
      for (let ch = 0; ch < numCh; ch++) {
        let sample = Math.max(-1, Math.min(1, channels[ch][i]));
        sample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        view.setInt16(offset, sample, true);
        offset += 2;
      }
    }
    return new Blob([bufOut], { type: 'audio/wav' });
  }

  // ---- Transport ----
  function playAll() {
    state.tracks.forEach((t) => {
      if (t.buffer && t.state === 'stopped') playTrack(t);
    });
  }

  function stopAll() {
    state.tracks.forEach((t) => {
      if (t.state === 'playing') {
        stopTrackSource(t);
        t.state = 'stopped';
        updateTrackUI(t);
      }
    });
  }

  // ---- Animation loop (playhead, meters, progress) ----
  function animate() {
    if (state.started) {
      const now = state.ctx.currentTime;
      const L = state.loopLength;
      const phase = (((now - state.epoch) % L) + L) % L;
      el.playheadFill.style.width = (phase / L) * 100 + '%';
      const loopIndex = Math.max(0, Math.floor((now - state.epoch) / L));
      el.loopCounter.textContent = 'Loop ' + (loopIndex + 1);

      if (state.micAnalyser) {
        state.micAnalyser.getByteTimeDomainData(state.meterBuf);
        let sumSq = 0;
        for (let i = 0; i < state.meterBuf.length; i++) {
          const v = (state.meterBuf[i] - 128) / 128;
          sumSq += v * v;
        }
        const rms = Math.sqrt(sumSq / state.meterBuf.length);
        el.micMeterFill.style.width = Math.min(100, rms * 260) + '%';
      }

      state.tracks.forEach((t) => {
        if (t.state === 'playing' && t.buffer) {
          const cyc = t.n * L;
          const tp = (((now - t.startBoundary) % cyc) + cyc) % cyc;
          t.progressFillEl.style.width = ((tp % L) / L) * 100 + '%';
        } else if (t.state === 'recording') {
          const tp = (((now - t.recordStartBoundary) % L) + L) % L;
          t.progressFillEl.style.width = (tp / L) * 100 + '%';
        } else if (t.state !== 'playing') {
          t.progressFillEl.style.width = '0%';
        }
      });

      state.activeVoices.forEach((rec, pointerId) => {
        if (performance.now() - rec.startedAt > 10000) releaseVoiceForPointer(pointerId);
      });

      if (!el.mixerPanel.hidden) {
        state.tracks.forEach((t) => {
          if (t.mixerMeterFill) t.mixerMeterFill.style.height = Math.min(100, meterLevel(t.meter) * 260) + '%';
        });
        if (state.metronomeMeter && state.metronomeMixerMeterFill) {
          state.metronomeMixerMeterFill.style.height = Math.min(100, meterLevel(state.metronomeMeter) * 260) + '%';
        }
        if (state.instMeter && state.instMixerMeterFill) {
          state.instMixerMeterFill.style.height = Math.min(100, meterLevel(state.instMeter) * 260) + '%';
        }
        if (state.masterMeter && state.masterMixerMeterFill) {
          state.masterMixerMeterFill.style.height = Math.min(100, meterLevel(state.masterMeter) * 260) + '%';
        }
      }
    }
    state.rafId = requestAnimationFrame(animate);
  }

  // ---- Session lifecycle ----
  async function startSession() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('이 브라우저는 마이크 접근(getUserMedia)을 지원하지 않습니다.');
      return;
    }
    el.startSessionBtn.disabled = true;
    try {
      state.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (err) {
      alert('마이크 접근에 실패했습니다: ' + err.message);
      el.startSessionBtn.disabled = false;
      return;
    }

    const AC = window.AudioContext || window.webkitAudioContext;
    state.ctx = new AC();
    await state.ctx.resume();

    state.micSource = state.ctx.createMediaStreamSource(state.micStream);
    state.micAnalyser = state.ctx.createAnalyser();
    state.micAnalyser.fftSize = 512;
    state.meterBuf = new Uint8Array(state.micAnalyser.fftSize);
    state.micSource.connect(state.micAnalyser);

    state.masterGain = state.ctx.createGain();
    state.masterGain.gain.value = 1;
    state.masterGain.connect(state.ctx.destination);

    state.metronomeGain = state.ctx.createGain();
    state.metronomeGain.gain.value = state.metronomeVolume;
    state.metronomeGain.connect(state.masterGain);

    state.instrumentBus = state.ctx.createGain();
    state.instrumentBus.gain.value = state.instVolume;
    state.instPanner = state.ctx.createStereoPanner();
    state.instPanner.pan.value = state.instPan;
    state.instrumentBus.connect(state.instPanner);
    state.instPanner.connect(state.masterGain);
    state.noiseBuffer = null;
    state.activeVoices = new Map();
    state.soloSet = new Set();

    state.metronomeMeter = attachMeter(state.metronomeGain);
    state.instMeter = attachMeter(state.instrumentBus);
    state.masterMeter = attachMeter(state.masterGain);

    state.bpm = Math.max(1, parseInt(el.bpmInput.value, 10) || 100);
    state.beatsPerLoop = Math.max(1, parseInt(el.beatsInput.value, 10) || 8);
    state.loopLength = (state.beatsPerLoop * 60) / state.bpm;
    state.epoch = state.ctx.currentTime + 0.15;
    state.nextBeatTime = state.epoch;
    state.beatIndex = 0;
    state.started = true;

    buildTracks();
    buildDrumPads();
    renderKeyboard();
    buildMixer();

    el.bpmInput.disabled = true;
    el.beatsInput.disabled = true;
    el.tapTempoBtn.disabled = true;
    el.startSessionBtn.hidden = true;
    el.resetSessionBtn.hidden = false;
    el.transport.hidden = false;
    el.tracksGrid.hidden = false;
    el.instrumentsPanel.hidden = false;
    el.setupHint.textContent = `세션 진행 중 — BPM ${state.bpm}, 루프 길이 ${state.loopLength.toFixed(2)}초. 트랙 버튼으로 녹음을 시작하세요.`;

    state.schedulerTimer = setInterval(schedulerTick, SCHEDULER_INTERVAL_MS);
    animate();
  }

  function resetSession() {
    if (state.schedulerTimer) clearInterval(state.schedulerTimer);
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.tracks.forEach((t) => {
      clearTimeout(t.armTimeoutId);
      clearTimeout(t.stopTimeoutId);
      if (t.mediaRecorder && t.mediaRecorder.state === 'recording') {
        try { t.mediaRecorder.stop(); } catch (e) { /* noop */ }
      }
      stopTrackSource(t);
    });
    state.activeVoices.forEach((rec) => { try { rec.voice.gain.disconnect(); } catch (e) { /* noop */ } });
    state.activeVoices.clear();
    if (state.micStream) state.micStream.getTracks().forEach((tr) => tr.stop());
    if (state.ctx) state.ctx.close();

    state.ctx = null;
    state.micStream = null;
    state.micSource = null;
    state.micAnalyser = null;
    state.masterGain = null;
    state.metronomeGain = null;
    state.instrumentBus = null;
    state.instPanner = null;
    state.noiseBuffer = null;
    state.started = false;
    state.tracks = [];
    state.soloSet = new Set();
    state.mixerChannels = [];
    state.metronomeMeter = null;
    state.instMeter = null;
    state.masterMeter = null;
    state.metronomeMixerMeterFill = null;
    state.instMixerMeterFill = null;
    state.masterMixerMeterFill = null;
    state.metronomeVolume = 0.4;
    state.metronomeMuted = false;
    state.instVolume = 1;
    state.instPan = 0;
    state.instMuted = false;

    el.tracksGrid.innerHTML = '';
    el.tracksGrid.hidden = true;
    el.transport.hidden = true;
    el.instrumentsPanel.hidden = true;
    el.mixerPanel.hidden = true;
    el.mixerStrips.innerHTML = '';
    el.mixerToggleBtn.classList.remove('active');
    el.drumKit.innerHTML = '';
    el.pianoKeys.querySelectorAll('.piano-white-row, .piano-black-row').forEach((r) => { r.innerHTML = ''; });
    el.voiceSelect.querySelectorAll('.sample-voice-btn').forEach((b) => b.remove());
    state.customSamples = [];
    state.sampleCounter = 0;
    state.keyboardVoice = 'epiano';
    state.keyboardBaseMidi = 60;
    el.voiceSelect.querySelectorAll('.voice-btn').forEach((b) => b.classList.toggle('active', b.dataset.voice === 'epiano'));
    el.instTabs.querySelectorAll('.inst-tab').forEach((b) => b.classList.toggle('active', b.dataset.cat === 'drums'));
    el.instrumentsPanel.querySelectorAll('.inst-view').forEach((v) => { v.hidden = v.dataset.cat !== 'drums'; });
    el.bpmInput.disabled = false;
    el.beatsInput.disabled = false;
    el.tapTempoBtn.disabled = false;
    el.startSessionBtn.hidden = false;
    el.startSessionBtn.disabled = false;
    el.resetSessionBtn.hidden = true;
    el.setupHint.textContent = '마이크 사용을 위해 HTTPS 또는 localhost 환경이 필요합니다. "세션 시작"을 누르면 BPM/박자 수가 고정됩니다.';
    el.playheadFill.style.width = '0%';
    el.loopCounter.textContent = 'Loop 0';
    el.micMeterFill.style.width = '0%';
    state.instSpeed = 1;
    state.instPitchSemis = 0;
    el.instSpeed.value = 1;
    el.instPitch.value = 0;
    el.instSpeedVal.textContent = '1.00x';
    el.instPitchVal.textContent = '0st';
  }

  function wireTransport() {
    el.startSessionBtn.addEventListener('click', startSession);
    el.resetSessionBtn.addEventListener('click', resetSession);
    el.playAllBtn.addEventListener('click', playAll);
    el.stopAllBtn.addEventListener('click', stopAll);
    el.metronomeToggle.addEventListener('change', () => {
      state.metronomeOn = el.metronomeToggle.checked;
    });
    el.mixerToggleBtn.addEventListener('click', () => {
      el.mixerPanel.hidden = !el.mixerPanel.hidden;
      el.mixerToggleBtn.classList.toggle('active', !el.mixerPanel.hidden);
    });
  }

  function wireKeyboard() {
    document.addEventListener('keydown', (e) => {
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (!state.started) return;
      if (e.key >= '1' && e.key <= '6') {
        const idx = parseInt(e.key, 10) - 1;
        if (state.tracks[idx]) onRecordClick(state.tracks[idx]);
      } else if (e.code === 'Space') {
        e.preventDefault();
        const anyPlaying = state.tracks.some((t) => t.state === 'playing');
        if (anyPlaying) stopAll();
        else playAll();
      }
    });
  }

  window.addEventListener('beforeunload', () => {
    if (state.micStream) state.micStream.getTracks().forEach((t) => t.stop());
  });

  // A long press on a pad/key would otherwise pop up the browser's
  // text-selection or link/context menu instead of just playing the sound.
  document.addEventListener('contextmenu', (e) => {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    e.preventDefault();
  });

  updateLoopLengthDisplay();
  wireStepper();
  wireTapTempo();
  wireTransport();
  wireInstrumentControls();
  wireInstrumentTabs();
  wireKeyboardControls();
  wireKeyboard();
})();
