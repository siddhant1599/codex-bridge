// Microphone access starts only after a click. Audio goes to this bridge on this Mac.
window.BridgeVoiceInput = class {
  constructor({ button, cancelButton, status, onText, onState, onError }) {
    Object.assign(this, { button, cancelButton, status, onText, onState, onError });
    this.session = null;
    this.settings = {};
    button.addEventListener('click', () => this.session?.recorder?.state === 'recording' ? this.finish() : this.start());
    cancelButton.addEventListener('click', () => this.cancel());
    window.addEventListener('pagehide', () => this.cancel());
  }
  get active() { return Boolean(this.session); }
  update(settings = {}, available) {
    this.settings = settings;
    this.available = available;
    const supported = Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
    this.button.disabled = this.active ? this.session.phase !== 'recording' : !available || !settings.enabled || settings.busy || !supported;
    this.button.textContent = this.session?.phase === 'recording' ? 'Finish recording' : 'Record voice';
    this.button.setAttribute('aria-pressed', String(this.session?.phase === 'recording'));
    this.cancelButton.hidden = !this.active;
    if (!this.active) {
      this.status.textContent = !supported ? 'Microphone recording needs a supported browser on localhost or HTTPS.' : settings.reason || 'Record up to two minutes, review the transcript, then send.';
    }
  }
  release(session) {
    clearInterval(session.timer);
    for (const track of session.stream?.getTracks() || []) track.stop();
  }
  cancel() {
    const session = this.session;
    if (!session) return;
    this.session = null;
    session.controller.abort();
    if (session.recorder?.state === 'recording') session.recorder.stop();
    this.release(session);
    this.onState();
  }
  finish() {
    const session = this.session;
    if (session?.recorder?.state !== 'recording') return;
    session.phase = 'transcribing';
    session.recorder.stop();
    this.release(session);
    this.status.textContent = 'Transcribing on this Mac… You can cancel while you wait.';
    this.onState();
  }
  fail(error) {
    this.cancel();
    const messages = {
      NotAllowedError: 'Microphone access was denied. Allow microphone access for this dashboard in your browser settings.',
      NotFoundError: 'No microphone was found. Connect a microphone and try again.',
      NotReadableError: 'The microphone is unavailable. Check whether another app is using it.',
      TimeoutError: 'Transcription took too long. Try a shorter recording.',
    };
    this.onError(messages[error.name] || (error instanceof TypeError ? 'Could not reach the bridge. Check the connection and try again.' : error.message));
  }
  async start() {
    if (this.active || this.button.disabled) return;
    const session = { phase: 'permission', controller: new AbortController(), parts: [], bytes: 0 };
    this.session = session;
    this.status.textContent = 'Waiting for microphone permission…';
    this.onState();
    try {
      session.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (this.session !== session) { this.release(session); return; }
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error('This browser cannot record a supported audio format. Try Chrome, Safari, or Firefox.');
      session.recorder = new MediaRecorder(session.stream, { mimeType });
      session.recorder.addEventListener('dataavailable', event => {
        if (this.session !== session || !event.data.size) return;
        session.bytes += event.data.size;
        if (session.bytes > (this.settings.maxBytes || 10 * 1024 * 1024)) { this.fail(new Error('The recording is too large. Please record a shorter message.')); return; }
        session.parts.push(event.data);
      });
      session.recorder.addEventListener('error', () => { if (this.session === session) this.fail(new Error('Recording failed. Check your microphone and try again.')); });
      session.recorder.addEventListener('stop', () => { if (this.session === session) this.upload(session); });
      session.recorder.start(1000);
      session.phase = 'recording';
      const started = Date.now();
      const tick = () => {
        const seconds = Math.floor((Date.now() - started) / 1000);
        this.status.textContent = `Recording ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} · Click Finish recording when done.`;
        if (seconds >= (this.settings.maxSeconds || 120) - 1) this.finish();
      };
      session.timer = setInterval(tick, 250);
      tick();
      this.onState();
    } catch (error) { if (this.session === session) this.fail(error); }
  }
  async upload(session) {
    this.release(session);
    session.phase = 'transcribing';
    this.status.textContent = 'Transcribing on this Mac… You can cancel while you wait.';
    this.onState();
    try {
      const blob = new Blob(session.parts, { type: session.recorder.mimeType });
      session.parts = [];
      if (!blob.size) throw new Error('The recording is empty. Please try again.');
      const response = await fetch('/api/transcribe', { method: 'POST', body: blob,
        headers: { 'Content-Type': blob.type, 'X-Bridge-Request': '1' },
        signal: AbortSignal.any([session.controller.signal, AbortSignal.timeout((this.settings.timeoutMs || 300000) + 15000)]),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not transcribe this recording.');
      if (this.session !== session) return;
      this.session = null;
      this.onText(result.text);
      this.onState();
      this.status.textContent = 'Transcript ready. Review your message, then click Send.';
    } catch (error) { if (this.session === session) this.fail(error); }
  }
};
