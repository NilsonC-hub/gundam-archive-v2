// Playback of locally stored recordings. No generated noise, oscillators or pitch effects.
export function createCombatAudio({ onState = () => {} } = {}) {
  let context, master, manifest, loading, muted = false, error = null;
  const encoded = new Map();
  const buffers = new Map();
  const voices = new Set();
  const events = [];

  async function preload() {
    if (loading) return loading;
    loading = (async () => {
      const response = await fetch('/audio/sources.json', { signal: AbortSignal.timeout(6000) });
      if (!response.ok) throw new Error('Audio manifest could not be loaded');
      manifest = await response.json();
      await Promise.all(['shot', 'impact', 'shatter'].map(async name => {
        if (!manifest[name]?.url) return;
        const file = await fetch(manifest[name].url, { signal: AbortSignal.timeout(6000) });
        if (!file.ok) throw new Error(`Audio file could not be loaded: ${name}`);
        encoded.set(name, await file.arrayBuffer());
      }));
      error = null;
    })().catch(reason => {
      error = reason.message;
      loading = null;
      onState('error');
      return false;
    });
    return loading;
  }

  async function unlock() {
    try {
      // Resume inside the click gesture, before waiting for any network requests.
      context ||= new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      if (!master) {
        master = context.createGain();
        master.gain.value = muted ? 0 : 0.7;
        master.connect(context.destination);
      }
      const resume = context.state === 'suspended' ? context.resume() : Promise.resolve();
      const [, loaded] = await Promise.all([resume, preload()]);
      if (loaded === false) return false;
      error = null;
      await Promise.all([...encoded].map(async ([name, bytes]) => {
        if (!buffers.has(name)) buffers.set(name, await context.decodeAudioData(bytes.slice(0)));
      }));
      onState(muted ? 'muted' : 'ready');
      return context.state === 'running';
    } catch (reason) {
      error = reason.message;
      loading = null;
      encoded.clear();
      onState('error');
      return false;
    }
  }

  function play(name, { index } = {}) {
    const buffer = buffers.get(name);
    if (!buffer || !context || context.state !== 'running' || muted) return false;
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    gain.gain.value = Math.max(0, Math.min(1, manifest[name].volume ?? 0.7));
    source.connect(gain);
    gain.connect(master);
    const voice = { source, gain };
    voices.add(voice);
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
      voices.delete(voice);
    };
    source.start(0, manifest[name].offset ?? 0);
    events.push({ name, index, time: context.currentTime });
    if (events.length > 32) events.shift();
    return true;
  }

  function stop() {
    for (const voice of voices) {
      try { voice.source.stop(); } catch { /* Already ended during a tab change. */ }
    }
    voices.clear();
    events.length = 0;
  }

  function setMuted(value) {
    muted = Boolean(value);
    if (master) master.gain.setTargetAtTime(muted ? 0 : 0.7, context.currentTime, 0.012);
    onState(muted ? 'muted' : error ? 'error' : 'ready');
  }

  preload();
  return {
    unlock, play, stop, setMuted,
    get muted() { return muted; },
    get state() {
      return { context: context?.state ?? 'locked', muted, error,
        loaded: [...buffers.keys()], activeVoices: voices.size,
        events: events.map(event => ({ ...event })) };
    },
    dispose() { stop(); context?.close(); },
  };
}
