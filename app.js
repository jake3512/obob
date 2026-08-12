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
    metronomeVol: $('metronomeVol'),
    masterVol: $('masterVol'),
    micMeterFill: $('micMeterFill'),
    tracksGrid: $('tracksGrid'),
    trackTemplate: $('trackTemplate'),
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
      volInput: card.querySelector('.track-vol'),
      gainNode: state.ctx.createGain(),
      state: 'empty',
      buffer: null,
      n: 0,
      startBoundary: 0,
      recordStartBoundary: 0,
      mediaRecorder: null,
      chunks: [],
      sourceNode: null,
      pendingOverdub: false,
      overdubMixDest: null,
      isMuted: false,
      armTimeoutId: null,
      stopTimeoutId: null,
    };

    track.nameEl.textContent = track.name;
    track.gainNode.gain.value = parseFloat(track.volInput.value);
    track.gainNode.connect(state.masterGain);

    track.recordBtn.addEventListener('click', () => onRecordClick(track));
    track.playBtn.addEventListener('click', () => onPlayClick(track));
    track.muteBtn.addEventListener('click', () => onMuteClick(track));
    track.clearBtn.addEventListener('click', () => onClearClick(track));
    track.downloadBtn.addEventListener('click', () => onDownloadClick(track));
    track.volInput.addEventListener('input', () => {
      if (!track.isMuted) track.gainNode.gain.value = parseFloat(track.volInput.value);
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

    track.clearBtn.disabled = track.state === 'empty';
    track.downloadBtn.disabled = !hasBuffer;
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

    let streamToRecord;
    if (track.pendingOverdub && track.buffer && track.sourceNode) {
      const mixDest = state.ctx.createMediaStreamDestination();
      state.micSource.connect(mixDest);
      track.sourceNode.connect(mixDest);
      track.overdubMixDest = mixDest;
      streamToRecord = mixDest.stream;
    } else {
      streamToRecord = state.micStream;
    }

    const mimeType = pickMimeType();
    try {
      track.mediaRecorder = mimeType
        ? new MediaRecorder(streamToRecord, { mimeType })
        : new MediaRecorder(streamToRecord);
    } catch (err) {
      console.error('MediaRecorder init failed', err);
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
    if (track.overdubMixDest) {
      try { track.sourceNode && track.sourceNode.disconnect(track.overdubMixDest); } catch (e) { /* noop */ }
      try { state.micSource.disconnect(track.overdubMixDest); } catch (e) { /* noop */ }
      track.overdubMixDest = null;
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
    track.gainNode.gain.value = track.isMuted ? 0 : parseFloat(track.volInput.value);
    updateTrackUI(track);
  }

  function onClearClick(track) {
    clearTimeout(track.armTimeoutId);
    clearTimeout(track.stopTimeoutId);
    if (track.mediaRecorder && track.mediaRecorder.state === 'recording') {
      try { track.mediaRecorder.stop(); } catch (e) { /* noop */ }
    }
    if (track.overdubMixDest) {
      try { track.sourceNode && track.sourceNode.disconnect(track.overdubMixDest); } catch (e) { /* noop */ }
      try { state.micSource.disconnect(track.overdubMixDest); } catch (e) { /* noop */ }
      track.overdubMixDest = null;
    }
    stopTrackSource(track);
    track.buffer = null;
    track.n = 0;
    track.chunks = [];
    track.state = 'empty';
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
    state.masterGain.gain.value = parseFloat(el.masterVol.value);
    state.masterGain.connect(state.ctx.destination);

    state.metronomeGain = state.ctx.createGain();
    state.metronomeGain.gain.value = parseFloat(el.metronomeVol.value);
    state.metronomeGain.connect(state.masterGain);

    state.bpm = Math.max(1, parseInt(el.bpmInput.value, 10) || 100);
    state.beatsPerLoop = Math.max(1, parseInt(el.beatsInput.value, 10) || 8);
    state.loopLength = (state.beatsPerLoop * 60) / state.bpm;
    state.epoch = state.ctx.currentTime + 0.15;
    state.nextBeatTime = state.epoch;
    state.beatIndex = 0;
    state.started = true;

    buildTracks();

    el.bpmInput.disabled = true;
    el.beatsInput.disabled = true;
    el.tapTempoBtn.disabled = true;
    el.startSessionBtn.hidden = true;
    el.resetSessionBtn.hidden = false;
    el.transport.hidden = false;
    el.tracksGrid.hidden = false;
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
    if (state.micStream) state.micStream.getTracks().forEach((tr) => tr.stop());
    if (state.ctx) state.ctx.close();

    state.ctx = null;
    state.micStream = null;
    state.micSource = null;
    state.micAnalyser = null;
    state.masterGain = null;
    state.metronomeGain = null;
    state.started = false;
    state.tracks = [];

    el.tracksGrid.innerHTML = '';
    el.tracksGrid.hidden = true;
    el.transport.hidden = true;
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
  }

  function wireTransport() {
    el.startSessionBtn.addEventListener('click', startSession);
    el.resetSessionBtn.addEventListener('click', resetSession);
    el.playAllBtn.addEventListener('click', playAll);
    el.stopAllBtn.addEventListener('click', stopAll);
    el.metronomeToggle.addEventListener('change', () => {
      state.metronomeOn = el.metronomeToggle.checked;
    });
    el.metronomeVol.addEventListener('input', () => {
      if (state.metronomeGain) state.metronomeGain.gain.value = parseFloat(el.metronomeVol.value);
    });
    el.masterVol.addEventListener('input', () => {
      if (state.masterGain) state.masterGain.gain.value = parseFloat(el.masterVol.value);
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

  updateLoopLengthDisplay();
  wireStepper();
  wireTapTempo();
  wireTransport();
  wireKeyboard();
})();
